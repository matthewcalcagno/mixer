import fs from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { defineExtension, z, type StepRecord, type WorkflowRunnerContext, type WorkflowRunnerResult } from "@mixer/automations-sdk";
import { stepsEnvironmentSchema, stepsSchema, type StepsConfiguration } from "./schema.js";

export { stepsSchema } from "./schema.js";

function containedDirectory(root: string, directory: string): string {
  const realRoot = fs.realpathSync(root);
  const requested = path.resolve(root, directory);
  const cwd = fs.realpathSync(requested);
  const relative = path.relative(realRoot, cwd);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error("working-directory escapes the workspace");
  if (!fs.statSync(cwd).isDirectory()) throw new Error("working-directory is not a directory");
  return requested;
}

export async function runSteps(context: WorkflowRunnerContext, config: StepsConfiguration, home: string, temporary: string, providerEnv: Record<string, string> = {}): Promise<WorkflowRunnerResult> {
  if (context.cli) {
    const bin = path.join(temporary, "bin");
    fs.mkdirSync(bin);
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
    fs.writeFileSync(path.join(bin, "mixer-automations"), `#!/bin/sh\nexec ${[context.cli.command, ...context.cli.args].map(quote).join(" ")} "$@"\n`, { mode: 0o700 });
    context.workspace.environment = { ...context.workspace.environment,
      PATH: `${bin}${path.delimiter}${context.workspace.environment?.PATH ?? process.env.PATH ?? ""}` };
  }
  const eventFile = path.join(temporary, "event.json");
  fs.writeFileSync(eventFile, JSON.stringify({ version: 1, runId: context.run.id, repository: context.run.repository,
    workflow: { extensions: context.workflow.extensions ?? {} }, event: context.event }), { mode: 0o600 });
  let failed = false;
  let selectedCount = 0;
  let failureReason: string | undefined;
  for (const [ordinal, step] of config.steps.entries()) {
    const id = step.id ?? `step_${ordinal + 1}`;
    context.recordStep({ id, ordinal, name: step.name ?? id, attempt: 0, status: "pending" });
  }
  for (const [ordinal, step] of config.steps.entries()) {
    context.signal.throwIfAborted();
    const id = step.id ?? `step_${ordinal + 1}`;
    const record: StepRecord = { id, ordinal, name: step.name ?? id, attempt: 0, status: "skipped" };
    const selected = step.if === "always" || (step.if === "failure" ? failed : !failed);
    if (!selected) {
      context.recordStep({ ...record, finishedAt: new Date().toISOString() });
      context.logger.info({ stepId: id, condition: step.if }, "Step skipped");
      continue;
    }
    selectedCount++;
    const shell = step.shell ?? config.defaults.run.shell;
    const file = path.join(temporary, `${id}.sh`);
    fs.writeFileSync(file, step.run, { mode: 0o600 });
    const stepDeadline = Math.min(Date.parse(context.deadline), Date.now() + (step.timeout ?? config.defaults.run.timeout ?? Number.MAX_SAFE_INTEGER));
    const attempts = step.retry?.maxAttempts ?? 1;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      context.signal.throwIfAborted();
      const current: StepRecord = { ...record, attempt, status: "running", startedAt: new Date().toISOString() };
      context.recordStep(current);
      const logger = context.logger.child({ stepId: id, attempt });
      logger.info({ name: current.name }, "Step started");
      try {
        if (Date.now() >= stepDeadline) throw new Error("Step deadline exceeded");
        const cwd = containedDirectory(context.workspace.path, step["working-directory"] ?? config.defaults.run["working-directory"]);
        const result = await context.execution.run({
          command: shell, args: shell === "bash" ? ["--noprofile", "--norc", "-e", "-o", "pipefail", file] : ["-e", file],
          cwd, signal: context.signal, captureOutput: false, timeout: Math.max(1, stepDeadline - Date.now()),
          noOutputTimeout: Math.min(step["no-output-timeout"] ?? config.defaults.run["no-output-timeout"] ?? context.noOutputTimeout, Math.max(1, stepDeadline - Date.now())),
          env: { ...providerEnv, ...config.env, ...step.env, ...context.stepEnvironment(id), MIXER_AUTOMATIONS_HOME: home,
            MIXER_AUTOMATIONS_WORKFLOW_ID: context.workflow.id, MIXER_AUTOMATIONS_REPOSITORY: context.run.repository ?? "",
            MIXER_AUTOMATIONS_WORKSPACE: context.workspace.path, MIXER_AUTOMATIONS_EVENT_FILE: eventFile,
            MIXER_AUTOMATIONS_STEP_ID: id, MIXER_AUTOMATIONS_ATTEMPT: String(attempt), MIXER_AUTOMATIONS_STEP_DEADLINE: new Date(stepDeadline).toISOString() },
          onStdout: (chunk) => logger.info({ stream: "stdout", chunk }),
          onStderr: (chunk) => logger.warn({ stream: "stderr", chunk }),
        });
        context.signal.throwIfAborted();
        current.exitCode = result.exitCode;
        if (result.exitCode !== 0) throw new Error(result.errorCode ? `Could not launch ${shell}: ${result.errorCode}` : `Step exited with code ${result.exitCode}`);
        context.recordStep({ ...current, status: "succeeded", finishedAt: new Date().toISOString() });
        logger.info({}, "Step succeeded");
        break;
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        context.recordStep({ ...current, status: context.signal.aborted ? context.abortStatus() : "failed", error: reason,
          finishedAt: new Date().toISOString(), tolerated: step["continue-on-error"] });
        logger.error({ error: reason }, "Step failed");
        context.signal.throwIfAborted();
        const wait = step.retry?.delay ?? 0;
        if (attempt < attempts && Date.now() + wait < stepDeadline) { await delay(wait, undefined, { signal: context.signal }); continue; }
        if (!step["continue-on-error"]) { failed = true; failureReason ??= `${id}: ${reason}`; }
        break;
      }
    }
  }
  return { version: 1, outcome: failed ? "failed" : selectedCount ? "unknown" : "no-op", reason: failed ? failureReason : selectedCount ? "scripted_steps_completed" : "no_steps_selected" };
}

export default defineExtension({
  name: "steps",
  setup(api) {
    const provider = z.object({ env: stepsEnvironmentSchema.default({}) }).strict().parse(api.config.get());
    const ownerSchema = z.object({ version: z.literal(1), runId: z.string() }).strict();
    api.hooks.on("run:finalized", (context) => {
      if (!context.run || context.workflow?.task?.runner !== "steps") return;
      const prefix = `steps-${context.run.id}-`;
      for (const entry of fs.readdirSync(api.paths.state, { withFileTypes: true })) {
        if (!entry.isDirectory() || !entry.name.startsWith(prefix)) continue;
        const directory = path.join(api.paths.state, entry.name);
        const ownerFile = path.join(directory, "owner.json");
        if (!fs.existsSync(ownerFile)) continue;
        try {
          const owner = ownerSchema.parse(JSON.parse(fs.readFileSync(ownerFile, "utf8")));
          if (owner.runId === context.run.id) fs.rmSync(directory, { recursive: true, force: true });
        } catch (error) { api.logger.warn({ directory, error: error instanceof Error ? error.message : String(error) }, "Could not clean scripted context"); }
      }
    });
    api.workflows.registerRunner("steps", {
      schema: stepsSchema,
      async run(context) {
        // The snapshot is a serialization boundary; validate it before execution.
        const config = stepsSchema.parse(context.configuration);
        const temporary = fs.mkdtempSync(path.join(api.paths.state, `steps-${context.run.id}-`));
        fs.chmodSync(temporary, 0o700);
        fs.writeFileSync(path.join(temporary, "owner.json"), JSON.stringify({ version: 1, runId: context.run.id }), { mode: 0o600 });
        try { return await runSteps(context, config, api.paths.home, temporary, provider.env); }
        finally { fs.rmSync(temporary, { recursive: true, force: true }); }
      },
    });
  },
});
