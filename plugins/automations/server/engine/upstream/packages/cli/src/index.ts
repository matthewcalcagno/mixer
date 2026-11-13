#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import net from "node:net";
import { Command } from "commander";
import { z } from "zod";
import { Runtime, StateDatabase, actionRequestSchema, ensureHome, ensureHomeIgnore, loadConfig, parseDuration, parseWorkflow, resolveWorkflowFile, validateWorkflow, resolvePaths, setExtensionEnabled } from "@roboplane/core";
import { stepsSchema } from "@roboplane/extension-steps";
import { BUILTINS } from "./builtins.js";
import { inputOptions, repositoryOption, submissionInput, type InputOptions } from "./input.js";
import { printOverview } from "./status.js";
import type { Workflow } from "@mixer/automations-sdk";

const VERSION = "0.1.0";
function runtime(options: { consoleLogs?: boolean } = {}): Runtime {
  return new Runtime({ ...options, builtins: BUILTINS, cli: { command: process.execPath, args: [...process.execArgv, fileURLToPath(import.meta.url)] } });
}
function openState(): StateDatabase {
  const paths = resolvePaths(); ensureHome(paths);
  return new StateDatabase(paths.state);
}

function taskOutcome(value: unknown): string | undefined {
  if (value && typeof value === "object" && "outcome" in value && typeof value.outcome === "string") return value.outcome;
  return undefined;
}

function runSucceeded(run: { status: string; outcome?: unknown } | undefined): boolean {
  if (run?.status !== "completed") return false;
  const outcome = taskOutcome(run.outcome);
  return outcome !== "blocked" && outcome !== "failed";
}

function pidFile(): string {
  const paths = resolvePaths();
  return path.join(paths.state, "roboplane.pid");
}

function readPid(options: { cleanup?: boolean } = {}): number | undefined {
  try {
    const pid = Number(fs.readFileSync(pidFile(), "utf8"));
    if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
    process.kill(pid, 0);
    return pid;
  } catch {
    if (options.cleanup !== false) try { fs.unlinkSync(pidFile()); } catch {}
    return undefined;
  }
}

async function waitForStop(): Promise<boolean> {
  const timeout = loadConfig(resolvePaths()).runtime.shutdownTimeout + 5_000;
  const deadline = Date.now() + timeout;
  while (readPid() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
  return !readPid();
}

function controlPath(): string {
  if (process.env.MIXER_AUTOMATIONS_EMBEDDED === "1" && process.env.MIXER_AUTOMATIONS_CONTROL_SOCKET) return process.env.MIXER_AUTOMATIONS_CONTROL_SOCKET;
  const state = resolvePaths().state;
  return process.platform === "win32" ? `\\\\.\\pipe\\roboplane-${Buffer.from(state).toString("hex")}` : path.join(state, "roboplane.sock");
}

const controlResponseSchema = z.object({
  ok: z.boolean(), eventId: z.string().optional(), runId: z.string().optional(), runIds: z.array(z.string()).readonly().optional(),
  sourceRunId: z.string().optional(), sourceEventId: z.string().optional(), rootRunId: z.string().optional(),
  workflowMode: z.enum(["snapshot", "current"]).optional(), status: z.string().optional(), reason: z.string().optional(),
  cancelled: z.boolean().optional(), error: z.string().optional(), extension: z.string().optional(),
  enabled: z.boolean().optional(), result: z.unknown().optional(),
}).passthrough();
type ControlResponse = z.infer<typeof controlResponseSchema>;

function controlRequest(request: Record<string, unknown>, timeout = 15_000): Promise<ControlResponse> {
  ensureHome(resolvePaths());
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(controlPath());
    let response = "";
    socket.setEncoding("utf8");
    socket.once("connect", () => socket.end(`${JSON.stringify(request)}\n`));
    socket.setTimeout(timeout, () => socket.destroy(new Error("Control request timed out")));
    socket.on("data", (chunk) => { response += chunk; if (response.length > 1024 * 1024) socket.destroy(new Error("Control response is too large")); });
    socket.once("error", (error) => reject(new Error(`Could not contact the Mixer Automations daemon: ${error.message}`)));
    socket.once("end", () => {
      try { resolve(controlResponseSchema.parse(JSON.parse(response))); }
      catch { reject(new Error("Mixer Automations daemon returned an invalid response")); }
    });
  });
}

async function startControlServer(instance: Runtime): Promise<net.Server> {
  const socketPath = controlPath();
  if (process.platform !== "win32") try { fs.unlinkSync(socketPath); } catch {}
  const server = net.createServer({ allowHalfOpen: true }, (socket) => {
    socket.on("error", (error) => instance.logger.warn({ error: error.message }, "Control connection failed"));
    let input = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      input += chunk;
      if (input.length > 64 * 1024) socket.destroy(new Error("Control request is too large"));
    });
    socket.on("end", () => {
      void (async () => {
        try {
          const request = JSON.parse(input) as { command?: string; runId?: string; eventId?: string; workflow?: "snapshot" | "current"; reason?: string; extension?: string };
          if (request.command === "ping") {
            z.object({ command: z.literal("ping") }).strict().parse(request);
            socket.end(`${JSON.stringify({ ok: true, status: "ready" } satisfies ControlResponse)}\n`);
            return;
          }
          if (request.command === "webhooks") {
            const submission = z.object({ command: z.literal("webhooks"), input: z.unknown() }).strict().parse(request);
            const result = await instance.submitInput("webhooks.control", submission.input);
            socket.end(`${JSON.stringify({ ok: result.kind !== "rejected" && !(result.kind === "event" && result.result.status === "rejected"), result } satisfies ControlResponse)}\n`);
            return;
          }
          if (request.command === "submit") {
            const submission = z.object({ command: z.literal("submit"), identifier: z.string().min(1), input: z.unknown().optional(),
              repository: z.string().optional(), token: z.string().optional(), inheritEvent: z.boolean().optional(), handoffKey: z.string().min(1).max(200).optional() }).strict().parse(request);
            const run = await instance.submitRun(submission.identifier, submission);
            socket.end(`${JSON.stringify({ ok: true, runId: run.id, status: "accepted" } satisfies ControlResponse)}\n`);
            return;
          }
          if (request.command === "query") {
            const query = z.object({ command: z.literal("query"), name: z.string().min(1), args: z.array(z.string()).max(100), token: z.string().min(1) }).strict().parse(request);
            const result = await instance.queryCommand(query.name, query.args, query.token);
            socket.end(`${JSON.stringify({ ok: true, result } satisfies ControlResponse)}\n`);
            return;
          }
          if (request.command === "request-action") {
            const submission = actionRequestSchema.extend({ command: z.literal("request-action"), token: z.string().min(1) }).parse(request);
            const result = await instance.requestAction(submission.name, submission.input, { token: submission.token, requestKey: submission.requestKey });
            socket.end(`${JSON.stringify({ ok: result.status === "proposed", result, ...(result.status === "rejected" ? { error: result.reason } : {}) } satisfies ControlResponse)}\n`);
            return;
          }
          if (request.command === "reload-extension" && request.extension) {
            const loaded = await instance.reloadExtension(request.extension);
            socket.end(`${JSON.stringify({ ok: true, extension: loaded.extension.name, enabled: loaded.enabled } satisfies ControlResponse)}\n`);
            return;
          }
          if (request.command === "cancel" && request.runId) {
            const cancelled = instance.cancelRun(request.runId, request.reason);
            socket.end(`${JSON.stringify({ ok: cancelled, runId: request.runId, cancelled,
              ...(cancelled ? {} : { error: "Run is not active" }) } satisfies ControlResponse)}\n`);
            return;
          }
          if (request.command === "reroute" && request.eventId) {
            const result = await instance.rerouteEvent(request.eventId);
            socket.end(`${JSON.stringify({
              ok: result.status === "accepted", sourceEventId: request.eventId, ...result,
            } satisfies ControlResponse)}\n`);
            return;
          }
          if (request.command !== "replay" || !request.runId || ![undefined, "snapshot", "current"].includes(request.workflow)) throw new Error("Invalid control request");
          const run = instance.replayRun(request.runId, { workflow: request.workflow });
          if (run.event.provenance?.kind !== "replay") throw new Error("Replay run lacks replay provenance");
          socket.end(`${JSON.stringify({
            ok: true, runId: run.id, sourceRunId: request.runId,
            rootRunId: run.event.provenance.rootRunId, workflowMode: request.workflow ?? "snapshot",
          } satisfies ControlResponse)}\n`);
        } catch (error) {
          socket.end(`${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) } satisfies ControlResponse)}\n`);
        }
      })();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => resolve());
  });
  if (process.platform !== "win32") fs.chmodSync(socketPath, 0o600);
  return server;
}

async function daemon(): Promise<void> {
  if (readPid()) throw new Error("Mixer Automations is already running");
  ensureHome(resolvePaths());
  fs.writeFileSync(pidFile(), String(process.pid), { flag: "wx" });
  const instance = runtime();
  let controlServer: net.Server | undefined;
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      if (controlServer) await new Promise<void>((resolve) => controlServer!.close(() => resolve()));
      await instance.stop();
    } finally {
      try { fs.unlinkSync(pidFile()); } catch {}
      if (process.platform !== "win32") try { fs.unlinkSync(controlPath()); } catch {}
      process.exit(0);
    }
  };
  const forceShutdown = () => process.exit(1);
  process.on("SIGTERM", () => void shutdown());
  process.on("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => process.once("SIGTERM", forceShutdown));
  process.once("SIGINT", () => process.once("SIGINT", forceShutdown));
  process.on("uncaughtException", (error) => instance.logger.error({ error }, "Uncaught daemon error"));
  process.on("unhandledRejection", (error) => instance.logger.error({ error }, "Unhandled daemon rejection"));
  await instance.initialize();
  await instance.start();
  controlServer = await startControlServer(instance);
  instance.logger.info({ pid: process.pid }, "Mixer Automations started");
  await new Promise(() => {});
}

function age(timestamp: string): string {
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(timestamp).getTime()) / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}

function positiveInteger(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

function table(headers: string[], rows: string[][]): void {
  const widths = headers.map((header, index) => Math.max(header.length, ...rows.map((row) => row[index]?.length ?? 0)));
  console.log(headers.map((header, index) => header.padEnd(widths[index]!)).join("  "));
  for (const row of rows) console.log(row.map((value, index) => value.padEnd(widths[index]!)).join("  "));
}

async function initialized(): Promise<Runtime> {
  const instance = runtime();
  await instance.initialize();
  return instance;
}

function printExtensionFailures(instance: Runtime): number {
  const failures = instance.extensions.filter((loaded) => loaded.error);
  for (const failure of failures) console.log(`✗ extension ${failure.extension.name}\n  ${failure.error!.message}`);
  return failures.length;
}

async function dispatchExtensionCommand(name: string, args: string[]): Promise<boolean> {
  const token = process.env.MIXER_AUTOMATIONS_SUBMISSION_TOKEN;
  if (token) {
    let output: string | undefined;
    const queryArgs: string[] = [];
    for (let index = 0; index < args.length; index++) {
      if (args[index] === "--output") {
        const value = args[index + 1];
        if (output || !value || value.startsWith("--")) throw new Error("--output requires one path");
        output = value; index++;
      } else if (args[index] !== "--json") queryArgs.push(args[index] ?? "");
    }
    const deadline = Date.parse(process.env.MIXER_AUTOMATIONS_STEP_DEADLINE ?? "");
    const timeout = Number.isFinite(deadline) ? Math.max(1, Math.min(2_147_483_647, deadline - Date.now())) : 30_000;
    const response = await controlRequest({ command: "query", name, args: queryArgs, token }, timeout);
    if (!response.ok) throw new Error(response.error ?? "Query rejected");
    const text = JSON.stringify(response.result, null, 2) + "\n";
    if (output) fs.writeFileSync(output, text, { mode: 0o600 });
    process.stdout.write(text);
    return true;
  }
  const instance = await initialized();
  const command = instance.registry.extensionCommands.get(name);
  if (!command) {
    const failed = instance.extensions.find((loaded) => loaded.extension.name === name && loaded.error);
    await instance.stop();
    if (failed?.error) throw new Error(`Extension '${name}' failed to load: ${failed.error.message}`);
    return false;
  }
  try { await command.run(args); } finally { await instance.stop(); }
  return true;
}

const program = new Command()
  .name("mixer-automations")
  .description("Local control plane for autonomous engineering workflows")
  .version(VERSION)
  .addHelpText("after", `\nDocumentation:\n  mixer-automations docs extension-authoring\n  mixer-automations docs workflow-authoring\n  mixer-automations docs maintainer-examples\n  mixer-automations docs workspaces\n  mixer-automations docs --path\n\nRepository-less workflows automatically use a disposable scratch workspace.\nUse mixer-automations docs --path to locate the installed Markdown documentation.`);

const automations = program.command("automations").description("Run automations and inspect their execution history");
const events = program.command("events").description("Submit and reroute events");

function requireDaemon(): void {
  if (!readPid()) throw new Error("Mixer Automations is not running. Start it with `mixer-automations start`.");
}

async function webhookControl(input: unknown): Promise<void> {
  requireDaemon();
  const response = await controlRequest({ command: "webhooks", input }, 125_000);
  if (!response.ok) throw new Error(response.error ?? `Webhook request rejected: ${JSON.stringify(response.result)}`);
  const result = z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("response"), body: z.string() }).passthrough(),
    z.object({ kind: z.literal("event"), result: z.unknown() }).passthrough(),
    z.object({ kind: z.literal("ignored"), reason: z.string() }).passthrough(),
  ]).parse(response.result);
  if (result.kind === "response") process.stdout.write(`${result.body}\n`);
  else process.stdout.write(`${JSON.stringify(result.kind === "event" ? result.result : result)}\n`);
}

const webhooksCommand = program.command("webhooks").description("Inspect and reload optional webhook endpoints in the running daemon");
for (const command of ["list", "reload", "deliveries"]) {
  webhooksCommand.command(command).action(() => webhookControl({ command }));
}
inputOptions(events.command("emit <endpoint>").description("Submit input to a configured endpoint without waiting for execution")
  .requiredOption("--id <delivery-id>", "Stable producer delivery ID for deduplication")
  ).action(async (endpoint: string, options: InputOptions & { id: string }) => {
    if (options.input === undefined && options.inputFile === undefined && !options.arg?.length) throw new Error("Provide one of --input, --input-file, or --arg");
    await webhookControl({ command: "emit", endpoint, deliveryId: options.id, data: submissionInput(options) });
  });

program.command("init").description("Initialize MIXER_AUTOMATIONS_HOME").action(() => {
  const paths = resolvePaths();
  ensureHome(paths);
  fs.mkdirSync(path.join(paths.home, "webhooks"), { recursive: true });
  fs.mkdirSync(path.join(paths.home, "evaluations"), { recursive: true, mode: 0o700 });
  const files: Array<[string, string]> = [
    [paths.config, `${JSON.stringify({
      runtime: { concurrency: 1 },
      history: { retention: "7d" },
      extensions: { github: {} },
    }, null, 2)}\n`],
  ];
  for (const [file, contents] of files) {
    if (!fs.existsSync(file)) fs.writeFileSync(file, contents, { mode: 0o600 });
  }
  ensureHomeIgnore(paths);
  console.log(`Initialized ${paths.home}`);
});

const workflowTemplates: Record<string, (options: { name: string; repository: string; agent: string; model?: string; thinking?: string }) => string> = {
  "issue-triage": ({ name, repository, agent, model, thinking }) => `---
name: ${name}
repository: ${repository}
agent: ${agent}${model ? `\nmodel: ${model}` : ""}${thinking ? `\nthinking: ${thinking}` : ""}
on:
  github.issue:
    events: [opened, edited, labeled]
---

Handle the triggering issue as a repository maintainer. Use git and gh normally. Investigate it, reply or label it when appropriate, and if a focused fix is justified, implement it, test it, commit it, push a branch, and open a pull request. Do not ask for terminal input.
`,
  "pr-review": ({ name, repository, agent, model, thinking }) => `---
name: ${name}
repository: ${repository}
agent: ${agent}${model ? `\nmodel: ${model}` : ""}${thinking ? `\nthinking: ${thinking}` : ""}
on:
  github.pull-request:
    events: [opened, synchronize, ready_for_review]
---

Review the triggering pull request against the repository instructions and base branch. Use git and gh normally. Inspect the code and checks, then submit a concise GitHub review with concrete findings. Do not ask for terminal input.
`,
  "pr-feedback": ({ name, repository, agent, model, thinking }) => `---
name: ${name}
repository: ${repository}
agent: ${agent}${model ? `\nmodel: ${model}` : ""}${thinking ? `\nthinking: ${thinking}` : ""}
on:
  github.issue.comment:
    events: [created]
    where:
      all:
        - pull-request: true
        - pull-request-author: me
  github.pr.comment:
    events: [created]
    where:
      pull-request-author: me
---

Handle the triggering pull-request comment. Read the complete discussion and use git and gh normally. If the feedback is correct, implement it, run the relevant tests, commit it, push it to the PR branch, and reply. Otherwise reply briefly with the reason. Do not ask for terminal input.
`,
  "pr-review-follow-up": ({ name, repository, agent, model, thinking }) => `---
name: ${name}
repository: ${repository}
agent: ${agent}${model ? `\nmodel: ${model}` : ""}${thinking ? `\nthinking: ${thinking}` : ""}
on:
  github.pr.comment:
    events: [created]
    where:
      all:
        - reply-to: me
        - not:
            author: me
        - not:
            pull-request-author: me
---

Follow up on the triggering reply to an inline pull-request review comment you authored. Read the parent thread, current PR head, relevant code, prior review, and checks. Verify whether the original finding was resolved, remains actionable, or was incorrect, then leave only the exact review-thread response needed. This is review-only: never commit, push, edit, close, merge, or create another PR. Do not ask for terminal input.
`,
  "weekly-maintenance": ({ name, repository, agent, model, thinking }) => `---
name: ${name}
repository: ${repository}
agent: ${agent}${model ? `\nmodel: ${model}` : ""}${thinking ? `\nthinking: ${thinking}` : ""}
on:
  schedule:
    cron: "0 3 * * 1"
---

Maintain this repository using git and gh normally. Inspect the code, open issues, pull requests, and CI. Pick at most one useful bounded improvement, implement and test it, then commit, push, and open a pull request. Do nothing when there is no meaningful work. Do not ask for terminal input.
`,
  "maintenance-check": ({ name, repository, agent, model, thinking }) => `---
name: ${name}
repository: ${repository}
agent: ${agent}${model ? `\nmodel: ${model}` : ""}${thinking ? `\nthinking: ${thinking}` : ""}
on:
  schedule:
    cron: "0 */12 * * *"
---

Run one focused maintenance check using git and gh normally. Edit this prompt to name the exact concern. If you find a concrete actionable problem that is not already tracked, open a concise GitHub issue with the evidence. Otherwise do nothing. Do not ask for terminal input.
`,
};

automations.command("create <kind>")
  .description("Create automation files from a template")
  .option("-r, --repository <owner/repo>", "repository managed by this automation")
  .option("--repo <owner/repo>", "short name for --repository")
  .option("--name <name>", "workflow display name")
  .option("--agent <agent>", "agent CLI", "codex")
  .option("--model <model>", "model passed to the agent CLI")
  .option("--thinking <mode>", "thinking or reasoning mode passed to the agent CLI")
  .option("--force", "replace an existing workflow")
  .action((kind: string, options: { repository?: string; repo?: string; name?: string; agent: string; model?: string; thinking?: string; force?: boolean }) => {
    const repository = repositoryOption(options);
    const kinds = kind === "maintainer" ? Object.keys(workflowTemplates) : [kind];
    if (kinds.some((item) => !workflowTemplates[item])) throw new Error(`Unknown workflow kind '${kind}'. Choose: maintainer, ${Object.keys(workflowTemplates).join(", ")}`);
    if (!repository || !/^[^\s/]+\/[^\s/]+$/.test(repository)) throw new Error("--repository must use owner/repo format");
    const paths = resolvePaths();
    ensureHome(paths);
    for (const item of kinds) {
      const template = workflowTemplates[item]!;
      const slug = (kinds.length === 1 ? options.name ?? item : item).toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || item;
      const file = path.join(paths.workflows, `${slug}.md`);
      if (fs.existsSync(file) && !options.force) throw new Error(`Workflow exists: ${file} (use --force to replace it)`);
      fs.writeFileSync(file, template({
        name: kinds.length === 1 ? options.name ?? slug : item,
        repository,
        agent: options.agent,
        model: options.model,
        thinking: options.thinking,
      }), { mode: 0o600 });
      console.log(`Created ${file}`);
    }
  });

function automationFiles(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? automationFiles(file) : entry.isFile() && /\.(md|yaml|yml)$/.test(entry.name) ? [file] : [];
  }).sort();
}

function describeAutomation(workflow: Workflow): string {
  const repositories = Array.isArray(workflow.repository) ? workflow.repository.join(", ") : workflow.repository;
  const execution = workflow.task ? `type: steps\n  steps: ${stepsSchema.parse(workflow.task.configuration).steps.map((step, index) => step.name ?? step.id ?? `step_${index + 1}`).join(", ")}`
    : `type: agent\n  agent: ${workflow.agent}${workflow.model ? `\n  model: ${workflow.model}` : ""}${workflow.thinking ? `\n  thinking: ${workflow.thinking}` : ""}`;
  return `${workflow.id}\n  status: ${workflow.disabled ? "disabled" : "enabled"}\n  repository: ${repositories ?? "none"}\n  workspace: ${workflow.workspace ?? "unresolved"}\n  triggers: ${Object.keys(workflow.on).join(", ") || "manual"}\n  ${execution}\n  safe actions: ${Object.keys(workflow.safeActions).join(", ") || "none"}\n`;
}

automations.command("files").description("List available automation definitions and their settings").action(async () => {
  const instance = await initialized();
  for (const workflow of instance.workflows) console.log(describeAutomation(workflow));
  for (const file of automationFiles(instance.paths.workflows)) {
    try {
      const workflow = parseWorkflow(file, instance.paths.workflows, instance.registry);
      if (workflow.disabled) console.log(describeAutomation(workflow));
    } catch { /* Invalid definitions are reported by discovery below. */ }
  }
  for (const failure of instance.workflowErrors) console.log(`${failure.path}\n  invalid: ${failure.errors.join("; ")}\n`);
  const extensionFailures = printExtensionFailures(instance);
  await instance.stop();
  if (instance.workflowErrors.length || extensionFailures) process.exitCode = 1;
});

automations.command("show <name>").description("Show one automation definition and its resolved settings")
  .option("--json", "emit definition and validation diagnostics as JSON")
  .action(async (name: string, options: { json?: boolean }) => {
    const instance = await initialized();
    try {
      const file = resolveWorkflowFile(instance.paths.workflows, name);
      if (!file) throw new Error(`Automation not found: ${name}`);
      const workflow = parseWorkflow(file, instance.paths.workflows, instance.registry);
      const errors = workflow.disabled ? [] : validateWorkflow(workflow, instance.registry);
      if (options.json) console.log(JSON.stringify({ workflow, errors }));
      else {
        console.log(describeAutomation(workflow));
        process.stdout.write(fs.readFileSync(file, "utf8"));
        for (const error of errors) console.error(error);
      }
      if (errors.length) process.exitCode = 1;
    } finally { await instance.stop(); }
  });

program.command("start")
  .description("Start Mixer Automations in the background")
  .option("--foreground", "run in the foreground")
  .action(async (options: { foreground?: boolean }) => {
    if (options.foreground) return daemon();
    const existing = readPid();
    if (existing) {
      console.error(`Mixer Automations is already running (PID ${existing})`);
      process.exitCode = 1;
      return;
    }
    ensureHome(resolvePaths());
    const script = fileURLToPath(import.meta.url);
    const log = fs.openSync(path.join(resolvePaths().logs, "daemon.log"), "a");
    const child = spawn(process.execPath, [...process.execArgv, script, "__daemon"], {
      detached: true, stdio: ["ignore", log, log], env: process.env,
    });
    child.unref();
    fs.closeSync(log);
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && child.exitCode === null && child.signalCode === null) {
      if (readPid() === child.pid) {
        try {
          const response = await controlRequest({ command: "ping" }, 500);
          if (response.ok && response.status === "ready") { console.log(`Mixer Automations started (PID ${child.pid})`); return; }
        } catch { /* The process may be alive before its control socket is ready. */ }
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    throw new Error(`Mixer Automations failed to start; see ${path.join(resolvePaths().logs, "daemon.log")}`);
  });

program.command("__daemon", { hidden: true }).action(() => daemon());

program.command("stop").description("Request daemon shutdown and return immediately")
  .option("--wait", "wait for the daemon to finish shutdown")
  .action(async (options: { wait?: boolean }) => {
  const pid = readPid();
  if (!pid) return console.log("Mixer Automations is not running");
  process.kill(pid, "SIGTERM");
  if (!options.wait) { console.log("Mixer Automations shutdown requested"); return; }
  if (await waitForStop()) console.log("Mixer Automations stopped");
  else {
    console.error(`Mixer Automations did not stop within the configured shutdown timeout (PID ${pid})`);
    process.exitCode = 1;
  }
});

program.command("restart").description("Restart Mixer Automations in the background").action(async () => {
  const pid = readPid();
  if (pid) process.kill(pid, "SIGTERM");
  ensureHome(resolvePaths());
  const script = fileURLToPath(import.meta.url);
  const log = fs.openSync(path.join(resolvePaths().logs, "daemon.log"), "a");
  const child = spawn(process.execPath, [...process.execArgv, script, "__restart"], {
    detached: true, stdio: ["ignore", log, log], env: process.env,
  });
  child.unref();
  fs.closeSync(log);
  console.log("Mixer Automations restart requested");
});

program.command("__restart", { hidden: true }).action(async () => {
  if (!(await waitForStop())) throw new Error("Mixer Automations did not stop within the configured shutdown timeout");
  await daemon();
});

function overview(): void {
  const pid = readPid({ cleanup: false });
  printOverview({ paths: resolvePaths(), pid });
  if (!pid) process.exitCode = 1;
}
program.action(overview);
program.command("status").description("Summarize recent automations, evaluations, and daemon health").action(overview);

automations.command("validate [workflow]").description("Validate all automation definitions or one file")
  .option("--json", "emit machine-readable validation diagnostics")
  .action(async (identifier: string | undefined, options: { json?: boolean }) => {
  const instance = await initialized();
  let valid = instance.workflows.map((workflow) => workflow.id);
  let errors = instance.workflowErrors;
  if (identifier) {
    const file = resolveWorkflowFile(instance.paths.workflows, identifier);
    if (!file) { await instance.stop(); throw new Error(`Workflow not found: ${identifier}`); }
    const relative = path.relative(instance.paths.workflows, file).split(path.sep).join("/");
    try {
      const workflow = parseWorkflow(file, instance.paths.workflows, instance.registry);
      const validation = workflow.disabled ? [] : validateWorkflow(workflow, instance.registry);
      valid = validation.length ? [] : [relative];
      errors = validation.length ? [{ path: relative, errors: validation }] : [];
    } catch (error) { valid = []; errors = [{ path: relative, errors: [error instanceof Error ? error.message : String(error)] }]; }
  }
  if (!options.json) for (const workflow of valid) console.log(`✓ ${workflow}`);
  if (!options.json) for (const failure of errors) {
    console.log(`✗ ${failure.path}`);
    for (const error of failure.errors) console.log(`  ${error}`);
  }
  const extensionFailures = options.json ? instance.extensions.filter((extension) => extension.error).length : printExtensionFailures(instance);
  if (options.json) console.log(JSON.stringify({ ok: !errors.length && !extensionFailures, workflows: valid, errors,
    extensions: instance.extensions.filter((extension) => extension.error).map((extension) => ({ name: extension.extension.name, error: extension.error?.message })) }));
  if (errors.length || extensionFailures) process.exitCode = 1;
  await instance.stop();
});

program.command("actions").description("Request declared Safe Actions from an active scripted step")
  .command("request <name>").description("Record a proposal; execution occurs only after successful workflow completion")
  .requiredOption("--input-json <json>", "JSON action input")
  .requiredOption("--request-key <key>", "stable idempotency key within this step")
  .option("--json", "emit the recorded proposal as JSON")
  .action(async (name: string, options: { inputJson: string; requestKey: string; json?: boolean }) => {
    const token = process.env.MIXER_AUTOMATIONS_SUBMISSION_TOKEN;
    if (!token) throw new Error("Safe Action requests require an active scripted step");
    if (Buffer.byteLength(options.inputJson, "utf8") > 48 * 1024) throw new Error("Action input exceeds the 48 KiB limit");
    const request = actionRequestSchema.parse({ name, input: JSON.parse(options.inputJson), requestKey: options.requestKey });
    const response = await controlRequest({ command: "request-action", ...request, token });
    if (!response.ok) throw new Error(response.error ?? "Safe Action request rejected");
    if (options.json) console.log(JSON.stringify(response.result));
    else console.log("Safe Action proposal recorded. Inspect the run for the execution result.");
  });

async function waitForRuns(runIds: readonly string[]) {
  const database = openState();
  try {
    for (;;) {
      const runs = runIds.map((id) => {
        const run = database.getRun(id);
        if (!run) throw new Error(`Run not found: ${id}`);
        return run;
      });
      if (runs.every((run) => ["completed", "failed", "cancelled", "interrupted"].includes(run.status))) return runs;
      requireDaemon();
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  } finally { database.close(); }
}

inputOptions(automations.command("run <workflow>").description("Queue an automation and return immediately")
  .option("-r, --repository <owner/repo>", "repository for a multi-repository automation")
  .option("--repo <owner/repo>", "short name for --repository")
  .option("--wait", "wait for completion and return the final outcome")
  .option("--json", "emit a machine-readable result")
  .option("--inherit-event", "inherit the active scripted parent's event, with independent child activation")
  .option("--handoff-key <key>", "idempotency key within the current scripted step")
  ).action(async (workflow: string, options: InputOptions & { repository?: string; repo?: string; wait?: boolean; json?: boolean; inheritEvent?: boolean; handoffKey?: string }) => {
    const input = submissionInput(options);
    const repository = repositoryOption(options);
    const token = process.env.MIXER_AUTOMATIONS_SUBMISSION_TOKEN;
    if (options.wait && (token || options.inheritEvent || options.handoffKey)) throw new Error("Automation handoffs cannot use --wait; children run independently");
    requireDaemon();
    const response = await controlRequest({ command: "submit", identifier: workflow, input, repository,
      token, inheritEvent: options.inheritEvent, handoffKey: options.handoffKey });
    if (!response.ok || !response.runId) throw new Error(response.error ?? "Submission rejected or missing run ID");
    if (!options.json) console.log(`Queued ${workflow}\nRun: ${response.runId}`);
    if (!options.wait) {
      if (options.json) console.log(JSON.stringify(response));
      return;
    }
    const [completed] = await waitForRuns([response.runId]);
    if (options.json) console.log(JSON.stringify({ ok: runSucceeded(completed), runId: response.runId, status: completed?.status, outcome: completed?.outcome }));
    else console.log(`Finished: ${completed?.status}${taskOutcome(completed?.outcome) ? ` (${taskOutcome(completed?.outcome)})` : ""}`);
    if (!runSucceeded(completed)) process.exitCode = 1;
  });

automations.command("rerun <run>").description("Queue a new run using a previous run's definition and input")
  .option("--current", "use the current automation definition instead of its saved snapshot")
  .option("--wait", "wait for completion and return the final outcome")
  .option("--json", "print machine-readable output")
  .action(async (sourceRunId: string, options: { current?: boolean; wait?: boolean; json?: boolean }) => {
    if (options.wait && process.env.MIXER_AUTOMATIONS_SUBMISSION_TOKEN) throw new Error("Scripted steps cannot wait for reruns; children run independently");
    requireDaemon();
    const response = await controlRequest({ command: "replay", runId: sourceRunId, workflow: options.current ? "current" : "snapshot" });
    if (!response.ok || !response.runId) throw new Error(response.error ?? "Rerun request failed");
    if (!options.json) console.log(`Queued rerun of ${sourceRunId}\nRun: ${response.runId}`);
    if (options.wait) {
      const [completed] = await waitForRuns([response.runId]);
      if (options.json) console.log(JSON.stringify({ ...response, ok: runSucceeded(completed), status: completed?.status, outcome: completed?.outcome }));
      else console.log(`Finished: ${completed?.status}`);
      if (!runSucceeded(completed)) process.exitCode = 1;
    } else if (options.json) console.log(JSON.stringify(response));
  });

events.command("explain <event>").description("Explain recorded routing, pending eligibility, and resource waits without starting work")
  .option("--json", "print machine-readable output")
  .action((eventId: string, options: { json?: boolean }) => {
    const database = openState();
    try {
      const report = database.explainEvent(eventId);
      if (options.json) console.log(JSON.stringify(report));
      else {
        console.log(`Event: ${report.event.id}\nType: ${report.event.type}`);
        for (const row of report.decisions) console.log(`${row.workflowId}: ${row.decision} (${row.reason})`);
        for (const row of report.runs) console.log(`${row.runId}: ${row.status}${row.waitingFor ? `; waiting for ${row.waitingFor}` : ""}`);
        if (report.note) console.log(report.note);
      }
    } finally { database.close(); }
  });

events.command("reroute <event>").description("Route a persisted event through current automations")
  .option("--wait", "wait for all matched runs to reach a terminal status")
  .option("--json", "print machine-readable output")
  .action(async (sourceEventId: string, options: { wait?: boolean; json?: boolean }) => {
    requireDaemon();
    let response: ControlResponse;
    try {
      response = await controlRequest({ command: "reroute", eventId: sourceEventId });
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
      return;
    }
    if (!response.ok || !response.eventId) {
      console.error(response.error ?? response.reason ?? "Reroute request failed");
      process.exitCode = 1;
      return;
    }
    const runIds = [...(response.runIds ?? [])];
    if (!options.json) console.log(`Event rerouted: ${response.eventId}\nSource event: ${sourceEventId}\nMatched runs: ${runIds.length ? runIds.join(", ") : "none"}\nWorkflows: current`);
    if (options.wait && runIds.length) {
      const runs = await waitForRuns(runIds);
      if (options.json) console.log(JSON.stringify({ ...response, ok: runs.every(runSucceeded), runs: runs.map((run) => ({ runId: run.id, status: run.status, outcome: run.outcome })) }));
      if (runs.some((run) => !runSucceeded(run))) process.exitCode = 1;
    } else if (options.json) console.log(JSON.stringify(response));
  });

automations.command("cancel <run>").description("Request cancellation of one queued or active run")
  .option("--reason <reason>", "recorded cancellation reason", "Cancelled by operator")
  .action(async (runId: string, options: { reason: string }) => {
    requireDaemon();
    const response = await controlRequest({ command: "cancel", runId, reason: options.reason });
    if (!response.ok || !response.cancelled) {
      console.error(response.error ?? "Cancellation failed");
      process.exitCode = 1;
      return;
    }
    console.log(`Cancellation requested: ${runId}`);
  });

automations.command("list").description("List active runs and recent execution history")
  .option("--json", "emit versioned run summaries as JSON")
  .option("--all", "show all retained runs")
  .option("--since <duration>", "show terminal runs updated within a duration, such as 6h or 3d")
  .option("--limit <count>", "maximum terminal runs to show; active runs are always included")
  .addHelpText("after", `
Behavior:
  The default view includes up to 50 terminal runs updated in the last 24h.
  Terminal history is ordered oldest to newest. Queued and active runs are
  always included and appear last, so current work stays next to the prompt.
  --all removes the time window; --since replaces it. These cannot be combined.
  Durations accept ms, s, m, h, d, or w, for example 30m, 24h, or 2w.

Retention:
  history.retention controls how long terminal run records and per-run logs are
  kept. It defaults to 7d and is independent of the default 24h display window.

More documentation:
  mixer-automations docs commands
  mixer-automations docs configuration`)
  .action(async (options: { all?: boolean; since?: string; limit?: string; json?: boolean }) => {
    if (options.all && options.since) throw new Error("--all and --since cannot be used together");
    const window = options.since ? parseDuration(options.since) : 24 * 60 * 60 * 1_000;
    const since = options.all ? undefined : new Date(Date.now() - window).toISOString();
    const limit = options.limit ? positiveInteger(options.limit, "--limit") : options.all ? undefined : 50;
    const database = openState();
    const runs = database.listRunsForDisplay({ since, limit });
    if (options.json) {
      console.log(JSON.stringify({ schemaVersion: 1, runs: runs.map(run => ({
        id: run.id, workflowId: run.workflowId, repository: run.repository,
        status: run.status, outcome: taskOutcome(run.outcome),
        createdAt: run.createdAt, updatedAt: run.updatedAt, executor: run.agent || "steps",
      })) }));
      database.close();
      return;
    }
    const rows = runs.map((run) => [
      run.id, run.workflowId.replace(/\.(md|yaml|yml)$/, ""), run.repository ?? "-", run.status, taskOutcome(run.outcome) ?? "-", age(run.createdAt), run.agent || "steps",
    ]);
    table(["RUN", "AUTOMATION", "REPOSITORY", "STATUS", "OUTCOME", "AGE", "EXECUTOR"], rows);
    database.close();
  });

automations.command("inspect <run>").description("Inspect a run").option("--json", "emit run, steps, children, and Safe Action records as JSON")
  .action(async (runId: string, options: { json?: boolean }) => {
  const database = openState();
  const run = database.getRun(runId);
  if (!run) throw new Error(`Run not found: ${runId}`);
  const actions = database.listActions(runId);
  const plan = database.getPlan(runId);
  if (options.json) {
    console.log(JSON.stringify({ run, steps: database.listSteps(runId), parentRunId: database.parentRun(runId), childRunIds: database.childRuns(runId), actions, plan, effects: plan ? database.listEffects(plan.id) : [] }));
    database.close(); return;
  }
  console.log(`Run\n  ${run.id}\n\nAutomation\n  ${run.workflowId}\n\nRepository\n  ${run.repository ?? "-"}`);
  console.log(`\nEvent\n  ${run.event.type}\n\nExecutor\n  ${run.agent || "steps"}\n\nExecution\n  ${run.execution ?? "legacy"}\n\nWorkspace\n  ${run.workspace ?? "-"}\n\nStatus\n  ${run.status}`);
  const stepRecords = database.listSteps(runId);
  if (stepRecords.length) {
    console.log("\nSteps");
    table(["STEP", "NAME", "ATTEMPT", "STATUS", "EXIT", "TOLERATED", "ERROR"], stepRecords.map((step) =>
      [step.id, step.name, String(step.attempt), step.status, step.exitCode === undefined ? "-" : String(step.exitCode), step.tolerated ? "yes" : "no", step.error ?? "-"]));
  }
  if (actions.length) {
    console.log("\nSafe Actions");
    table(["ACTION", "ID", "STATUS", "REASON"], actions.map(action => [action.action, action.id, action.status, action.reason ?? "-"]));
    if (plan) console.log(`\nAction plan\n  ${plan.id}\n  ${plan.status}`);
  }
  const parent = database.parentRun(runId);
  const children = database.childRuns(runId);
  if (parent) console.log(`\nParent run\n  ${parent}`);
  if (children.length) console.log(`\nChild runs\n  ${children.join("\n  ")}`);
  if (run.activation?.workspaceSource) console.log(`\nSource\n  ${run.activation.workspaceSource.repository}@${run.activation.workspaceSource.revision}`);
  if (run.effectiveWorkspace) {
    const initial = run.effectiveWorkspace.initial;
    console.log(`\nEffective workspace\n  ${initial.path}\n  ${initial.repository ?? "-"}@${initial.revision}\n  initial clean: ${initial.clean}`);
    const final = run.effectiveWorkspace.final;
    if (final) console.log(`  final: ${final.branch ?? "detached"}@${final.revision}\n  final clean: ${final.clean}`);
  }
  if (run.error) console.log(`\nError\n  ${run.error}`);
  if (run.deadline) console.log(`\nDeadline\n  ${new Date(run.deadline).toISOString()}`);
  if (run.cancellation) console.log(`\nCancellation\n  ${run.cancellation.requestedAt}\n  ${run.cancellation.reason ?? "-"}`);
  if (run.outcome) console.log(`\nOutcome\n  ${JSON.stringify(run.outcome, null, 2)}`);
  const replay = database.getReplayForRun(runId);
  if (replay) console.log(`\nRerun\n  source: ${replay.sourceRunId}\n  root: ${replay.rootRunId}\n  definition: ${replay.workflowMode}\n  requested: ${replay.createdAt}`);
  const reroute = database.getRerouteForEvent(run.event.id);
  if (reroute) console.log(`\nReroute\n  source event: ${reroute.sourceEventId}\n  requested: ${reroute.createdAt}`);
  database.close();
});

async function showLogs(runId: string | undefined, options: { follow?: boolean; step?: string }): Promise<void> {
  if (runId && !/^[a-zA-Z0-9_-]+$/.test(runId)) throw new Error("Invalid run ID");
  const file = path.join(resolvePaths().logs, runId ? `${runId}.log` : "roboplane.log");
  if (!fs.existsSync(file)) throw new Error(`Log not found: ${file}`);
  let offset = 0;
  let pending = "";
  const print = () => {
    const size = fs.statSync(file).size;
    if (size > offset) {
      const descriptor = fs.openSync(file, "r");
      const buffer = Buffer.alloc(size - offset);
      fs.readSync(descriptor, buffer, 0, buffer.length, offset);
      fs.closeSync(descriptor);
      if (!options.step) process.stdout.write(buffer);
      else {
        pending += buffer.toString();
        const lines = pending.split("\n"); pending = lines.pop() ?? "";
        for (const line of lines) {
          try { const record: unknown = JSON.parse(line); if (record && typeof record === "object" && "stepId" in record && record.stepId === options.step) process.stdout.write(`${line}\n`); } catch { /* Incomplete or legacy log lines have no step identity. */ }
        }
      }
      offset = size;
    }
  };
  print();
  if (options.follow) {
    fs.watch(file, print);
    await new Promise(() => {});
  }
}

program.command("logs").description("Show daemon logs").option("--follow", "follow appended logs")
  .action((options: { follow?: boolean }) => showLogs(undefined, options));
automations.command("logs <run>").description("Show one automation run's logs")
  .option("--follow", "follow appended logs").option("--step <id>", "show one scripted step")
  .action(showLogs);

const extensions = program.command("extensions").description("Manage installed extensions");
extensions.command("list").description("List loaded extensions").action(async () => {
  const instance = await initialized();
  const rows = instance.extensions.map((loaded) => {
    const capabilities = instance.registry.capabilities.get(loaded.extension.name);
    const kinds = capabilities ? Object.entries(capabilities).filter(([, names]) => names.length).map(([kind]) => kind) : [];
    return [loaded.extension.name, !loaded.enabled ? "disabled" : loaded.error ? "failed" : "loaded", kinds.join(", ") || "-"];
  });
  table(["EXTENSION", "STATUS", "CAPABILITIES"], rows);
  await instance.stop();
});
extensions.command("inspect <name>").description("Inspect an extension").action(async (name: string) => {
  const instance = await initialized();
  const loaded = instance.extensions.find((item) => item.extension.name === name);
  if (!loaded) throw new Error(`Extension not found: ${name}`);
  const capabilities = instance.registry.capabilities.get(name);
  console.log(`Name\n  ${loaded.extension.name}\n\nVersion\n  ${loaded.extension.version ?? "-"}\n\nPath\n  ${loaded.path}`);
  console.log(`\nStatus\n  ${!loaded.enabled ? "disabled" : loaded.error ? "failed" : "loaded"}`);
  console.log(`\nConfiguration\n  ${Object.hasOwn(instance.config.extensions, name) ? "configured (values hidden)" : "not configured"}`);
  if (loaded.error) console.log(`\nError\n  ${loaded.error.message}`);
  for (const [kind, names] of Object.entries(capabilities ?? {})) console.log(`\n${kind}\n  ${(names as string[]).join(", ") || "-"}`);
  await instance.stop();
});

const extensionTemplates: Record<string, (name: string) => string> = {
  "event-source": (name) => `import { defineExtension, z } from "@mixer/automations-sdk";

const triggerSchema = z.object({ intervalMs: z.number().int().positive().default(60_000) }).strict();

async function fetchItems(): Promise<Array<{ id: string; revision: string }>> {
  // Query the service you want to watch and return only new or changed items.
  return [];
}

export default defineExtension({
  name: "${name}",
  version: "0.1.0",
  setup(api) {
    let timer: NodeJS.Timeout | undefined;
    let subscriptions: readonly import("@mixer/automations-sdk").WorkflowSubscription[] = [];
    api.events.registerSource("${name}.item", {
      configSchema: triggerSchema,
      start(ctx) {
        subscriptions = ctx.subscriptions;
        const intervals = subscriptions.map((item) => triggerSchema.parse(item.config).intervalMs);
        const interval = intervals.length ? Math.min(...intervals) : 60_000;
        const poll = async () => {
          for (const item of await fetchItems()) for (const subscription of subscriptions) {
            await ctx.emit({
              id: "${name}:" + subscription.repository + ":" + item.id + ":" + item.revision,
              type: "${name}.item",
              source: "${name}",
              timestamp: new Date().toISOString(),
              repository: subscription.repository,
              data: item,
            });
          }
        };
        void poll();
        timer = setInterval(() => void poll(), interval);
        ctx.signal.addEventListener("abort", () => { if (timer) clearInterval(timer); }, { once: true });
      },
      updateSubscriptions(_type, next) { subscriptions = next; },
      stop() { if (timer) clearInterval(timer); subscriptions = []; },
      match() { return true; },
    });
  },
});
`,
  "workflow-field": (name) => `import { defineExtension, z } from "@mixer/automations-sdk";

export default defineExtension({
  name: "${name}",
  version: "0.1.0",
  setup(api) {
    const field = "${name}.context";
    api.workflows.registerField(field, {
      description: "Extra instructions supplied by this extension.",
      schema: z.object({ instructions: z.string().min(1) }).strict(),
    });
    api.hooks.on("agent:before", (ctx) => {
      const value = ctx.workflow?.extensions?.[field] as { instructions?: string } | undefined;
      if (value?.instructions) ctx.instructions.push(value.instructions);
    });
  },
});
`,
};

extensions.command("create <name>").description("Create an enabled personal extension")
  .option("--template <template>", "event-source or workflow-field", "event-source")
  .action(async (name: string, options: { template: string }) => {
    if (!/^[a-z][a-z0-9-]*$/.test(name)) throw new Error("Extension names must use lowercase letters, numbers, and hyphens");
    const template = extensionTemplates[options.template];
    if (!template) throw new Error(`Unknown extension template: ${options.template}`);
    const paths = resolvePaths();
    ensureHome(paths);
    const directory = path.join(paths.extensions, name);
    const file = path.join(directory, "index.ts");
    if (fs.existsSync(directory)) throw new Error(`Extension already exists: ${directory}`);
    fs.mkdirSync(directory);
    fs.writeFileSync(file, template(name));
    setExtensionEnabled(paths.config, name, true);
    let activation = "It will load on the next start.";
    if (readPid()) {
      const response = await controlRequest({ command: "reload-extension", extension: name });
      if (!response.ok) throw new Error(`Extension was created but could not be loaded: ${response.error ?? "reload failed"}`);
      activation = "It is loaded in the running daemon.";
    }
    console.log(`Created enabled extension '${name}' at ${file}\n${activation}\nValidate it with: mixer-automations extensions validate ${name}`);
  });

extensions.command("validate <name>").description("Import, register, and validate an installed extension and its automations").action(async (name: string) => {
  const instance = await initialized();
  try {
    const loaded = instance.extensions.find((item) => item.extension.name === name);
    if (!loaded) throw new Error(`Extension not found: ${name}`);
    if (!loaded.enabled) throw new Error(`Extension '${name}' is disabled; enable it before checking`);
    if (loaded.error) throw loaded.error;
    const capabilities = instance.registry.capabilities.get(name);
    const names = [name, ...Object.values(capabilities ?? {}).flat()];
    const related = instance.workflowErrors.filter((item) => item.errors.some((error) => names.some((capability) => error.includes(capability))));
    if (related.length) throw new Error(related.map((item) => `${item.path}: ${item.errors.join("; ")}`).join("\n"));
    console.log(`Extension '${name}' is valid. Capabilities: ${Object.entries(capabilities ?? {}).filter(([, values]) => values.length).map(([kind, values]) => `${kind}=${values.join(",")}`).join(" ") || "none"}`);
  } finally {
    await instance.stop();
  }
});

async function changeExtensionState(name: string, enabled: boolean): Promise<void> {
  const paths = resolvePaths();
  ensureHome(paths);
  const configPath = paths.config;
  const previous = fs.existsSync(configPath) ? fs.readFileSync(configPath, "utf8") : undefined;
  setExtensionEnabled(configPath, name, enabled);
  const running = !!readPid();
  if (running) {
    const response = await controlRequest({ command: "reload-extension", extension: name });
    if (!response.ok) {
      if (previous === undefined) fs.unlinkSync(configPath);
      else fs.writeFileSync(configPath, previous, { mode: 0o600 });
      throw new Error(response.error ?? "Extension reload failed");
    }
  }
  console.log(`Extension '${name}' is ${enabled ? "enabled" : "disabled"}${running ? "" : "; the change applies on the next start"}.`);
}

extensions.command("enable <name>").description("Enable an extension in config.json").action((name: string) => changeExtensionState(name, true));
extensions.command("disable <name>").description("Disable an extension in config.json").action((name: string) => changeExtensionState(name, false));
extensions.command("reload <name>").description("Reload one extension in the running daemon").action(async (name: string) => {
  if (!readPid()) throw new Error("Mixer Automations is not running; start it before reloading an extension");
  const response = await controlRequest({ command: "reload-extension", extension: name });
  if (!response.ok) throw new Error(response.error ?? "Extension reload failed");
  console.log(`Extension '${name}' reloaded (${response.enabled ? "enabled" : "disabled"}).`);
});

program.command("docs [topic]").description("Show bundled documentation")
  .option("--raw", "stable undecorated Markdown")
  .option("--path", "print the installed documentation directory")
  .option("--search <text>", "search all installed Markdown documentation")
  .action((topic: string | undefined, options: { path?: boolean; search?: string }) => {
  const directory = fileURLToPath(new URL("./docs", import.meta.url));
  if (options.path) { console.log(directory); return; }
  if (options.search) {
    const needle = options.search.toLowerCase();
    const matches = fs.readdirSync(directory).filter((file) => file.endsWith(".md") && fs.readFileSync(path.join(directory, file), "utf8").toLowerCase().includes(needle));
    console.log(matches.length ? matches.map((file) => file.replace(/\.md$/, "")).join("\n") : "No documentation topics matched.");
    return;
  }
  if (!topic) {
    const topics = fs.readdirSync(directory).filter((file) => file.endsWith(".md")).map((file) => file.replace(/\.md$/, "")).sort();
    console.log(`Mixer Automations Documentation\n\nTopics:\n\n${topics.map((name) => `  ${name}`).join("\n")}\n\nRun:\n\n  mixer-automations docs <topic>`);
    return;
  }
  const file = path.join(directory, `${topic}.md`);
  if (!fs.existsSync(file) || path.dirname(file) !== directory) throw new Error(`Unknown documentation topic: ${topic}`);
  process.stdout.write(fs.readFileSync(file, "utf8"));
});

const known = new Set(["help", ...program.commands.map(command => command.name())]);
const requested = process.argv[2];
try {
  if (requested && !requested.startsWith("-") && !known.has(requested)) {
    if (!(await dispatchExtensionCommand(requested, process.argv.slice(3)))) program.error(`unknown command '${requested}'`);
  } else {
    await program.parseAsync();
  }
} catch (error) {
  console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
process.exit(process.exitCode ?? 0);
