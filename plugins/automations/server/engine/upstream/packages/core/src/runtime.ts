import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import chokidar, { type FSWatcher } from "chokidar";
import type {
  AgentResult, EffectiveWorkspace, Event, EventEmitResult, EventSourceHealth, Extension, HookContext, JsonValue,
  InputResult, OperationContext, Logger, MixerAutomationsAPI, Run, RunStatus, Workflow, Workspace, WorkspaceAttestation,
} from "@mixer/automations-sdk";
import { extensionConfig, extensionEnabled, loadConfig, type Config } from "./config.js";
import { eventCandidateSchema, eventMatchSchema } from "@mixer/automations-sdk";
import { StateDatabase, type DeferredRouteRecord, type EventDecision, type RunLease } from "./database.js";
import { createExtensionTsconfig, discoverExtensionFiles, importExtension, type LoadedExtension } from "./extensions.js";
import { createLogger } from "./logger.js";
import { ensureHome, resolvePaths } from "./paths.js";
import { CoreProcessAPI } from "./process.js";
import { Registry } from "./registry.js";
import { SafeActionGate, actionRequestSchema } from "./actions.js";
import {
  discoverWorkflows, resolveWorkflow, validateWorkflow, workflowAllowsRepository, workflowRepositories, type WorkflowError,
} from "./workflows.js";

const POLL_MS = 25;
const LEASE_MS = 60_000;

function randomId(prefix: string): string {
  return `${prefix}_${randomBytes(6).toString("hex")}`;
}

function snapshotHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function agentPrompt(prompt: string, event: Event, actions: readonly import("@mixer/automations-sdk").SafeActionTool[]): string {
  const actionInstructions = actions.length ? [
    "", "This workflow permits the following Safe Actions. They are proposals only and execute after you exit:",
    ...actions.map((action) => `${action.name}: ${action.description ?? "No description."}\nInput schema: ${JSON.stringify(action.inputSchema)}`),
    "Request an action only in the final MIXER_AUTOMATIONS_RESULT actions array using {\"name\":\"<action>\",\"input\":{...}}. Never claim that a requested action succeeded; Mixer Automations validates live state and records the result after you exit.",
  ] : ["", "This workflow declares no Safe Actions. The final MIXER_AUTOMATIONS_RESULT must use \"actions\":[]; do not list ordinary GitHub, git, file, or command operations as actions."];
  const resultExample = actions.length
    ? '{"version":1,"outcome":"acted|no-op|blocked|failed","reason":"optional","actions":[{"name":"one.of.the.safe.actions.listed.above","input":{}}],"verification":[],"unresolved":[],"references":[]}'
    : '{"version":1,"outcome":"acted|no-op|blocked|failed","reason":"optional","actions":[],"verification":[],"unresolved":[],"references":[]}';
  return [
    prompt, "", "This prompt was triggered automatically.", `Event: ${event.type}`,
    `Repository: ${event.repository ?? "not specified"}`,
    `Actor: ${event.actor?.name ?? event.actor?.id ?? "not specified"}`,
    `Event time: ${event.timestamp}`, "Event data:", JSON.stringify(event.data, null, 2), "",
    ...actionInstructions,
    "End your response with exactly one line beginning MIXER_AUTOMATIONS_RESULT: followed by JSON.",
    `Use: ${resultExample}`,
  ].join("\n");
}

function validateInitialWorkspace(workspace: Workspace, attestation: WorkspaceAttestation, expectedRepository?: string, expectedRevision?: string): void {
  const canonical = (value: string): string => fs.existsSync(value) ? fs.realpathSync(value) : path.resolve(value);
  if (canonical(attestation.path) !== canonical(workspace.path)) throw new Error("Workspace attestation path does not match the effective checkout");
  if (!attestation.clean) throw new Error("Workspace attestation rejected a dirty initial checkout");
  if (attestation.kind !== "directory") {
    if (expectedRepository && attestation.repository !== expectedRepository) throw new Error("Workspace attestation repository does not match the activated repository");
    if (expectedRevision && attestation.revision !== expectedRevision) throw new Error("Workspace attestation revision does not match the activated revision");
  }
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function normalizeAgentResult(value: unknown, mode: Config["runtime"]["mode"]): AgentResult {
  if (value && typeof value === "object") {
    const result = value as Record<string, unknown>;
    const valid = result.version === 1
      && ["acted", "no-op", "blocked", "failed"].includes(String(result.outcome))
      && (result.output === undefined || typeof result.output === "string")
      && (result.reason === undefined || typeof result.reason === "string")
      && (result.verification === undefined || isStringArray(result.verification))
      && (result.unresolved === undefined || isStringArray(result.unresolved))
      && (result.references === undefined || isStringArray(result.references))
      && (result.actions === undefined || (Array.isArray(result.actions) && result.actions.every((item) => item && typeof item === "object"
        && typeof (item as { name?: unknown }).name === "string"
        && ((item as { reference?: unknown }).reference === undefined || typeof (item as { reference?: unknown }).reference === "string")
        && ((item as { input?: unknown }).input === undefined || (() => { try { JSON.stringify((item as { input: unknown }).input); return true; } catch { return false; } })()))));
    if (valid) {
      try { JSON.stringify(value); return value as AgentResult; }
      catch {}
    }
  }
  const legacyOutput = value && typeof value === "object" && typeof (value as { output?: unknown }).output === "string"
    ? (value as { output: string }).output
    : undefined;
  let invalidReport = false;
  if (legacyOutput) {
    const lines = legacyOutput.match(/^MIXER_AUTOMATIONS_RESULT:\s*(\{.*\})\s*$/gm);
    const encoded = lines?.at(-1)?.replace(/^MIXER_AUTOMATIONS_RESULT:\s*/, "");
    if (encoded) {
      try {
        const parsed = JSON.parse(encoded) as unknown;
        const normalized = normalizeAgentResult(parsed, "unsafe-direct");
        if (normalized.reason !== "legacy_agent_result") return { ...normalized, output: legacyOutput };
        invalidReport = true;
      } catch { invalidReport = true; }
    }
  }
  const legacy = value && typeof value === "object" ? value as { output?: unknown; metadata?: unknown } : undefined;
  const output = typeof legacy?.output === "string" ? legacy.output : undefined;
  if (mode === "managed") return {
    version: 1,
    outcome: "unknown",
    ...(output === undefined ? {} : { output }),
    reason: invalidReport ? "report_invalid" : "report_missing",
  };
  return {
    version: 1,
    outcome: output?.trim() ? "acted" : "no-op",
    ...(output === undefined ? {} : { output }),
    ...(legacy?.metadata === undefined ? {} : { metadata: legacy.metadata as JsonValue }),
    reason: "legacy_agent_result",
  };
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("Run aborted");
}

export interface RuntimeOptions {
  home?: string;
  dryRun?: boolean;
  consoleLogs?: boolean;
  builtins?: Array<{ extension: Extension; path?: string }>;
  cli?: { command: string; args: readonly string[] };
}

interface ActiveRun {
  controller: AbortController;
  promise: Promise<void>;
}

export class Runtime {
  readonly paths;
  config: Config;
  readonly database: StateDatabase;
  readonly registry = new Registry();
  readonly logger: Logger;
  readonly extensions: LoadedExtension[] = [];
  workflows: Workflow[] = [];
  workflowErrors: WorkflowError[] = [];
  private readonly processApi = new CoreProcessAPI();
  private readonly safeActionGate: SafeActionGate;
  private readonly shutdown = new AbortController();
  private readonly leaseOwner = randomId("worker");
  private readonly activeRuns = new Map<string, ActiveRun>();
  private readonly submissionContexts = new Map<string, { lease: RunLease; stepId: string; attempt: number; controller: AbortController }>();
  private readonly routingEvents = new Map<string, Promise<EventEmitResult>>();
  private readonly sourceStarts = new Map<string, { failures: number; nextAttemptAt: number }>();
  private readonly sourceControllers = new Map<string, AbortController>();
  private watcher?: FSWatcher;
  private pollTimer?: NodeJS.Timeout;
  private historyTimer?: NodeJS.Timeout;
  private reconciliationTimer?: NodeJS.Timeout;
  private reconciliation?: Promise<void>;
  private dispatching = false;
  private initialized = false;
  private started = false;
  private stopping = false;
  private stopPromise?: Promise<void>;

  constructor(private readonly options: RuntimeOptions = {}) {
    this.paths = resolvePaths(options.home);
    ensureHome(this.paths);
    this.config = loadConfig(this.paths);
    this.database = new StateDatabase(this.paths.state);
    this.safeActionGate = new SafeActionGate(this.registry, this.database, options.dryRun ?? false);
    this.logger = createLogger(this.paths, { console: options.consoleLogs });
  }

  private apiFor(extension: Extension): MixerAutomationsAPI {
    const logger = this.logger.child({ extension: extension.name });
    return {
      events: this.registry.events, workflows: this.registry.workflows, actions: this.registry.actions, agents: this.registry.agents,
      inputs: {
        register: (name, handler) => this.registry.registerInput(name, handler),
        validate: (name, config) => { this.inputHandler(name).handler.configSchema.parse(config); },
        submit: (name, input, config, operation) => this.submitInput(name, input, config, operation),
      },
      workspaces: this.registry.workspaces, executions: this.registry.executions, hooks: this.registry.hooks,
      commands: this.registry.commands, config: {
        get: () => extensionConfig(this.config, extension.name),
        historyRetentionMs: () => this.config.history.retention,
      },
      state: { namespace: (name) => this.database.state(name ? `${extension.name}:${name}` : extension.name) },
      process: this.processApi, logger, paths: this.paths,
    };
  }

  private async setupExtension(extension: Extension, extensionPath: string): Promise<LoadedExtension> {
    if (this.extensions.some((loaded) => loaded.extension.name === extension.name && !loaded.error)) throw new Error(`Duplicate extension: ${extension.name}`);
    const loaded: LoadedExtension = { extension, path: extensionPath, enabled: extensionEnabled(this.config, extension.name) };
    this.extensions.push(loaded);
    if (!loaded.enabled) return loaded;
    try {
      this.registry.setOwner(extension.name);
      await extension.setup(this.apiFor(extension));
    } catch (error) {
      this.registry.removeOwner(extension.name);
      loaded.error = error instanceof Error ? error : new Error(String(error));
      this.logger.error({ extension: extension.name, error: loaded.error.message }, "Extension setup failed");
    }
    return loaded;
  }

  async loadExtensions(): Promise<void> {
    for (const builtin of this.options.builtins ?? []) await this.setupExtension(builtin.extension, builtin.path ?? `builtin:${builtin.extension.name}`);
    const extensionTsconfig = createExtensionTsconfig(this.paths.state);
    for (const file of discoverExtensionFiles(this.paths.extensions)) {
      try { await this.setupExtension(await importExtension(file, extensionTsconfig), file); }
      catch (error) {
        const failure = error instanceof Error ? error : new Error(String(error));
        this.extensions.push({ extension: { name: path.basename(file), setup() {} }, path: file, enabled: true, error: failure });
        this.logger.error({ path: file, error: failure.message }, "Extension load failed");
      }
    }
  }

  private async deactivateExtension(loaded: LoadedExtension): Promise<void> {
    this.registry.retireInputs(loaded.extension.name);
    const capabilities = this.registry.capabilities.get(loaded.extension.name);
    for (const type of capabilities?.events ?? []) {
      this.sourceControllers.get(type)?.abort(new Error("Event source retired"));
      this.sourceControllers.delete(type);
    }
    const sources = new Set((capabilities?.events ?? []).map((name) => this.registry.eventSources.get(name)).filter(Boolean));
    for (const source of sources) await source!.stop?.();
    if (!loaded.error) await loaded.extension.stop?.();
    this.registry.removeOwner(loaded.extension.name);
    for (const type of capabilities?.events ?? []) this.sourceStarts.delete(type);
  }

  async reloadExtension(name: string): Promise<LoadedExtension> {
    if (this.activeRuns.size) throw new Error("Cannot reload extensions while runs are active");
    this.config = loadConfig(this.paths);
    let loaded = this.extensions.find((item) => item.extension.name === name);
    if (!loaded) {
      const builtin = (this.options.builtins ?? []).find((item) => item.extension.name === name);
      if (builtin) loaded = { extension: builtin.extension, path: builtin.path ?? `builtin:${name}`, enabled: false };
      else {
        const tsconfig = createExtensionTsconfig(this.paths.state);
        const files = discoverExtensionFiles(this.paths.extensions).sort((left, right) => {
          const matches = (file: string) => path.basename(file, path.extname(file)) === name || path.basename(path.dirname(file)) === name;
          return Number(matches(right)) - Number(matches(left));
        });
        for (const file of files) {
          try {
            const candidate = await importExtension(file, tsconfig);
            if (candidate.name === name) { loaded = { extension: candidate, path: file, enabled: false }; break; }
          } catch (error) {
            if (path.basename(file, path.extname(file)) === name || path.basename(path.dirname(file)) === name) throw error;
          }
        }
      }
      if (!loaded) throw new Error(`Extension not found: ${name}`);
      this.extensions.push(loaded);
    }

    await this.deactivateExtension(loaded);
    const index = this.extensions.indexOf(loaded);
    let extension = loaded.extension;
    if (!loaded.path.startsWith("builtin:")) extension = await importExtension(loaded.path, createExtensionTsconfig(this.paths.state));
    this.extensions.splice(index, 1);
    const replacement = await this.setupExtension(extension, loaded.path);
    if (replacement.error) throw replacement.error;
    if (this.started && replacement.enabled) {
      await replacement.extension.start?.({ signal: this.shutdown.signal, logger: this.logger.child({ extension: replacement.extension.name }) });
      const capabilities = this.registry.capabilities.get(replacement.extension.name);
      for (const type of capabilities?.events ?? []) await this.startSource(type);
    }
    this.reloadWorkflows();
    return replacement;
  }

  reloadWorkflows(): void {
    const result = discoverWorkflows(this.paths.workflows, this.registry);
    this.workflows = result.workflows;
    this.workflowErrors = result.errors;
    if (this.watcher) this.watcher.add(this.workflowWatchPaths());
    this.logger.info({ valid: result.workflows.length, invalid: result.errors.length }, "Workflows loaded");
    if (this.started) for (const [type, source] of this.registry.eventSources) {
      void Promise.resolve(source.updateSubscriptions?.(type, this.subscriptionsFor(type)))
        .catch((error) => this.logger.error({ type, error }, "Event source subscription update failed"));
    }
  }

  private workflowWatchPaths(): string[] {
    return [this.paths.workflows, ...[...this.registry.workflowDiscoveries.values()].flatMap((provider) => [...provider.watchPaths])];
  }

  private subscriptionsFor(type: string) {
    return this.workflows.filter((workflow) => Object.hasOwn(workflow.on, type)).flatMap((workflow) => {
      const repositories = workflowRepositories(workflow);
      const subscriptions = repositories.length ? repositories : [undefined];
      return subscriptions.map((repository) => ({
        type, config: workflow.on[type], workflowId: workflow.id, repository,
      }));
    });
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    await this.loadExtensions();
    this.reloadWorkflows();
    this.database.recoverInterruptedRuns(this.config.runtime.maxAttempts);
    for (const recovered of this.database.listRecoverablePlans()) {
      try {
        await this.safeActionGate.reconcile({
          run: recovered.run,
          event: recovered.run.event,
          workflow: recovered.workflow,
          logger: this.logger.child({ run: recovered.run.id, recovery: "safe-action" }),
          verification: recovered.run.verification,
          deadline: recovered.run.deadline === undefined ? undefined : new Date(recovered.run.deadline).toISOString(),
          signal: recovered.run.cancellation ? AbortSignal.abort(new Error("Run cancelled")) : undefined,
        }, recovered.plan, recovered.effects);
      } catch (error) {
        this.logger.error({
          run: recovered.run.id,
          plan: recovered.plan.id,
          error: error instanceof Error ? error.message : String(error),
        }, "Safe Action plan recovery could not start");
      }
    }
    // Reconciliation completes the durable effect first; a second pass then
    // finalizes the interrupted run without ever rerunning its agent.
    this.database.recoverInterruptedRuns(this.config.runtime.maxAttempts);
    this.initialized = true;
    this.schedulePoll(0);
  }

  private recordSourceHealth(type: string, health: EventSourceHealth): void {
    const previous = this.database.getSourceHealth(type);
    const healthy = health.status === "ready";
    const succeeded = health.result ? health.result === "success" : healthy;
    this.database.updateSourceHealth({
      source: type,
      status: healthy ? "healthy" : health.status === "unhealthy" ? "unavailable" : "degraded",
      consecutiveFailures: succeeded ? 0 : (previous?.consecutiveFailures ?? 0) + 1,
      lastSuccessAt: succeeded ? health.observedAt : previous?.lastSuccessAt,
      lastFailureAt: succeeded ? previous?.lastFailureAt : health.observedAt,
      error: health.reason,
      updatedAt: health.observedAt,
    });
  }

  private async startSource(type: string): Promise<void> {
    const source = this.registry.eventSources.get(type);
    if (!source || this.shutdown.signal.aborted) return;
    this.sourceControllers.get(type)?.abort(new Error("Event source restarted"));
    const controller = new AbortController();
    this.sourceControllers.set(type, controller);
    const signal = AbortSignal.any([this.shutdown.signal, controller.signal]);
    const owner = [...this.registry.capabilities].find(([, capabilities]) => capabilities.events.includes(type))?.[0];
    const now = new Date().toISOString();
    this.database.updateSourceHealth({ source: type, status: "degraded", consecutiveFailures: this.sourceStarts.get(type)?.failures ?? 0, updatedAt: now });
    let healthReported = false;
    try {
      await source.start({
        type, signal, subscriptions: this.subscriptionsFor(type),
        emit: (event) => {
          if (signal.aborted || !owner || this.registry.eventSources.get(event.type) !== source || this.registry.eventSources.get(type) !== source) {
            return Promise.resolve({ version: 1, eventId: event.id, status: "rejected", reason: "source_not_owned" });
          }
          return this.receive({ ...event, source: owner }, { signal });
        },
        reconcile: (resourceKey) => {
          for (const [sourceType, registered] of this.registry.eventSources) {
            if (registered === source) this.database.wakeDeferredRoutes(sourceType, resourceKey);
          }
          this.scheduleReconciliation(0);
          this.schedulePoll(0);
        },
        reportHealth: (health) => {
          if (signal.aborted || this.registry.eventSources.get(type) !== source) return;
          healthReported = true; this.recordSourceHealth(type, health);
        },
      });
      if (signal.aborted || this.registry.eventSources.get(type) !== source) return;
      this.sourceStarts.delete(type);
      if (!healthReported) this.database.updateSourceHealth({ source: type, status: "healthy", consecutiveFailures: 0, lastSuccessAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const failures = (this.sourceStarts.get(type)?.failures ?? 0) + 1;
      const nextAttemptAt = Date.now() + Math.min(30_000, 500 * 2 ** Math.min(failures - 1, 6));
      this.sourceStarts.set(type, { failures, nextAttemptAt });
      const observedAt = new Date().toISOString();
      this.database.updateSourceHealth({ source: type, status: "unavailable", consecutiveFailures: failures, lastFailureAt: observedAt, nextAttemptAt, error: message, updatedAt: observedAt });
      this.logger.error({ type, error: message, nextAttemptAt }, "Event source start failed");
    }
  }

  private pruneHistory(): void {
    const cutoff = new Date(Date.now() - this.config.history.retention).toISOString();
    const runIds = this.database.pruneHistory(cutoff);
    let logsRemoved = 0;
    for (const runId of runIds) {
      const file = path.resolve(this.paths.logs, `${runId}.log`);
      if (path.dirname(file) !== path.resolve(this.paths.logs)) {
        this.logger.warn({ runId }, "Skipped invalid retained run log path");
        continue;
      }
      try {
        if (fs.existsSync(file)) {
          fs.rmSync(file);
          logsRemoved++;
        }
      } catch (error) {
        this.logger.warn({ runId, error }, "Expired run history was removed but its log could not be deleted");
      }
    }
    if (runIds.length) this.logger.info({ runsRemoved: runIds.length, logsRemoved, cutoff }, "Expired run history removed");
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.pruneHistory();
    this.historyTimer = setInterval(() => this.pruneHistory(), 60 * 60 * 1_000);
    this.historyTimer.unref();
    for (const loaded of this.extensions) if (loaded.enabled && !loaded.error && loaded.extension.start) {
      try { await loaded.extension.start({ signal: this.shutdown.signal, logger: this.logger.child({ extension: loaded.extension.name }) }); }
      catch (error) { this.logger.error({ extension: loaded.extension.name, error }, "Extension start failed"); }
    }
    for (const type of this.registry.eventSources.keys()) await this.startSource(type);
    this.scheduleReconciliation(0);
    this.watcher = chokidar.watch(this.workflowWatchPaths(), { ignoreInitial: true });
    this.watcher.on("add", () => this.reloadWorkflows());
    this.watcher.on("change", () => this.reloadWorkflows());
    this.watcher.on("unlink", () => this.reloadWorkflows());
  }

  async receive(event: Event, operation?: OperationContext): Promise<EventEmitResult> {
    return this.routeEvent(event, undefined, operation);
  }

  private inputHandler(name: string) {
    const entry = this.registry.inputHandlers.get(name);
    if (!entry || entry.controller.signal.aborted) throw new Error(`Input handler unavailable: ${name}`);
    return entry;
  }

  async submitInput(name: string, input: unknown, config: unknown = {}, operation?: OperationContext): Promise<InputResult> {
    const entry = this.inputHandler(name);
    const signal = AbortSignal.any([this.shutdown.signal, entry.controller.signal, ...(operation ? [operation.signal] : [])]);
    signal.throwIfAborted();
    const parsed = entry.handler.configSchema.parse(config);
    return entry.handler.receive(input, parsed, {
      ...operation, signal,
      emit: (value) => {
        signal.throwIfAborted();
        const event = eventCandidateSchema.parse(value);
        const owned = this.registry.capabilities.get(entry.owner)?.events ?? [];
        if (this.registry.inputHandlers.get(name) !== entry || !entry.handler.eventTypes.includes(event.type) || !owned.includes(event.type)) {
          return Promise.resolve({ version: 1, eventId: event.id, status: "rejected", reason: "source_not_owned" });
        }
        return this.receive({ ...event, source: entry.owner }, { ...operation, signal });
      },
    });
  }

  private async routeEvent(event: Event, sourceEventId?: string, operation?: OperationContext): Promise<EventEmitResult> {
    if (this.stopping) return { version: 1, eventId: event.id, status: "rejected", reason: "runtime_stopping" };
    const pending = this.routingEvents.get(event.id);
    if (pending) {
      const result = await pending;
      return result.status === "accepted" ? { ...result, status: "duplicate", reason: "duplicate_event" } : result;
    }
    if (this.database.hasEvent(event.id)) {
      this.logger.debug({ eventId: event.id, type: event.type }, "Duplicate event ignored");
      return { version: 1, eventId: event.id, status: "duplicate", reason: "duplicate_event" };
    }
    // Defer routing until the shared promise is installed, before any hook can yield.
    const admission = Promise.resolve().then(() => this.admitEvent(event, sourceEventId, operation));
    this.routingEvents.set(event.id, admission);
    try { return await admission; }
    finally { this.routingEvents.delete(event.id); }
  }

  private async admitEvent(event: Event, sourceEventId?: string, operation?: OperationContext): Promise<EventEmitResult> {
    const eventHook: HookContext = { event, instructions: [], metadata: {} };
    await this.registry.runHooks("event:received", eventHook);
    const source = this.registry.eventSources.get(event.type);
    if (!source) this.logger.warn({ type: event.type }, "Received event without registered source");
    const matched: Workflow[] = [];
    const deferred: DeferredRouteRecord[] = [];
    const decisions = new Map<string, EventDecision>();
    if (!eventHook.cancelled && source) for (const workflow of this.workflows) {
      const subscription = workflow.on[event.type];
      if (subscription === undefined) continue;
      const record = (decision: EventDecision["decision"], reason: string) => decisions.set(workflow.id, { eventId: event.id, workflowId: workflow.id, decision, reason });
      if (!workflowAllowsRepository(workflow, event.repository)) { record("ignored", "repository_not_configured"); continue; }
      const decision = eventMatchSchema.parse(source.match
        ? await source.match(event, subscription, { ...operation, signal: operation?.signal ?? this.shutdown.signal, workflowId: workflow.id, workflow }) : true);
      if (decision === false || (typeof decision === "object" && decision.kind === "ignore")) {
        record("ignored", decision === false ? "conditions_not_met" : decision.reason); continue;
      }
      if (decision !== true) {
        const now = Date.now();
        const eventTime = Date.parse(event.timestamp);
        if (!Number.isFinite(eventTime) || eventTime + decision.expiresAfter <= now) { record("ignored", "event_expired"); continue; }
        record("deferred", decision.reason);
        deferred.push({ workflowId: workflow.id, eventId: event.id, source: event.type,
          resourceKey: decision.resourceKey, workflowHash: snapshotHash(workflow), reason: decision.reason,
          availableAt: now + decision.retryAfter, expiresAt: Math.min(now, eventTime) + decision.expiresAfter });
        continue;
      }
      const hook: HookContext = { event, workflow, instructions: [], metadata: {} };
      await this.registry.runHooks("workflow:matched", hook);
      if (!hook.cancelled) { matched.push(workflow); record("queued", "matched"); }
      else record("ignored", hook.reason ?? "cancelled_by_hook");
    }
    const now = new Date().toISOString();
    if (this.stopping || operation?.signal.aborted) return { version: 1, eventId: event.id, status: "rejected", reason: "admission_aborted" };
    const current = (workflow: Workflow) => this.workflows.some(candidate => candidate.id === workflow.id && snapshotHash(candidate) === snapshotHash(workflow));
    const validDeferred = deferred.filter(route => this.workflows.some(candidate => candidate.id === route.workflowId && snapshotHash(candidate) === route.workflowHash));
    for (const workflow of matched) if (!current(workflow)) decisions.set(workflow.id, { eventId: event.id, workflowId: workflow.id, decision: "ignored", reason: "configuration_changed" });
    for (const route of deferred) if (!validDeferred.includes(route)) decisions.set(route.workflowId, { eventId: event.id, workflowId: route.workflowId, decision: "ignored", reason: "configuration_changed" });
    const candidates = matched.filter(current).map((workflow) => ({
      workflow,
      run: { id: randomId("rp"), workflowId: workflow.id, repository: workflow.repository ? event.repository : undefined,
        resourceKey: source?.resourceKey?.(event), event, status: "queued" as const, createdAt: now, updatedAt: now },
    }));
    const records = candidates.map(({ workflow, run }) => ({
      run, agent: workflow.agent, execution: workflow.execution, workspace: workflow.workspace,
      metadata: { workflow, workflowHash: snapshotHash(workflow) },
    }));
    const admission = sourceEventId
      ? this.database.admitReroutedEventWithRuns({
          id: randomId("reroute_request"), sourceEventId, eventId: event.id, createdAt: now,
        }, event, records, this.config.runtime.maxQueuedRuns, validDeferred, [...decisions.values()])
      : this.database.admitEventWithRuns(event, records, this.config.runtime.maxQueuedRuns, validDeferred, [...decisions.values()]);
    if (!admission.admitted) return {
      version: 1, eventId: event.id,
      status: ["duplicate_event", "duplicate_reroute"].includes(admission.reason) ? "duplicate" : "rejected",
      reason: admission.reason,
    };
    this.logger.info({ eventId: event.id, type: event.type, matched: admission.runs.length, deferred: validDeferred.length }, "Event routed");
    for (const route of validDeferred) this.logger.info({ eventId: event.id, workflowId: route.workflowId,
      resourceKey: route.resourceKey, reason: route.reason, expiresAt: route.expiresAt }, "Workflow route deferred");
    for (const run of admission.runs) {
      const workflow = candidates.find((candidate) => candidate.run.id === run.id)!.workflow;
      try { await this.registry.runHooks("run:created", { event, workflow, run, instructions: [], metadata: {} }); }
      catch (error) { this.logger.error({ runId: run.id, error }, "Run created hook failed"); }
    }
    this.schedulePoll(0);
    return { version: 1, eventId: event.id, status: "accepted", runIds: admission.runs.map((run) => run.id) };
  }

  private scheduleReconciliation(delay: number): void {
    if (!this.started || this.stopping) return;
    if (this.reconciliationTimer) clearTimeout(this.reconciliationTimer);
    this.reconciliationTimer = setTimeout(() => {
      this.reconciliationTimer = undefined;
      void this.reconcileDeferredRoutes().catch((error) => this.logger.error({ error }, "Deferred routing failed"))
        .finally(() => this.scheduleReconciliation(1_000));
    }, delay);
    this.reconciliationTimer.unref();
  }

  async reconcileDeferredRoutes(): Promise<void> {
    if (this.reconciliation) return this.reconciliation;
    if (this.stopping) return;
    this.reconciliation = this.reconcileDueRoutes();
    try { await this.reconciliation; }
    finally { this.reconciliation = undefined; }
  }

  private async reconcileDueRoutes(): Promise<void> {
    const batchId = randomId("match_batch");
    const signal = AbortSignal.any([this.shutdown.signal, AbortSignal.timeout(30_000)]);
    for (const route of this.database.listDeferredRoutes()) {
      if (this.stopping || signal.aborted) return;
      const event = this.database.getEvent(route.eventId);
      const workflow = this.workflows.find((candidate) => candidate.id === route.workflowId);
      const source = event && this.registry.eventSources.get(event.type);
      if (!event || !workflow || !source || route.expiresAt <= Date.now() || snapshotHash(workflow) !== route.workflowHash ||
          !workflowAllowsRepository(workflow, event.repository) || workflow.on[event.type] === undefined) {
        this.database.removeDeferredRoute(route);
        this.logger.info({ eventId: route.eventId, workflowId: route.workflowId, reason: "expired_or_configuration_changed" }, "Deferred route discarded");
        continue;
      }
      try {
        const decision = eventMatchSchema.parse(source.match ? await source.match(event, workflow.on[event.type], {
          signal, workflowId: workflow.id, workflow, batchId,
        }) : true);
        if (this.stopping) return;
        // Configuration can change while the source fetches live eligibility.
        if (!this.workflows.some((candidate) => candidate.id === workflow.id && snapshotHash(candidate) === route.workflowHash)) {
          this.database.removeDeferredRoute(route);
          continue;
        }
        if (decision === false || (typeof decision === "object" && decision.kind === "ignore")) {
          this.database.recordEventDecision({ eventId: event.id, workflowId: workflow.id, decision: "ignored", reason: decision === false ? "conditions_not_met" : decision.reason });
          this.database.removeDeferredRoute(route); continue;
        }
        if (decision !== true) {
          this.database.rescheduleDeferredRoute(route, decision.reason, Date.now() + decision.retryAfter);
          continue;
        }
        const hook: HookContext = { event, workflow, instructions: [], metadata: {} };
        await this.registry.runHooks("workflow:matched", hook);
        if (hook.cancelled) { this.database.removeDeferredRoute(route); continue; }
        if (this.stopping || signal.aborted || !this.workflows.some(candidate => candidate.id === workflow.id && snapshotHash(candidate) === route.workflowHash)) {
          if (!this.stopping && !signal.aborted) this.database.removeDeferredRoute(route);
          continue;
        }
        const now = new Date().toISOString();
        const run: Run = { id: randomId("rp"), workflowId: workflow.id, repository: workflow.repository ? event.repository : undefined,
          resourceKey: source.resourceKey?.(event), event, status: "queued", createdAt: now, updatedAt: now };
        const result = this.database.admitDeferredRun(route, {
          run, agent: workflow.agent, execution: workflow.execution, workspace: workflow.workspace,
          metadata: { workflow, workflowHash: route.workflowHash },
        }, this.config.runtime.maxQueuedRuns);
        if (result === "capacity") {
          this.database.rescheduleDeferredRoute(route, "capacity", Date.now() + 30_000);
        } else if (result === "accepted") {
          this.logger.info({ eventId: event.id, workflowId: workflow.id, runId: run.id }, "Deferred route admitted");
          try { await this.registry.runHooks("run:created", { event, workflow, run, instructions: [], metadata: {} }); }
          catch (error) { this.logger.error({ runId: run.id, error }, "Run created hook failed"); }
          this.schedulePoll(0);
        }
      } catch (error) {
        this.database.rescheduleDeferredRoute(route, "evaluation_failed", Date.now() + 30_000);
        this.logger.error({ eventId: route.eventId, workflowId: route.workflowId, error }, "Deferred route evaluation failed");
      }
    }
  }

  async rerouteEvent(sourceEventId: string): Promise<EventEmitResult> {
    const source = this.database.getEvent(sourceEventId);
    if (!source) throw new Error(`Event not found: ${sourceEventId}`);
    if (source.provenance) throw new Error(`Cannot reroute synthetic event: ${sourceEventId}`);
    if (this.database.eventHasDeferredRoutes(sourceEventId)) throw new Error(`Event has deferred routes; automatic reconciliation is pending: ${sourceEventId}`);
    if (this.database.eventHasRuns(sourceEventId)) throw new Error(`Event already created runs; replay a run instead: ${sourceEventId}`);
    const event: Event = {
      ...source,
      id: randomId("reroute"),
      provenance: { kind: "reroute", sourceEventId },
    };
    return this.routeEvent(event, sourceEventId);
  }

  createRun(workflow: Workflow, event: Event): Run {
    if (!workflowAllowsRepository(workflow, event.repository)) {
      throw new Error(`Repository '${event.repository ?? "none"}' is not configured for workflow '${workflow.id}'`);
    }
    const now = new Date().toISOString();
    const run: Run = { id: randomId("rp"), workflowId: workflow.id, repository: workflow.repository ? event.repository : undefined, event, status: "queued", createdAt: now, updatedAt: now };
    const admission = this.database.admitEventWithRuns(event, [{
      run, agent: workflow.agent, execution: workflow.execution, workspace: workflow.workspace,
      metadata: { workflow, workflowHash: snapshotHash(workflow) },
    }], this.config.runtime.maxQueuedRuns);
    if (!admission.admitted) throw new Error(admission.reason === "capacity" ? "Run queue is at capacity" : `Run already exists for workflow '${workflow.id}' and event '${event.id}'`);
    void this.registry.runHooks("run:created", { event, workflow, run, instructions: [], metadata: {} })
      .catch((error) => this.logger.error({ runId: run.id, error }, "Run created hook failed"));
    this.schedulePoll(0);
    return run;
  }

  runManual(identifier: string, data: unknown = {}, repository?: string): Run {
    const workflow = resolveWorkflow(this.workflows, identifier);
    if (!workflow) throw new Error(`Workflow not found: ${identifier}`);
    const repositories = workflowRepositories(workflow);
    if (repositories.length > 1 && !repository) throw new Error(`Workflow '${workflow.id}' targets multiple repositories; specify --repository`);
    if (repositories.length === 0 && repository) throw new Error(`Workflow '${workflow.id}' does not configure a repository`);
    const selectedRepository = repository ?? repositories[0];
    if (!workflowAllowsRepository(workflow, selectedRepository)) {
      throw new Error(`Repository '${selectedRepository}' is not configured for workflow '${workflow.id}'`);
    }
    const now = new Date().toISOString();
    return this.createRun(workflow, { id: randomId("manual"), type: "manual", source: "cli", timestamp: now, repository: selectedRepository, data });
  }

  async submitRun(identifier: string, options: { input?: unknown; repository?: string; token?: string; inheritEvent?: boolean; handoffKey?: string } = {}): Promise<Run> {
    if (this.stopping) throw new Error("runtime_stopping");
    this.reloadWorkflows();
    if (!options.token) {
      if (options.inheritEvent || options.handoffKey) throw new Error("Event inheritance and handoff keys require an active scripted parent");
      return this.runManual(identifier, options.input ?? {}, options.repository);
    }
    const context = this.submissionContexts.get(options.token);
    if (!context) throw new Error("handoff_context_invalid");
    const parent = this.database.getRun(context.lease.runId);
    if (!parent || parent.status !== "running" || parent.cancellation) throw new Error("handoff_parent_unavailable");
    const currentStep = this.database.listSteps(parent.id).filter((step) => step.id === context.stepId).at(-1);
    if (currentStep?.status !== "running" || currentStep.attempt !== context.attempt) throw new Error("handoff_step_not_running");
    const workflow = resolveWorkflow(this.workflows, identifier);
    if (!workflow) throw new Error(`Workflow not found: ${identifier}`);
    let ancestor: string | undefined = parent.id;
    let rootRunId = parent.id;
    let depth = 0;
    while (ancestor) {
      if (++depth > 16) throw new Error("handoff_depth_exceeded");
      const previous = this.database.getRun(ancestor);
      if (previous?.workflowId === workflow.id) throw new Error("handoff_recursive_workflow");
      rootRunId = ancestor;
      ancestor = this.database.parentRun(ancestor);
    }
    const repositories = workflowRepositories(workflow);
    const repository = options.repository ?? (repositories.includes(parent.repository ?? "") ? parent.repository : repositories.length === 1 ? repositories[0] : undefined);
    if (repositories.length > 1 && !repository) throw new Error("Multi-repository handoff requires --repository");
    if ((!repositories.length && repository) || !workflowAllowsRepository(workflow, repository)) throw new Error("handoff_repository_not_allowed");
    if (options.inheritEvent && repository !== parent.repository) throw new Error("handoff_cannot_change_event_repository");
    const now = new Date().toISOString();
    const event: Event = options.inheritEvent
      ? { ...parent.event, id: randomId("handoff"), input: options.input ?? {}, provenance: { kind: "handoff", parentRunId: parent.id, rootRunId, sourceEventId: parent.event.id } }
      : { id: randomId("manual"), type: "manual", source: "cli", timestamp: now, repository, data: options.input ?? {},
          provenance: { kind: "handoff", parentRunId: parent.id, rootRunId, sourceEventId: parent.event.id } };
    const key = options.handoffKey ?? workflow.id;
    const hash = snapshotHash({ workflowId: workflow.id, repository, inheritEvent: options.inheritEvent ?? false, input: options.input ?? {} });
    const existing = this.database.childRequest(parent.id, context.stepId, key);
    if (!existing && options.inheritEvent) {
      const source = this.registry.eventSources.get(event.type);
      const subscription = workflow.on[event.type];
      if (!source || (subscription === undefined && Object.keys(workflow.on).length !== 0)) throw new Error("handoff_event_not_supported_by_child");
      const liveEvent = parent.activation?.data === undefined ? event : { ...event, data: parent.activation.data };
      if (subscription !== undefined && source.match && await source.match(liveEvent, subscription, { signal: this.shutdown.signal, workflowId: workflow.id }) !== true) throw new Error("handoff_child_filter_rejected");
    }
    const run: Run = { id: randomId("rp"), workflowId: workflow.id, repository, event, status: "queued", createdAt: now, updatedAt: now };
    const accepted = this.database.admitChild(context.lease, context.stepId, key, hash, event, {
      run, agent: workflow.agent, execution: workflow.execution, workspace: workflow.workspace,
      metadata: { workflow, workflowHash: snapshotHash(workflow) },
    }, this.config.runtime.maxQueuedRuns, context.attempt);
    if (!existing) void this.registry.runHooks("run:created", { event, workflow, run: accepted, instructions: [], metadata: { parentRunId: parent.id } })
      .catch((error) => this.logger.error({ error, runId: accepted.id }, "Child run created hook failed"));
    this.schedulePoll(0);
    return accepted;
  }

  async queryCommand(name: string, args: readonly string[], token: string): Promise<JsonValue> {
    const context = this.submissionContexts.get(token);
    if (!context || !this.database.isLeaseCurrent(context.lease)) throw new Error("query_context_invalid");
    const run = this.database.getRun(context.lease.runId);
    const workflow = this.database.getWorkflowSnapshot(context.lease.runId);
    const step = this.database.listSteps(context.lease.runId).filter((record) => record.id === context.stepId).at(-1);
    if (!run || !workflow || run.status !== "running" || run.cancellation || step?.status !== "running" || step.attempt !== context.attempt) throw new Error("query_parent_unavailable");
    const command = this.registry.extensionCommands.get(name);
    if (!command?.query) throw new Error(`Command '${name}' does not support scoped read-only queries`);
    const event = run.activation?.data === undefined ? run.event : { ...run.event, data: run.activation.data };
    const signal = AbortSignal.any([context.controller.signal, this.activeRuns.get(run.id)?.controller.signal ?? this.shutdown.signal]);
    return command.query(args, { run, event, workflow, signal, deadline: new Date(run.deadline ?? Date.now()).toISOString() });
  }

  async requestAction(name: string, input: unknown, options: { token: string; requestKey: string }): Promise<import("@mixer/automations-sdk").SafeActionResult> {
    const request = actionRequestSchema.parse({ name, input, requestKey: options.requestKey });
    const context = this.submissionContexts.get(options.token);
    if (!context || context.controller.signal.aborted || !this.database.isLeaseCurrent(context.lease)) throw new Error("action_context_invalid");
    const run = this.database.getRun(context.lease.runId);
    const workflow = this.database.getWorkflowSnapshot(context.lease.runId);
    if (!run || !workflow?.task || run.status !== "running" || run.cancellation || (run.deadline ?? 0) <= Date.now()) throw new Error("action_parent_unavailable");
    const controller = this.activeRuns.get(run.id)?.controller;
    controller?.signal.throwIfAborted();
    return this.safeActionGate.requestScripted(request.name, request.input, { run, workflow, logger: this.logger }, {
      lease: context.lease, stepId: context.stepId, attempt: context.attempt, key: request.requestKey,
    });
  }

  replayRun(sourceRunId: string, options: { workflow?: "snapshot" | "current" } = {}): Run {
    const source = this.database.getRun(sourceRunId);
    if (!source) throw new Error(`Run not found: ${sourceRunId}`);
    if (!["completed", "failed", "cancelled", "interrupted"].includes(source.status)) throw new Error(`Run ${sourceRunId} cannot be replayed while ${source.status}`);
    const workflowMode = options.workflow ?? "snapshot";
    const workflow = workflowMode === "current" ? resolveWorkflow(this.workflows, source.workflowId) : this.database.getWorkflowSnapshot(sourceRunId);
    if (!workflow) throw new Error(`${workflowMode === "current" ? "Current workflow" : "Workflow snapshot"} not found: ${source.workflowId}`);
    const validation = validateWorkflow(workflow, this.registry);
    if (validation.length) throw new Error(`Replay workflow is invalid: ${validation.join("; ")}`);
    const repositories = workflowRepositories(workflow);
    if (repositories.length ? !source.repository || !repositories.includes(source.repository) : source.repository !== undefined) {
      throw new Error(`Repository '${source.repository ?? "none"}' is not configured for workflow '${workflow.id}'`);
    }
    const now = new Date().toISOString();
    const rootRunId = source.event.provenance?.kind === "replay" ? source.event.provenance.rootRunId : sourceRunId;
    const activeReplay = this.database.getActiveReplay(rootRunId);
    if (activeReplay) throw new Error(`Replay already active for this lineage: ${activeReplay}`);
    const event: Event = { ...source.event, id: randomId("replay"), source: "replay", provenance: { kind: "replay", sourceRunId, rootRunId, sourceEventId: source.event.id } };
    const run: Run = { id: randomId("rp"), workflowId: workflow.id, repository: source.repository, event, status: "queued", createdAt: now, updatedAt: now };
    const workflowHash = snapshotHash(workflow);
    this.database.insertReplay({ id: randomId("replay_request"), sourceRunId, rootRunId, runId: run.id, eventId: event.id, workflowMode, workflowHash, createdAt: now },
      event, run, workflow, this.config.runtime.maxQueuedRuns);
    void this.registry.runHooks("run:created", { event, workflow, run, instructions: [], metadata: { replay: true, sourceRunId, rootRunId } })
      .catch((error) => this.logger.error({ runId: run.id, error }, "Replay run created hook failed"));
    this.schedulePoll(0);
    return run;
  }

  cancelRun(runId: string, reason = "Run cancelled"): boolean {
    const requested = this.database.requestRunCancellation(runId, reason);
    const outcome: AgentResult = { version: 1, outcome: "blocked", reason };
    if (this.database.cancelQueuedRun(runId, reason, outcome)) this.schedulePoll(0);
    this.activeRuns.get(runId)?.controller.abort(new Error(reason));
    return requested;
  }

  private schedulePoll(delay = POLL_MS): void {
    if (!this.initialized || this.pollTimer || this.shutdown.signal.aborted) return;
    this.pollTimer = setTimeout(() => {
      this.pollTimer = undefined;
      void this.poll().finally(() => this.schedulePoll());
    }, delay);
    this.pollTimer.unref();
  }

  private async poll(): Promise<void> {
    if (this.dispatching) return;
    this.dispatching = true;
    try {
      this.database.recoverExpiredRuns(this.config.runtime.maxAttempts);
      for (const { run } of this.database.listQueuedRuns()) {
        const key = this.registry.eventSources.get(run.event.type)?.resourceKey?.(run.event);
        if (key && !run.resourceKey) this.database.assignQueuedResource(run.id, key);
        const deadline = this.database.getRun(run.id)?.deadline;
        if (deadline !== undefined && deadline <= Date.now()) {
          const reason = "Run execution deadline exceeded while queued for retry";
          this.database.cancelQueuedRun(run.id, reason, { version: 1, outcome: "blocked", reason });
        }
      }
      for (const [runId, active] of this.activeRuns) {
        if (this.database.getRun(runId)?.cancellation && !active.controller.signal.aborted) active.controller.abort(new Error("Run cancelled"));
      }
      while (!this.stopping && this.activeRuns.size < this.config.runtime.concurrency) {
        const lease = this.database.claimEligibleRun(this.leaseOwner, LEASE_MS, Date.now(), this.config.runtime.concurrency, this.config.runtime.timeout);
        if (!lease) break;
        const controller = new AbortController();
        const promise = this.executeRun(lease, controller).finally(() => { this.activeRuns.delete(lease.runId); this.schedulePoll(0); });
        this.activeRuns.set(lease.runId, { controller, promise });
      }
      await this.deliverLifecycle();
      if (this.started && !this.stopping) for (const [type, state] of this.sourceStarts) if (state.nextAttemptAt <= Date.now()) await this.startSource(type);
    } finally {
      this.dispatching = false;
    }
  }

  private async deliverLifecycle(): Promise<void> {
    for (;;) {
      const delivery = this.database.claimLifecycle(this.leaseOwner, LEASE_MS);
      if (!delivery) return;
      try {
        const run = this.database.getRun(delivery.runId);
        const workflow = this.database.getWorkflowSnapshot(delivery.runId);
        if (!run || !workflow || delivery.event !== "run:finalized") throw new Error("lifecycle_context_unavailable");
        const renewal = setInterval(() => {
          if (!this.database.renewLifecycle(delivery.id, this.leaseOwner, delivery.leaseGeneration, LEASE_MS)) clearInterval(renewal);
        }, 20_000);
        renewal.unref();
        try { await this.registry.runHooks("run:finalized", {
          event: run.event, workflow, run, instructions: [],
          metadata: { ...(delivery.payload as Record<string, unknown>), deliveryId: delivery.id },
        }); } finally { clearInterval(renewal); }
        this.database.completeLifecycle(delivery.id, this.leaseOwner, delivery.leaseGeneration);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const retryAt = Date.now() + Math.min(30_000, 500 * 2 ** Math.min(delivery.attempts - 1, 6));
        this.database.completeLifecycle(delivery.id, this.leaseOwner, delivery.leaseGeneration, message, retryAt);
        this.logger.error({ deliveryId: delivery.id, error: message }, "Lifecycle delivery failed");
      }
    }
  }

  private fenced(lease: RunLease, run: Run, status: RunStatus, options?: Parameters<StateDatabase["updateRunFenced"]>[2]): void {
    if (!this.database.updateRunFenced(lease, status, options)) throw new Error("run_lease_lost");
    run.status = status;
    run.updatedAt = new Date().toISOString();
  }

  private async executeRun(initialLease: RunLease, controller: AbortController): Promise<void> {
    let lease = initialLease;
    const persisted = this.database.getRun(lease.runId);
    const workflow = this.database.getWorkflowSnapshot(lease.runId);
    if (!persisted || !workflow) { this.database.releaseRunFenced(lease); return; }
    const run: Run = persisted;
    this.safeActionGate.reopen(run.id);
    const attempt = persisted.attempts;
    const logger = createLogger(this.paths, { runId: run.id });
    const signal = controller.signal;
    const globalAbort = () => controller.abort(this.shutdown.signal.reason ?? new Error("Runtime stopped"));
    this.shutdown.signal.addEventListener("abort", globalAbort, { once: true });
    const deadlineAt = persisted.deadline ?? Date.now() + (workflow.timeout ?? this.config.runtime.timeout);
    const deadline = new Date(deadlineAt).toISOString();
    const deadlineTimer = setTimeout(() => controller.abort(new Error("Run deadline exceeded")), Math.max(0, deadlineAt - Date.now()));
    deadlineTimer.unref();
    const leaseTimer = setInterval(() => {
      const renewed = this.database.renewRunFenced(lease, LEASE_MS);
      if (renewed) lease = renewed;
      else controller.abort(new Error("run_lease_lost"));
    }, 20_000);
    leaseTimer.unref();
    const workspaceProvider = this.registry.workspaceProviders.get(workflow.workspace ?? "worktree");
    const executionProvider = this.registry.executionProviders.get(workflow.execution);
    const workspaceContext = { run, repository: run.repository, signal, deadline, logger };
    const lifecycle: HookContext = { event: run.event, workflow, run, signal, deadline, instructions: [], metadata: {} };
    let workspace: Workspace | undefined;
    let session: import("@mixer/automations-sdk").ExecutionSession | undefined;
    let effectiveWorkspace: EffectiveWorkspace | undefined;
    let normalized: AgentResult | undefined;
    let failureMessage: string | undefined;
    let cleanupError: string | undefined;
    let retry = false;
    let waiting: { resourceKey: string; reason: string; availableAt: number } | undefined;
    let phase: RunStatus = "preparing";
    try {
      this.fenced(lease, run, "preparing", { phase: "preparing" });
      let activeEvent = run.event;
      const source = this.registry.eventSources.get(run.event.type);
      if (!source && run.event.type !== "manual") throw new Error(`event_source_unavailable:${run.event.type}`);
      await this.registry.runHooks("run:acquire", lifecycle);
      if (lifecycle.cancelled) throw new Error(lifecycle.reason ?? "Run cancelled by hook");
      signal.throwIfAborted();
      const activation = await source?.activate?.(run.event, { signal, deadline, workflowId: workflow.id, workflow });
      if (activation) {
        run.activation = activation;
        if (activation.data !== undefined) activeEvent = { ...run.event, data: activation.data };
        if (!this.database.updateRunActivationFenced(lease, activation)) throw new Error("run_lease_lost");
      }
      const subscription = workflow.on[run.event.type];
      const decision = !activation?.decision && subscription !== undefined && source?.match
        ? eventMatchSchema.parse(await source.match(activeEvent, subscription, { signal, deadline, workflowId: workflow.id, workflow })) : true;
      signal.throwIfAborted();
      if (!this.database.isLeaseCurrent(lease)) throw new Error("run_lease_lost");
      if (activation?.decision?.kind === "skip") {
        normalized = { version: 1, outcome: "no-op", reason: activation.decision.reason };
      } else if (typeof decision === "object" && decision.kind === "defer" && Date.parse(run.event.timestamp) + decision.expiresAfter > Date.now()) {
        waiting = { resourceKey: decision.resourceKey, reason: decision.reason, availableAt: Date.now() + decision.retryAfter };
      } else if (decision !== true) {
        normalized = { version: 1, outcome: "no-op", reason: typeof decision === "object" && decision.kind === "ignore" ? decision.reason : "event_no_longer_matches" };
      } else {
        this.database.recordEventDecision({ eventId: run.event.id, workflowId: workflow.id, decision: "queued", reason: "execution_eligible" });
        lifecycle.event = activeEvent;
        await this.registry.runHooks("run:before", lifecycle);
        if (lifecycle.cancelled) throw new Error(lifecycle.reason ?? "Run cancelled by hook");
        if (signal.aborted) throw abortError(signal);
        if (!workspaceProvider) throw new Error(`Workspace provider is unavailable: ${workflow.workspace ?? "worktree"}`);
        workspace = await workspaceProvider.create({ ...workspaceContext, source: activation?.workspaceSource });
        if (!workspaceProvider.attest) throw new Error("Workspace provider does not support required attestation");
        const initialAttestation = await workspaceProvider.attest({ ...workspaceContext, source: activation?.workspaceSource }, workspace);
        validateInitialWorkspace(workspace, initialAttestation, activation?.workspaceSource?.repository ?? run.repository, activation?.workspaceSource?.revision);
        effectiveWorkspace = { initial: initialAttestation };
        if (!this.database.updateEffectiveWorkspaceFenced(lease, effectiveWorkspace)) throw new Error("run_lease_lost");
        logger.info({ workspace: initialAttestation }, "Workspace attested");
        if (!executionProvider) throw new Error(`Execution provider is unavailable: ${workflow.execution}`);
        session = await executionProvider.open({ run, workflow, workspace, signal, deadline, logger, stage: workflow.task ? "steps" : "agent", agent: workflow.agent, workspaceAccess: "read-write" });
        this.fenced(lease, run, "running", { phase: "running" });
        phase = "running";
        const hook: HookContext = { event: activeEvent, workflow, run, workspace, instructions: [...lifecycle.instructions], metadata: {} };
        hook.instructions.push(initialAttestation.kind === "directory" ? [
          `Mixer Automations created an isolated working directory at ${initialAttestation.path}.`,
          "This workflow has no source repository. Use this directory only for temporary files needed by the task.",
          "Do not search for or modify another local workspace.",
        ].join("\n") : [
          `Mixer Automations verified the effective checkout at ${initialAttestation.path}.`,
          `Operate only inside this checkout. Its repository is ${initialAttestation.repository ?? run.repository ?? "unknown"} at starting revision ${initialAttestation.revision}.`,
          "Do not search for, switch to, or modify another local checkout.",
        ].join("\n"));
        await this.registry.runHooks("execution:before", hook);
        if (hook.cancelled) throw new Error(hook.reason ?? "Execution cancelled by hook");
        if (workflow.task) {
          const runner = this.registry.workflowRunners.get(workflow.task.runner);
          if (!runner) throw new Error(`Workflow runner unavailable: ${workflow.task.runner}`);
          normalized = await runner.run({ run, event: activeEvent, workflow, configuration: workflow.task.configuration,
            workspace, execution: session.process, signal, deadline, logger, cli: this.options.cli,
            noOutputTimeout: this.config.runtime.noOutputTimeout,
            abortStatus: () => this.database.getRun(run.id)?.cancellation ? "cancelled" : this.shutdown.signal.aborted ? "interrupted" : "failed",
            recordStep: (record) => {
              this.database.recordStepFenced(lease, record);
              if (record.status !== "running") for (const [token, context] of this.submissionContexts) {
                if (context.lease.runId === run.id && context.stepId === record.id) {
                  context.controller.abort(new Error("Step finished")); this.submissionContexts.delete(token);
                }
              }
            },
            stepEnvironment: (stepId) => {
              const token = `submission_${randomBytes(32).toString("hex")}`;
              const step = this.database.listSteps(run.id).filter((record) => record.id === stepId).at(-1);
              if (!step || step.status !== "running") throw new Error("handoff_step_not_running");
              this.submissionContexts.set(token, { lease, stepId, attempt: step.attempt, controller: new AbortController() });
              return { MIXER_AUTOMATIONS_SUBMISSION_TOKEN: token, MIXER_AUTOMATIONS_RUN_ID: run.id };
            },
          });
          if (signal.aborted) throw abortError(signal);
          if (normalized.outcome === "unknown" && this.database.childRuns(run.id).length) normalized = { ...normalized, outcome: "acted", reason: "workflow_handoff_accepted" };
        } else {
          const provider = this.registry.agentProviders.get(workflow.agent);
          if (!provider) throw new Error(`Agent unavailable: ${workflow.agent}`);
          await this.registry.runHooks("agent:before", hook);
          if (hook.cancelled) throw new Error(hook.reason ?? "Agent cancelled by hook");
          if (signal.aborted) throw abortError(signal);
          const actionTools = this.safeActionGate.tools({ run, event: activeEvent, workflow, workspace, logger });
          const prompt = workflow.prompt + (activeEvent.input === undefined ? "" : `\n\nHandoff input:\n${JSON.stringify(activeEvent.input)}`);
          const result = await provider.run({
            run, event: activeEvent, repository: run.repository, workspace, workspaceAccess: "read-write",
            instructions: hook.instructions, prompt: agentPrompt(prompt, activeEvent, actionTools), actions: actionTools, execution: session.process,
            signal, deadline, logger, model: workflow.model, thinking: workflow.thinking,
            timeout: Math.max(1, deadlineAt - Date.now()), noOutputTimeout: this.config.runtime.noOutputTimeout,
          });
          if (signal.aborted) throw abortError(signal);
          normalized = normalizeAgentResult(result, this.config.runtime.mode);
          await this.registry.runHooks("agent:after", { ...hook, metadata: { output: normalized.output, outcome: normalized.outcome } });
          for (const action of normalized.actions ?? []) {
            await this.safeActionGate.request(action.name, action.input ?? {}, { run, event: activeEvent, workflow, workspace, logger });
          }
        }
        await session.close();
        session = undefined;
        this.safeActionGate.close(run.id);
        const assertActive = () => {
          signal.throwIfAborted();
          if (!this.database.isLeaseCurrent(lease)) throw new Error("run_lease_lost");
          if (this.database.getRun(run.id)?.cancellation) throw new Error("Run cancelled");
          if (Date.now() >= deadlineAt) throw new Error("Run deadline exceeded");
        };
        assertActive();
        if (normalized.outcome !== "failed" && normalized.outcome !== "blocked") {
          if (workflow.task) this.database.discardUnconfirmedScriptedActions(run.id);
          const actionResults = await this.safeActionGate.apply({ run, event: activeEvent, workflow, workspace, logger, activation: run.activation, signal, deadline, assertActive });
          assertActive();
          const results = [...this.database.listActions(run.id).filter(action => action.status === "rejected"), ...actionResults];
          const failedAction = results.find((action) => action.status === "failed");
          const rejectedAction = results.find((action) => action.status === "rejected");
          if (failedAction) throw new Error(`Safe Action failed: ${failedAction.reason ?? failedAction.id}`);
          if (rejectedAction && (!workflow.task || !actionResults.some(action => action.status === "executed"))) normalized = { ...normalized, outcome: "blocked", reason: `Safe Action rejected: ${rejectedAction.reason ?? rejectedAction.id}` };
          else if (actionResults.some((action) => action.status === "executed")) normalized = { ...normalized, outcome: "acted" };
        }
      }
      if (normalized?.outcome === "no-op" && !workspace) this.database.recordEventDecision({ eventId: run.event.id, workflowId: workflow.id,
        decision: "ignored", reason: normalized.reason ?? "event_no_longer_matches" });
    } catch (error) {
      failureMessage = signal.aborted && signal.reason instanceof Error && signal.reason.message === "Run deadline exceeded"
        ? signal.reason.message : error instanceof Error ? error.message : String(error);
      const leaseLost = failureMessage === "run_lease_lost";
      const cancellation = this.database.getRun(run.id)?.cancellation;
      retry = !workflow.task && !leaseLost && !failureMessage.startsWith("Safe Action failed:") && !signal.aborted && attempt < this.config.runtime.maxAttempts;
      normalized = { version: 1, outcome: cancellation ? "blocked" : "failed", reason: failureMessage };
      logger.error({ error: failureMessage }, "Run failed");
    } finally {
      for (const [token, context] of this.submissionContexts) if (context.lease.runId === run.id) {
        context.controller.abort(new Error("Run finished")); this.submissionContexts.delete(token);
      }
      this.safeActionGate.close(run.id);
      if (this.database.isLeaseCurrent(lease)) this.database.discardPendingActions(run.id, failureMessage ?? "workflow_ended_without_action_execution");
      clearTimeout(deadlineTimer);
      this.shutdown.signal.removeEventListener("abort", globalAbort);
      if (session) try { await session.close(); }
      catch (error) {
        cleanupError = `Execution session cleanup failed: ${error instanceof Error ? error.message : String(error)}`;
        logger.error({ error }, "Execution session cleanup failed");
      }
      const renewedBeforeCleanup = this.database.renewRunFenced(lease, LEASE_MS);
      if (renewedBeforeCleanup) lease = renewedBeforeCleanup;
      else controller.abort(new Error("run_lease_lost"));
      const lostBeforeCleanup = signal.reason instanceof Error && signal.reason.message === "run_lease_lost";
      if (!lostBeforeCleanup && workflow.task) {
        for (const step of this.database.listSteps(run.id)) {
          if (step.status === "pending" || step.status === "running") {
            try { this.database.recordStepFenced(lease, { ...step, status: step.status === "pending" ? "skipped" : "interrupted", finishedAt: new Date().toISOString(), error: failureMessage ?? "Execution ended before this step completed" }); }
            catch { controller.abort(new Error("run_lease_lost")); }
          }
        }
      }
      try {
        if (lostBeforeCleanup) throw new Error("run_lease_lost");
        await this.registry.runHooks("run:after", { ...lifecycle, workspace, metadata: {
          ...lifecycle.metadata, succeeded: workflow.task ? !failureMessage && normalized?.outcome !== "failed" && normalized?.outcome !== "blocked" : normalized?.outcome === "acted" || normalized?.outcome === "no-op",
          ...(failureMessage ? { error: failureMessage } : {}),
        } });
      } catch (error) {
        cleanupError ??= `Run finalization hook failed: ${error instanceof Error ? error.message : String(error)}`;
        logger.error({ error }, "Run finalization hook failed");
      }
      // Execution may already be aborted. Give final attestation a separate,
      // bounded window to record what the agent actually left behind.
      const attestationContext = { ...workspaceContext, signal: AbortSignal.timeout(30_000) };
      if (!lostBeforeCleanup && workspace && workspaceProvider?.attest && effectiveWorkspace) try {
        effectiveWorkspace = { ...effectiveWorkspace, final: await workspaceProvider.attest(attestationContext, workspace) };
        if (!this.database.updateEffectiveWorkspaceFenced(lease, effectiveWorkspace)) throw new Error("run_lease_lost");
        logger.info({ workspace: effectiveWorkspace.final }, "Final workspace recorded");
      } catch (error) {
        cleanupError ??= `Final workspace attestation failed: ${error instanceof Error ? error.message : String(error)}`;
        logger.error({ error }, "Final workspace attestation failed");
      }
      if (!lostBeforeCleanup && workspace && workspaceProvider?.cleanup) try {
        await workspaceProvider.cleanup({ ...workspaceContext, signal: AbortSignal.timeout(30_000) }, workspace);
      }
      catch (error) {
        cleanupError ??= `Workspace cleanup failed: ${error instanceof Error ? error.message : String(error)}`;
        logger.error({ error }, "Workspace cleanup failed");
      }

      const leaseLost = signal.reason instanceof Error && signal.reason.message === "run_lease_lost" || failureMessage === "run_lease_lost";
      if (!leaseLost) {
        const cancellation = this.database.getRun(run.id)?.cancellation;
        if (normalized?.outcome === "unknown" && effectiveWorkspace?.initial.kind !== "directory" && effectiveWorkspace?.final
          && (effectiveWorkspace.final.revision !== effectiveWorkspace.initial.revision || !effectiveWorkspace.final.clean)) {
          normalized = { ...normalized, outcome: "acted", reason: "authoritative_workspace_change" };
        }
        const error = failureMessage ?? cleanupError;
        if (waiting && !error && !cancellation && !signal.aborted) {
          if (!this.database.deferRunFenced(lease, waiting.resourceKey, waiting.reason, waiting.availableAt)) controller.abort(new Error("run_lease_lost"));
          this.database.recordEventDecision({ eventId: run.event.id, workflowId: workflow.id, decision: "deferred", reason: waiting.reason });
          logger.info({ reason: waiting.reason, availableAt: waiting.availableAt }, "Run remains pending for eligibility; executor not started");
        } else if (retry && !cancellation && !this.shutdown.signal.aborted) {
          const delay = Math.min(30_000, 500 * 2 ** Math.max(0, attempt - 1));
          try { this.fenced(lease, run, "queued", { error, phase: "queued", outcome: normalized, availableAt: Date.now() + delay }); }
          catch { controller.abort(new Error("run_lease_lost")); }
          logger.info({ attempt, delay }, "Retrying agent run");
        } else {
          const status: RunStatus = cancellation ? "cancelled"
            : this.shutdown.signal.aborted ? "interrupted"
            : cleanupError || normalized?.outcome === "failed" ? "failed" : "completed";
          const outcome = cancellation ? { version: 1, outcome: "blocked", reason: cancellation.reason ?? "Run cancelled" } : normalized;
          const metadata = { status, attempt, succeeded: status === "completed", outcome, ...(error ? { error } : {}), ...(cleanupError ? { cleanupError } : {}) };
          const preExecutionInterruption = status === "interrupted" && phase !== "running";
          try { this.fenced(lease, run, status, { error, phase: status === "interrupted" ? phase : status, outcome,
            ...(!preExecutionInterruption ? { lifecycle: { id: `run-finalized:${run.id}`, event: "run:finalized", payload: metadata } } : {}) }); }
          catch { controller.abort(new Error("run_lease_lost")); }
        }
      }
      clearInterval(leaseTimer);
      this.database.releaseRunFenced(lease);
    }
  }

  async idle(): Promise<void> {
    for (;;) {
      await this.poll();
      if (!this.activeRuns.size && (this.stopping || !this.database.hasPendingRuns()) && !this.database.hasPendingLifecycle()) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  async stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.stopPromise = (async () => {
      this.stopping = true;
      for (const controller of this.sourceControllers.values()) controller.abort(new Error("Runtime stopping"));
      for (const owner of this.registry.capabilities.keys()) this.registry.retireInputs(owner);
      if (this.reconciliationTimer) clearTimeout(this.reconciliationTimer);
      await this.reconciliation;
      await this.watcher?.close();
      for (const source of new Set(this.registry.eventSources.values())) await source.stop?.();
      const drained = await Promise.race([
        this.idle().then(() => true),
        new Promise<false>((resolve) => setTimeout(() => resolve(false), this.config.runtime.shutdownTimeout)),
      ]);
      if (!drained) {
        this.logger.warn({ timeout: this.config.runtime.shutdownTimeout, active: this.activeRuns.size }, "Graceful shutdown timed out; interrupting active runs");
        this.shutdown.abort(new Error("Runtime shutdown deadline exceeded"));
        await Promise.allSettled([...this.activeRuns.values()].map(({ promise }) => promise));
      }
      this.shutdown.abort(new Error("Runtime stopped"));
      if (this.pollTimer) clearTimeout(this.pollTimer);
      this.pollTimer = undefined;
      if (this.historyTimer) clearInterval(this.historyTimer);
      this.historyTimer = undefined;
      for (const loaded of [...this.extensions].reverse()) if (loaded.enabled && !loaded.error) await loaded.extension.stop?.();
      this.database.close();
      this.started = false;
    })();
    return this.stopPromise;
  }
}
