import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { existsSync, realpathSync } from "node:fs";
import {
  createEmbeddedEngine,
  configurationSchema,
  parseWorkflow,
  startEmbeddedControl,
  StateDatabase,
  validateWorkflow,
  type Runtime,
} from "@mixer/automations-engine";
import type { Server } from "node:net";
import { z } from "zod";
import { runSchema, runResultSchema, type runtimeStatusRpc } from "../shared/contracts.js";
import { importRoboPlane, readLog } from "./import.js";
import type { WorkflowStoreValidation } from "./workflows.js";
import { initialAutomationConfiguration } from "../shared/configuration-template.js";

type Run = z.output<typeof runSchema>;
type EngineRun = NonNullable<ReturnType<StateDatabase["getRun"]>>;
const activeStatuses = new Set(["queued", "preparing", "running", "waiting"]);
const assistantPreferences = z
  .object({
    extensions: z
      .object({
        mixer: z.object({ agentProvider: z.string().optional() }).passthrough().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();
function workflowValidationErrors(...input: Parameters<typeof validateWorkflow>) {
  return validateWorkflow(...input).map((message) =>
    message === "Unknown event source: schedule"
      ? "Scheduling is disabled. Enable extensions.scheduler.enabled in config.json, then restart Automations."
      : message,
  );
}
function processIsAlive(pid: number) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") return false;
    throw error;
  }
}
const json = (value: unknown) => z.json().parse(JSON.parse(JSON.stringify(value)));
const stableId = (value: string) => {
  const hash = createHash("sha256").update(value).digest("hex");
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
};

export function createEngineRuntime(hostHome: string) {
  const home = realpathSync(hostHome);
  const internal = join(home, ".mixer-automations");
  const legacyHistory = join(home, "automation-state", "runs");
  let engine: Runtime | undefined;
  let registry: Runtime["registry"] | undefined;
  let controlServer: Server | undefined;
  let ownsPid = false;
  const pidFile = join(internal, "state", "roboplane.pid");
  let startupError: string | undefined;
  let paused = false;
  let migrationNotice: string | undefined;
  const activationFile = join(internal, "engine-started.json");
  let controlOperation = Promise.resolve();

  async function markActivated() {
    await writeFile(
      activationFile,
      JSON.stringify({ version: 1, activatedAt: new Date().toISOString() }),
      { mode: 0o600 },
    );
  }
  async function activate(current: Runtime) {
    await current.start();
    controlServer = await startEmbeddedControl(current);
    await markActivated();
    paused = false;
    migrationNotice = undefined;
  }
  async function launch(activateSources = true) {
    await mkdir(join(home, "automations"), { recursive: true, mode: 0o700 });
    const config = join(home, "automations", "config.json");
    await writeFile(config, initialAutomationConfiguration, { flag: "wx", mode: 0o600 }).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code !== "EEXIST") throw error;
      },
    );
    let candidate: Runtime | undefined;
    try {
      await mkdir(join(internal, "state"), { recursive: true, mode: 0o700 });
      const previousPid = await readFile(pidFile, "utf8").catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      });
      if (previousPid !== undefined) {
        const pid = Number(previousPid);
        if (processIsAlive(pid))
          throw new Error("Mixer Automations is already running for this host.");
        await rm(pidFile, { force: true });
      }
      await writeFile(pidFile, String(process.pid), { flag: "wx", mode: 0o600 });
      ownsPid = true;
      candidate = createEmbeddedEngine(home);
      await candidate.initialize();
      registry = candidate.registry;
      const failures = candidate.extensions.filter((loaded) => loaded.enabled && loaded.error);
      if (failures.length)
        throw new Error(
          failures.map((loaded) => `${loaded.extension.name}: ${loaded.error?.message}`).join("\n"),
        );
      if (activateSources) await activate(candidate);
      engine = candidate;
      startupError = undefined;
      paused = !activateSources;
    } catch (error) {
      await candidate?.stop();
      if (ownsPid) {
        await rm(pidFile, { force: true });
        ownsPid = false;
      }
      startupError = error instanceof Error ? error.message : String(error);
      throw error;
    }
  }
  const reviewRequired = existsSync(join(home, "automation-state")) && !existsSync(activationFile);
  if (reviewRequired) migrationNotice = "Review configuration, then Start Automations.";
  const ready = launch(!reviewRequired).catch(() => undefined);
  async function stop() {
    if (controlServer) {
      const server = controlServer;
      controlServer = undefined;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    if (engine) {
      const current = engine;
      engine = undefined;
      await current.stop();
    }
    if (ownsPid) {
      await rm(pidFile, { force: true });
      ownsPid = false;
    }
    paused = true;
  }
  async function running() {
    await ready;
    if (!engine || paused)
      throw new Error(startupError ?? "Start Mixer Automations before running workflows.");
    return engine;
  }
  async function workflowRegistry() {
    await ready;
    if (!registry) throw new Error(startupError ?? "The workflow engine has not initialized.");
    return registry;
  }
  async function withDatabase<T>(read: (database: StateDatabase) => Promise<T> | T): Promise<T> {
    await ready;
    if (engine) return read(engine.database);
    const database = new StateDatabase(join(internal, "state"), { readonly: true });
    try {
      return await read(database);
    } finally {
      database.close();
    }
  }
  async function projectRun(
    run: EngineRun,
    database: StateDatabase,
    includeOutput: boolean,
  ): Promise<Run> {
    const parsed = runResultSchema.safeParse(run.outcome);
    const result = parsed.success ? parsed.data : undefined;
    let projectedStatus: Run["status"] = "running";
    if (run.status === "queued") projectedStatus = "queued";
    else if (run.status === "completed") projectedStatus = "succeeded";
    else if (run.status === "failed") projectedStatus = "failed";
    else if (run.status === "interrupted" || run.status === "cancelled")
      projectedStatus = "interrupted";
    return runSchema.parse({
      id: run.id,
      path: run.workflowId,
      name: database.getWorkflowSnapshot(run.id)?.name ?? run.workflowId,
      repository: run.repository,
      revision: run.effectiveWorkspace?.initial.revision,
      trigger: ["github", "jira", "webhook", "schedule"].includes(run.event.source)
        ? run.event.source
        : "manual",
      sourceStatus: run.status,
      outcome: result?.outcome,
      result,
      status: projectedStatus,
      createdAt: Date.parse(run.createdAt),
      finishedAt: activeStatuses.has(run.status) ? undefined : Date.parse(run.updatedAt),
      error: run.error,
      output: includeOutput ? await readLog(join(internal, "logs", `${run.id}.log`)) : "",
      engine: includeOutput
        ? {
            steps: database.listSteps(run.id).map(json),
            actions: database.listActions(run.id).map(json),
            event: json(run.event),
            workspace: run.effectiveWorkspace ? json(run.effectiveWorkspace) : undefined,
            verification: (run.verification ?? []).map(json),
          }
        : undefined,
    });
  }
  async function legacyRuns() {
    const files = await readdir(legacyHistory).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    const results: Run[] = [];
    for (const file of files.filter((name) => /^[a-f0-9-]+\.json$/.test(name))) {
      const parsed = runSchema.safeParse(
        JSON.parse(await readFile(join(legacyHistory, file), "utf8")),
      );
      if (parsed.success) results.push(parsed.data);
    }
    return results;
  }
  async function legacyRun(id: string) {
    const run = (await legacyRuns()).find((item) => item.id === id);
    if (!run) throw new Error("Automation run was not found.");
    return run;
  }
  async function status(): Promise<z.input<typeof runtimeStatusRpc.output>> {
    await ready;
    const loaded = engine?.extensions ?? [];
    const rows = engine?.database.listRuns(1000) ?? [];
    const health = engine?.database.listSourceHealth() ?? [];
    const errors = health
      .filter((source) => source.error)
      .map((source) => ({
        source: source.source,
        message: source.error ?? "Source health failure.",
      }));
    if (startupError) errors.push({ source: "engine", message: startupError });
    return {
      paused: paused || !engine,
      notices: migrationNotice ? [{ source: "migration", message: migrationNotice }] : [],
      listening:
        !paused &&
        loaded.some((item) => item.extension.name === "webhooks" && item.enabled && !item.error),
      pending: rows.filter((run) => activeStatuses.has(run.status)).length,
      schedulesEnabled:
        !paused &&
        loaded.some((item) => item.extension.name === "scheduler" && item.enabled && !item.error),
      integrations: loaded.map((item) => ({
        name: item.extension.name,
        ready: item.enabled && !item.error,
        message:
          item.error?.message ??
          (item.enabled ? "Loaded by Mixer Automations engine." : "Disabled in config.json."),
      })),
      errors,
    };
  }
  const validation: WorkflowStoreValidation = {
    async describe(root, path) {
      const current = await workflowRegistry();
      const workflow = parseWorkflow(join(root, path), root, current);
      const errors = workflow.disabled ? [] : workflowValidationErrors(workflow, current);
      if (errors.length) throw new Error(errors.join("\n"));
      return {
        name: workflow.name ?? workflow.id,
        disabled: workflow.disabled ?? false,
        repository: workflow.repository,
        on: workflow.on,
      };
    },
    async validate(path, content) {
      const root = join(internal, "validation", randomUUID());
      const file = join(root, path);
      await mkdir(dirname(file), { recursive: true, mode: 0o700 });
      try {
        await writeFile(file, content, { mode: 0o600, flag: "wx" });
        if (path === "config.json") configurationSchema.parse(JSON.parse(content));
        else {
          const current = await workflowRegistry();
          const workflow = parseWorkflow(file, root, current);
          const errors = workflow.disabled ? [] : workflowValidationErrors(workflow, current);
          if (errors.length) throw new Error(errors.join("\n"));
        }
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  };
  return {
    validation,
    status,
    async configurationInfo(fallback: string) {
      await ready;
      try {
        // Choosing an editing agent must not resolve workflow integration credentials.
        const values = assistantPreferences.parse(
          JSON.parse(await readFile(join(home, "automations", "config.json"), "utf8")),
        );
        return {
          fileConfigured: true,
          agentProvider: values.extensions?.mixer?.agentProvider?.trim() || fallback,
          error: startupError,
        };
      } catch (error) {
        return {
          fileConfigured: true,
          agentProvider: fallback,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
    async start(path: string) {
      const current = await running();
      current.reloadWorkflows();
      const run = await current.submitRun(path);
      return { id: run.id };
    },
    async replay(id: string, workflow: "snapshot" | "current") {
      const current = await running();
      current.reloadWorkflows();
      return { id: current.replayRun(id, { workflow }).id };
    },
    async cancel(id: string, reason: string) {
      return { cancelled: (await running()).cancelRun(id, reason) };
    },
    async list() {
      await ready;
      const records = existsSync(join(internal, "state", "roboplane.db"))
        ? await withDatabase(async (database) =>
            Promise.all(database.listRuns(200).map((run) => projectRun(run, database, false))),
          )
        : [];
      return {
        runs: [...records, ...(await legacyRuns())]
          .sort((a, b) => b.createdAt - a.createdAt)
          .slice(0, 200),
      };
    },
    async get(id: string) {
      await ready;
      if (!existsSync(join(internal, "state", "roboplane.db"))) return legacyRun(id);
      return withDatabase(async (database) => {
        const run = database.getRun(id);
        if (run) return projectRun(run, database, true);
        return legacyRun(id);
      });
    },
    async import(source: string) {
      await ready;
      await mkdir(legacyHistory, { recursive: true, mode: 0o700 });
      return importRoboPlane(
        source,
        join(home, "automations"),
        async (run) => {
          try {
            await writeFile(join(legacyHistory, `${run.id}.json`), JSON.stringify(run), {
              flag: "wx",
              mode: 0o600,
            });
            return true;
          } catch (error) {
            if (error instanceof Error && "code" in error && error.code === "EEXIST") return false;
            throw error;
          }
        },
        stableId,
      );
    },
    control(action: "start" | "stop" | "restart") {
      const operation = controlOperation.then(async () => {
        await ready;
        if (action !== "start" && engine) await stop();
        if (action !== "stop" && !engine) await launch();
        else if (action === "start" && engine && paused) await activate(engine);
        return undefined;
      });
      controlOperation = operation.catch(() => undefined);
      return operation.then(status);
    },
    async close() {
      await ready;
      await controlOperation;
      await stop();
    },
  };
}
