import fs from "node:fs";
import path from "node:path";
import { defineExtension, z, type EventSourceContext, type HookContext, type JsonValue, type Workflow } from "@mixer/automations-sdk";
import { duration, EVENT, FIELD, hash, loadDefinitions, settingsSchema, workflowFor } from "./definitions.js";
import { attemptSchema, batchSchema, evidenceSchema, evaluationPrompt, makeBatch, parseJudgment,
  type Attempt, type Batch, type Evidence, type OpenBatch, type PendingEvidence, type Snapshot } from "./model.js";
import { renderReport, reportPath, writeReport } from "./reports.js";

const eventSchema = z.object({ batchId: z.string(), slug: z.string(), version: z.string() }).strict();
const markerSchema = z.object({ slug: z.string(), version: z.string() }).strict();
const terminal = z.enum(["completed", "failed", "cancelled", "interrupted"]);
const outcomeSchema = z.object({ outcome: z.string(), output: z.string().optional(), reason: z.string().optional() }).passthrough();

function redact(value: string): string {
  return value.replace(/\b(?:gh[opusr]_|github_pat_|sk-)[A-Za-z0-9_-]{16,}/gi, "[REDACTED]")
    .replace(/\bBearer\s+[^\s"']+/gi, "Bearer [REDACTED]");
}

function safeData(value: unknown, depth = 0): JsonValue {
  if (depth > 8) return "[nested evidence omitted]";
  if (typeof value === "string") return redact(value);
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : "[invalid number]";
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => safeData(item, depth + 1));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).slice(0, 100).map(([key, item]) =>
    [key, /token|secret|password|authorization|api[_-]?key|credential/i.test(key) ? "[REDACTED]" : safeData(item, depth + 1)]));
  return null;
}

function excerpt(value: string, bytes: number, label: string, limitations: string[]): string {
  const text = redact(value);
  if (Buffer.byteLength(text) <= bytes) return text;
  limitations.push(`${label} was truncated; absence from this excerpt is not evidence of absence.`);
  return Buffer.from(text).subarray(0, bytes).toString("utf8");
}

function logExcerpt(directory: string, runId: string, bytes: number, limitations: string[]): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(runId)) throw new Error("Invalid source run ID");
  const file = path.join(directory, `${runId}.log`);
  if (!fs.existsSync(file)) { limitations.push("Source log was unavailable."); return ""; }
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw new Error("Source log is not a regular file");
    const buffer = Buffer.alloc(Math.min(stat.size, bytes));
    fs.readSync(fd, buffer, 0, buffer.length, Math.max(0, stat.size - buffer.length));
    if (stat.size > bytes) limitations.push("Only the end of the source log was captured.");
    return redact(buffer.toString("utf8"));
  } finally { fs.closeSync(fd); }
}

function workflowVersion(workflow: Workflow): string {
  const { path: _path, ...definition } = workflow;
  return hash(definition);
}

export default defineExtension({
  name: "evaluations",
  version: "0.1.0",
  setup(api) {
    const settings = settingsSchema.parse(api.config.get());
    const root = path.join(api.paths.home, "evaluations");
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    const state = api.state.namespace();
    let context: EventSourceContext | undefined;
    let timer: NodeJS.Timeout | undefined;
    let checking: Promise<void> | undefined;

    const evidenceKey = (slug: string, runId: string) => `evidence:${slug}:${runId}`;
    const batchKey = (id: string) => `batch:${id}`;
    const batches = (): Batch[] => state.entries("batch:").map(({ value }) => batchSchema.parse(value));
    const evidence = (): Evidence[] => state.entries("evidence:").map(({ value }) => evidenceSchema.parse(value));
    const batchById = (id: string): Batch | undefined => {
      const value = state.get(batchKey(id));
      return value === undefined ? undefined : batchSchema.parse(value);
    };
    const expiration = (item: Evidence | Batch): number => Math.min(item.expiresAt,
      item.inheritRetention ? ("finishedAt" in item ? item.finishedAt : item.createdAt) + api.config.historyRetentionMs() : Infinity);

    const snapshotsFor = (batch: OpenBatch): Snapshot[] => batch.runIds.map((runId) => {
      const item = evidenceSchema.parse(state.get(evidenceKey(batch.slug, runId)));
      if (item.state !== "pending" || expiration(item) <= Date.now() || item.snapshot.workflowId !== batch.definition.workflow
        || item.snapshot.workflowVersion !== batch.workflowVersion) throw new Error("Required evaluation evidence is unavailable or expired");
      return item.snapshot;
    });

    const finishReporting = (batch: Extract<Batch, { state: "reporting" }>): void => {
      writeReport(root, batch);
      for (const runId of batch.runIds) {
        const key = evidenceKey(batch.slug, runId);
        const value = state.get(key);
        if (value !== undefined) {
          const record = evidenceSchema.parse(value);
          state.set(key, { state: "consumed", slug: record.slug, definitionVersion: record.definitionVersion,
            runId: record.runId, finishedAt: record.finishedAt, expiresAt: record.expiresAt, inheritRetention: record.inheritRetention });
        }
      }
      state.set(batchKey(batch.id), { state: "reported", id: batch.id, slug: batch.slug, reportFile: batch.reportFile,
        reportHash: batch.reportHash, createdAt: batch.createdAt, expiresAt: batch.expiresAt, inheritRetention: batch.inheritRetention });
      api.logger.info({ evaluation: batch.slug, batch: batch.id, report: batch.reportFile }, "Evaluation report saved; no automation edits applied");
    };

    const report = (batch: OpenBatch, attempt: Attempt): void => {
      const reportBody = redact(renderReport(batch, attempt));
      const record: Extract<Batch, { state: "reporting" }> = {
        ...batch, state: "reporting", reportBody, reportHash: hash(reportBody),
        reportFile: `${new Date(batch.createdAt).toISOString().replace(/[:.]/g, "-")}_${batch.id}.md`,
      };
      state.set(batchKey(batch.id), record);
      finishReporting(record);
    };

    const collectExpired = (): void => {
      const now = Date.now();
      for (const batch of batches()) {
        if (expiration(batch) > now) {
          if (batch.state === "reporting") {
            try { finishReporting(batch); }
            catch (error) { api.logger.error({ evaluation: batch.slug, error: error instanceof Error ? error.message : String(error) }, "Evaluation report remains pending; retention cleanup will continue"); }
          }
          continue;
        }
        if (batch.state === "reported" || batch.state === "reporting") {
          try {
            const folder = path.join(root, batch.slug);
            if (fs.existsSync(folder)) {
              const file = reportPath(root, batch.slug, batch.reportFile);
              if (fs.existsSync(file)) {
                const stat = fs.lstatSync(file);
                if (stat.isFile() && !stat.isSymbolicLink() && stat.size <= 1_048_576 && hash(fs.readFileSync(file, "utf8")) === batch.reportHash) fs.unlinkSync(file);
                else api.logger.warn({ evaluation: batch.slug, report: batch.reportFile }, "Preserved a modified or unsafe report during retention cleanup");
              }
            }
          } catch (error) {
            api.logger.warn({ evaluation: batch.slug, error: error instanceof Error ? error.message : String(error) }, "Could not safely remove an expired report; private evidence will still expire");
          }
        }
        state.delete(batchKey(batch.id));
      }
      for (const item of evidence()) if (expiration(item) <= now) state.delete(evidenceKey(item.slug, item.runId));
    };

    const capture = (hook: HookContext): void => {
      if (!hook.run || !hook.workflow || !terminal.safeParse(hook.run.status).success) return;
      const run = hook.run;
      const workflow = hook.workflow;
      const definitions = loadDefinitions(root);
      const relevant = definitions.evaluations.filter((evaluation) => evaluation.definition.workflow === workflow.id);
      if (!relevant.length) return;
      const finishedAt = Date.parse(run.updatedAt);
      const outcome = outcomeSchema.safeParse(hook.metadata.outcome);
      const limitations: string[] = [];
      const share = Math.floor(settings.maxRunBytes / 4);
      const data = safeData(run.activation?.data ?? run.event.data);
      const caseId = hash([run.repository, data && typeof data === "object" && !Array.isArray(data) ? data.number ?? data.url ?? run.event.id : run.event.id]);
      const snapshot: Snapshot = {
        runId: run.id, workflowId: workflow.id, workflowVersion: workflowVersion(workflow), finishedAt,
        ...(run.repository ? { repository: run.repository } : {}), eventType: run.event.type, caseId,
        status: terminal.parse(run.status), outcome: outcome.success ? outcome.data.outcome : run.status,
        workflowPrompt: excerpt(workflow.prompt, 32_768, "Automation prompt", limitations),
        eventData: excerpt(JSON.stringify(data), share, "Event data", limitations),
        output: excerpt(outcome.success ? outcome.data.output ?? outcome.data.reason ?? "" : String(hook.metadata.error ?? ""), share, "Agent output", limitations),
        logs: logExcerpt(api.paths.logs, run.id, share, limitations), limitations,
      };
      for (const evaluation of relevant) {
        const key = evidenceKey(evaluation.slug, run.id);
        if (state.get(key) !== undefined) continue;
        const pending = evidence().filter((item) => item.slug === evaluation.slug && item.state === "pending" && expiration(item) > Date.now());
        if (pending.length >= settings.maxPendingRuns) {
          api.logger.warn({ evaluation: evaluation.slug, runId: run.id }, "Evaluation pending-evidence limit reached; source run was not counted");
          continue;
        }
        const retention = evaluation.definition.evidence.retention ? duration(evaluation.definition.evidence.retention) : api.config.historyRetentionMs();
        const expiresAt = finishedAt + retention;
        if (expiresAt <= Date.now()) continue;
        state.set(key, { state: "pending", slug: evaluation.slug, definitionVersion: evaluation.version,
          runId: run.id, finishedAt, expiresAt, inheritRetention: !evaluation.definition.evidence.retention, snapshot });
      }
    };

    const activeFor = (hook: HookContext): Extract<Batch, { state: "active" }> | undefined => {
      if (hook.event?.source !== "evaluations" || hook.event.type !== EVENT || !hook.run) return;
      const parsed = eventSchema.safeParse(hook.event.data);
      if (!parsed.success) return;
      const batch = batchById(parsed.data.batchId);
      if (batch?.state === "active" && batch.runId === hook.run.id) return batch;
    };

    api.workflows.registerDiscovery("evaluations", {
      watchPaths: [root],
      discover(knownWorkflows) {
        const definitions = loadDefinitions(root);
        const valid = definitions.evaluations.filter((evaluation) => {
          if (knownWorkflows.some((workflow) => workflow.id === evaluation.definition.workflow)) return true;
          definitions.errors.push({ path: evaluation.file, errors: [`Target automation not found or invalid: ${evaluation.definition.workflow}`] });
          return false;
        });
        return { workflows: valid.map(workflowFor), errors: definitions.errors };
      },
    });

    const adopt = (hook: HookContext): void => {
      if (hook.event?.source !== "evaluations" || hook.event.type !== EVENT || !hook.run) return;
      const data = eventSchema.parse(hook.event.data);
      const marker = markerSchema.safeParse(hook.workflow?.extensions?.[FIELD]);
      if (!marker.success || marker.data.slug !== data.slug || marker.data.version !== data.version) return;
      const batch = batchById(data.batchId);
      if (batch?.state === "pending") state.set(batchKey(batch.id), { ...batch, state: "active", runId: hook.run.id, attempt: { kind: "none" } });
    };
    api.hooks.on("run:created", adopt);
    // Admission may have committed before a crash prevented run:created delivery.
    api.hooks.on("run:before", adopt);

    api.hooks.on("agent:before", (hook) => {
      const marker = hook.workflow?.extensions?.[FIELD];
      if (marker === undefined) return;
      const identity = markerSchema.parse(marker);
      const batch = activeFor(hook);
      if (!batch || batch.slug !== identity.slug || batch.definitionVersion !== identity.version) {
        hook.cancelled = true; hook.reason = "Evaluation runs require an admitted, version-matched batch"; return;
      }
      try {
        const prompt = evaluationPrompt(batch, snapshotsFor(batch));
        if (Buffer.byteLength(prompt) > settings.maxPromptBytes) throw new Error("Evaluation evidence exceeds the configured prompt budget");
        hook.instructions.push(prompt);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        state.set(batchKey(batch.id), { ...batch, attempt: { kind: "inconclusive", reason } });
        hook.cancelled = true; hook.reason = reason;
      }
    });

    api.hooks.on("agent:after", (hook) => {
      const batch = activeFor(hook);
      if (!batch) return;
      let attempt: Attempt;
      try {
        attempt = { kind: "judgment", judgment: parseJudgment(typeof hook.metadata.output === "string" ? hook.metadata.output : "", batch, snapshotsFor(batch)) };
      } catch (error) { attempt = { kind: "error", reason: redact(error instanceof Error ? error.message : String(error)) }; }
      state.set(batchKey(batch.id), { ...batch, attempt });
    });

    api.hooks.on("run:finalized", (hook) => {
      if (hook.workflow?.extensions?.[FIELD] !== undefined || hook.event?.source === "evaluations") {
        adopt(hook);
        const data = eventSchema.safeParse(hook.event?.data);
        const existing = data.success ? batchById(data.data.batchId) : undefined;
        if (existing?.state === "reporting") { finishReporting(existing); return; }
        const batch = activeFor(hook);
        if (!batch) return;
        const outcome = outcomeSchema.safeParse(hook.metadata.outcome);
        const failure = hook.run?.status !== "completed" || (outcome.success && ["failed", "blocked"].includes(outcome.data.outcome));
        const attempt = batch.attempt.kind === "inconclusive" ? batch.attempt : failure
          ? { kind: "error" as const, reason: redact(outcome.success ? outcome.data.reason ?? "Evaluation execution failed" : "Evaluation execution failed") }
          : batch.attempt.kind === "none" ? { kind: "error" as const, reason: "The evaluator did not produce a valid result" } : batch.attempt;
        report(batch, attemptSchema.parse(attempt));
        return;
      }
      // Evidence collection must never change or delay the source run's terminal outcome.
      try { capture(hook); }
      catch (error) { api.logger.error({ error: error instanceof Error ? error.message : String(error) }, "Evaluation evidence capture failed; source run unchanged"); }
    });

    const check = async (): Promise<void> => {
      if (!context || context.signal.aborted) return;
      collectExpired();
      const { evaluations } = loadDefinitions(root);
      for (const evaluation of evaluations) {
        context.signal.throwIfAborted();
        const open = batches().find((batch) => batch.slug === evaluation.slug && batch.state !== "reported");
        if (open?.state === "active" || open?.state === "reporting") continue;
        let batch: Extract<Batch, { state: "pending" }> | undefined = open?.state === "pending" ? open : undefined;
        if (batch && batch.definitionVersion !== evaluation.version) {
          report(batch, { kind: "inconclusive", reason: "The evaluation definition changed before this batch was admitted" }); continue;
        }
        if (!batch) {
          const pending = evidence().filter((item): item is PendingEvidence => item.state === "pending" && item.slug === evaluation.slug
            && item.snapshot.workflowId === evaluation.definition.workflow && expiration(item) > Date.now()).sort((a, b) => a.finishedAt - b.finishedAt || a.runId.localeCompare(b.runId));
          const groups = new Map<string, PendingEvidence[]>();
          for (const item of pending) { const group = groups.get(item.snapshot.workflowVersion) ?? []; group.push(item); groups.set(item.snapshot.workflowVersion, group); }
          const records = [...groups.values()].find((items) => items.length >= evaluation.definition.afterRuns)?.slice(0, evaluation.definition.afterRuns);
          if (!records) continue;
          const retention = evaluation.definition.evidence.retention ? duration(evaluation.definition.evidence.retention) : api.config.historyRetentionMs();
          batch = makeBatch(evaluation.slug, evaluation.definition, evaluation.version, records, retention, Date.now());
          state.set(batchKey(batch.id), batch);
        }
        if (batch.evidenceExpiresAt <= Date.now()) {
          report(batch, { kind: "inconclusive", reason: "Batch evidence expired before evaluation; no model was invoked" }); continue;
        }
        const result = await context.emit({ id: `evaluations:${batch.id}`, type: EVENT, source: "evaluations", timestamp: new Date(batch.createdAt).toISOString(),
          data: { batchId: batch.id, slug: batch.slug, version: batch.definitionVersion } });
        if (typeof result === "object" && result.status === "accepted" && !result.runIds?.length) {
          report(batch, { kind: "error", reason: "No valid evaluator workflow matched this batch; check automations validate" });
        }
      }
    };

    const tick = async (): Promise<void> => {
      if (checking) return checking;
      checking = check();
      try { await checking; }
      catch (error) { api.logger.error({ error: error instanceof Error ? error.message : String(error) }, "Evaluation eligibility check failed"); }
      finally { checking = undefined; }
    };

    api.events.registerSource(EVENT, {
      configSchema: markerSchema,
      async start(next) {
        context = next;
        await tick();
        if (next.signal.aborted) return;
        timer = setInterval(() => void tick(), Math.min(duration(settings.pollInterval), 2_147_483_647));
        timer.unref();
        next.signal.addEventListener("abort", () => { if (timer) clearInterval(timer); timer = undefined; }, { once: true });
      },
      match(event, config) {
        if (event.source !== "evaluations") return false;
        const data = eventSchema.safeParse(event.data);
        const marker = markerSchema.parse(config);
        if (!data.success || data.data.slug !== marker.slug || data.data.version !== marker.version) return false;
        const batch = batchById(data.data.batchId);
        return batch !== undefined && ["pending", "active"].includes(batch.state);
      },
      async stop() { if (timer) clearInterval(timer); timer = undefined; context = undefined; await checking; },
    });

    api.commands.register({
      name: "evaluations", description: "List and validate report-only evaluation definitions",
      run(args) {
        const [command = "list", ...extra] = args;
        if (!["list", "validate", "status"].includes(command) || extra.some((arg) => arg !== "--json")) {
          throw new Error("Usage: mixer-automations evaluations list|validate|status [--json]");
        }
        const definitions = loadDefinitions(root);
        if (command === "validate") {
          if (definitions.errors.length) throw new Error(definitions.errors.map((error) => `${error.path}: ${error.errors.join("; ")}`).join("\n"));
          console.log(`${definitions.evaluations.length} valid evaluation definitions`); return;
        }
        const records = evidence();
        const batchRecords = batches();
        const result = definitions.evaluations.map((evaluation) => {
          const versions = new Map<string, number>();
          for (const record of records) if (record.slug === evaluation.slug && record.state === "pending"
            && record.snapshot.workflowId === evaluation.definition.workflow && expiration(record) > Date.now()) {
            versions.set(record.snapshot.workflowVersion, (versions.get(record.snapshot.workflowVersion) ?? 0) + 1);
          }
          return { name: evaluation.slug, workflow: evaluation.definition.workflow,
            agent: evaluation.definition.agent, model: evaluation.definition.model ?? null, afterRuns: evaluation.definition.afterRuns,
            pendingRuns: Math.max(0, ...versions.values()), versions: [...versions].map(([version, runs]) => ({ version, runs })),
            reports: batchRecords.filter((record) => record.slug === evaluation.slug && record.state === "reported" && expiration(record) > Date.now()).length,
            activeBatch: batchRecords.filter((record) => record.slug === evaluation.slug && record.state !== "reported" && expiration(record) > Date.now())
              .map((record) => ({ id: record.id, state: record.state, runId: record.state === "active" ? record.runId : null }))[0] ?? null,
            directory: path.join(root, evaluation.slug, "reports") };
        });
        if (extra.includes("--json")) console.log(JSON.stringify({ evaluations: result, errors: definitions.errors }, null, 2));
        else {
          for (const item of result) console.log(`${item.name}: ${item.pendingRuns}/${item.afterRuns} pending runs, ${item.reports} reports (${item.workflow})`);
          for (const error of definitions.errors) console.error(`${error.path}: ${error.errors.join("; ")}`);
          if (!result.length && !definitions.errors.length) console.log(`No evaluations. Create ${root}/<name>/evaluation.yaml`);
        }
      },
    });
  },
});
