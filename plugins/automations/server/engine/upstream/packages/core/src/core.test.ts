import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { AgentContext, AgentProvider, Event, EventActivation, Extension, Logger, OperationContext, Run, Workflow, WorkflowSubscription } from "@mixer/automations-sdk";
import { loadConfig, setExtensionEnabled } from "./config.js";
import { StateDatabase } from "./database.js";
import { redactSecrets } from "./logger.js";
import { resolvePaths, ensureHome } from "./paths.js";
import { CoreProcessAPI } from "./process.js";
import { Registry } from "./registry.js";
import { Runtime } from "./runtime.js";
import { discoverWorkflows, parseWorkflow } from "./workflows.js";

const temporary: string[] = [];
function temp(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "roboplane-test-"));
  temporary.push(directory);
  return directory;
}
afterEach(() => {
  for (const directory of temporary.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

const logger: Logger = {
  debug() {}, info() {}, warn() {}, error() {}, child() { return logger; },
};

function event(id = "event-1"): Event {
  return {
    id, type: "test.item", source: "test", timestamp: "2026-08-27T08:00:00.000Z",
    repository: "owner/repo", actor: { name: "octocat" }, data: { url: "https://github.com/owner/repo/issues/7", number: 7 },
  };
}

function workflow(): Workflow {
  return {
    id: "task.md", path: "/task.md", name: "task", repository: "owner/repo",
    on: { "test.item": {} }, extensions: {}, agent: "fake", model: "test-model", thinking: "high", execution: "host",
    workspace: "worktree", safeActions: {}, prompt: "Handle the issue.",
  };
}

function run(): Run {
  const now = new Date().toISOString();
  return { id: "rp_test", workflowId: "task.md", repository: "owner/repo", event: event(), status: "running", createdAt: now, updatedAt: now };
}

function runtimeExtension(options: {
  agent: AgentProvider["run"];
  match?: (event: Event, config: unknown, operation?: OperationContext) => boolean;
  activate?: () => EventActivation;
  order?: string[];
  after?: (metadata: Record<string, unknown>) => void;
  finalized?: (metadata: Record<string, unknown>) => void;
  dirtyAttestation?: boolean;
  safeAction?: (input: unknown) => unknown;
  subscriptions?: (subscriptions: readonly WorkflowSubscription[]) => void;
}): Extension {
  return {
    name: "test",
    setup(api) {
      api.events.registerSource("test.item", { start(context) { options.subscriptions?.(context.subscriptions); }, updateSubscriptions(_type, subscriptions) { options.subscriptions?.(subscriptions); }, match: options.match ?? (() => true), activate: options.activate });
      api.agents.register("fake", {
        run: async (context) => await options.agent(context) ?? { version: 1, outcome: "no-op" },
      });
      api.workspaces.register("worktree", {
        create: (context) => ({ path: path.join(api.paths.workspaces, context.run.id) }),
        attest: (context, workspace) => ({
          version: 1, path: workspace.path, repository: context.repository,
          revision: context.source?.revision ?? "0".repeat(40), clean: !options.dirtyAttestation, verifiedAt: "now",
        }),
        cleanup: () => { options.order?.push("workspace"); },
      });
      api.executions.register("host", {
        isolation: "none",
        open: () => ({ process: api.process, close: () => { options.order?.push("execution"); } }),
      });
      if (options.safeAction) api.actions.register("test.complete", {
        description: "Complete the exact test item.",
        schema: z.object({ decision: z.literal("complete") }).strict(),
        policySchema: z.object({ max: z.literal(1), enabled: z.boolean().default(true) }).strict(),
        prepare: (_context, input) => input,
        executePrepared: (_context, input) => options.safeAction!(input),
      });
      if (options.after) api.hooks.on("run:after", (context) => options.after!(context.metadata));
      if (options.finalized) api.hooks.on("run:finalized", (context) => options.finalized!(context.metadata));
    },
  };
}

function writeWorkflow(home: string, contents = "Handle the issue."): void {
  fs.writeFileSync(path.join(home, "automations", "task.md"), `---\nrepository: owner/repo\nagent: fake\nmodel: test-model\nthinking: high\non:\n  test.item: {}\n---\n${contents}\n`);
}

describe("workflow discovery", () => {
  it("enumerates extension state by literal prefix", () => {
    const database = new StateDatabase(temp());
    const state = database.state("github");
    state.set("self:one", "1");
    state.set("self_percent", "2");
    state.set("other", "3");
    expect(state.entries("self:")).toEqual([{ key: "self:one", value: "1" }]);
    expect(state.entries("self_")).toEqual([{ key: "self_percent", value: "2" }]);
    database.close();
  });

  it("parses the minimal global workflow format", () => {
    const root = temp();
    const file = path.join(root, "task.md");
    fs.writeFileSync(file, `---\nrepository: owner/repo\nagent: claude\nmodel: opus\nthinking: high\non:\n  manual: {}\n---\nInspect.\n`);
    expect(parseWorkflow(file, root)).toMatchObject({
      agent: "claude", model: "opus", thinking: "high", execution: "host", workspace: "worktree", prompt: "Inspect.", safeActions: {},
    });
  });

  it("accepts a non-empty list of unique repositories", () => {
    const root = temp();
    const file = path.join(root, "task.md");
    fs.writeFileSync(file, `---\nrepository:\n  - owner/one\n  - owner/two\non:\n  manual: {}\n---\nInspect.\n`);
    expect(parseWorkflow(file, root)).toMatchObject({ repository: ["owner/one", "owner/two"], workspace: "worktree" });

    fs.writeFileSync(file, `---\nrepository: []\non:\n  manual: {}\n---\nInspect.\n`);
    expect(() => parseWorkflow(file, root)).toThrow("at least one repository is required");
    fs.writeFileSync(file, `---\nrepository: [owner/repo, owner/repo]\non:\n  manual: {}\n---\nInspect.\n`);
    expect(() => parseWorkflow(file, root)).toThrow("repositories must be unique");
  });

  it("defaults repository-less workflows to scratch and permits an explicit workspace", () => {
    const root = temp();
    const file = path.join(root, "jira.md");
    fs.writeFileSync(file, `---\nagent: claude\non:\n  jira.issue: {}\n---\nTriage.\n`);
    expect(parseWorkflow(file, root)).toMatchObject({ repository: undefined, workspace: "scratch" });
    fs.writeFileSync(file, `---\nrepository: owner/repo\nworkspace: custom.git\non:\n  custom.push: {}\n---\nWork.\n`);
    expect(parseWorkflow(file, root)).toMatchObject({ repository: "owner/repo", workspace: "custom.git" });
  });

  it("rejects an empty thinking mode", () => {
    const root = temp();
    const file = path.join(root, "task.md");
    fs.writeFileSync(file, `---\nrepository: owner/repo\nthinking: ""\non:\n  manual: {}\n---\nInspect.\n`);
    expect(() => parseWorkflow(file, root)).toThrow();
  });

  it("skips disabled workflows and rediscovers them when enabled", () => {
    const root = temp();
    const file = path.join(root, "task.md");
    const write = (flag: string) => fs.writeFileSync(file, `---\n${flag}on:\n  manual: {}\n---\nInspect.\n`);
    write("disabled: true\n");
    expect(discoverWorkflows(root)).toEqual({ workflows: [], errors: [] });
    write("disabled: false\n");
    expect(discoverWorkflows(root).workflows.map((item) => item.id)).toEqual(["task.md"]);
    write("");
    expect(discoverWorkflows(root).workflows.map((item) => item.id)).toEqual(["task.md"]);
  });

  it.each(['"true"', '"false"', "1", "null"])("rejects non-boolean disabled values: %s", (value) => {
    const root = temp();
    fs.writeFileSync(path.join(root, "task.md"), `---\ndisabled: ${value}\non:\n  manual: {}\n---\nInspect.\n`);
    expect(discoverWorkflows(root)).toMatchObject({ workflows: [], errors: [{ path: "task.md", errors: [expect.stringContaining("boolean")] }] });
  });

  it("does not require runtime providers for a disabled workflow", () => {
    const root = temp();
    fs.writeFileSync(path.join(root, "task.md"), `---\ndisabled: true\nagent: unavailable\non:\n  unavailable.event: {}\n---\nInspect.\n`);
    expect(discoverWorkflows(root, new Registry())).toEqual({ workflows: [], errors: [] });
  });

  it("parses declared Safe Action policies from strict frontmatter", () => {
    const root = temp();
    const file = path.join(root, "task.md");
    fs.writeFileSync(file, `---\nrepository: owner/repo\non:\n  manual: {}\nsafeActions:\n  test.complete:\n    max: 1\n    enabled: true\n---\nInspect.\n`);
    expect(parseWorkflow(file, root).safeActions).toEqual({ "test.complete": { max: 1, enabled: true } });
  });

  it("rejects removed control-plane frontmatter", () => {
    const root = temp();
    fs.writeFileSync(path.join(root, "task.md"), `---\nrepository: owner/repo\non:\n  test.item: {}\nagent: fake\nsafe-actions: [github.issue.resolve]\n---\nWork.\n`);
    expect(() => parseWorkflow(path.join(root, "task.md"), root)).toThrow("Unrecognized key");
  });

  it("discovers nested workflows and validates trigger configuration", () => {
    const root = temp();
    const deep = path.join(root, "one", "two");
    fs.mkdirSync(deep, { recursive: true });
    fs.writeFileSync(path.join(deep, "task.md"), `---\nrepository: owner/repo\non:\n  test.item:\n    allowed: true\nagent: fake\n---\nWork.\n`);
    const registry = new Registry();
    registry.setOwner("test");
    registry.events.registerSource("test.item", { configSchema: z.object({ allowed: z.boolean() }).strict(), start() {} });
    registry.agents.register("fake", { run() {} });
    registry.workspaces.register("worktree", {
      create: () => ({ path: root }),
      attest: () => ({ version: 1, path: root, revision: "0".repeat(40), clean: true, verifiedAt: "now" }),
    });
    registry.executions.register("host", { isolation: "none", open: () => ({ process: new CoreProcessAPI(), close() {} }) });
    expect(discoverWorkflows(root, registry).workflows.map((item) => item.id)).toEqual(["one/two/task.md"]);
  });

  it("validates and retains registered extension-owned frontmatter", () => {
    const root = temp();
    const registry = new Registry();
    registry.setOwner("policy");
    registry.workflows.registerField("policy.context", {
      schema: z.object({ instructions: z.string().min(1) }).strict(),
    });
    fs.writeFileSync(path.join(root, "task.md"), `---\nrepository: owner/repo\non:\n  manual: {}\npolicy.context:\n  instructions: Check releases.\n---\nWork.\n`);
    expect(parseWorkflow(path.join(root, "task.md"), root, registry).extensions).toEqual({
      "policy.context": { instructions: "Check releases." },
    });
    registry.removeOwner("policy");
    expect(() => parseWorkflow(path.join(root, "task.md"), root, registry)).toThrow("unknown workflow frontmatter field: policy.context");
  });

  it("rejects unknown Safe Actions and invalid extension-owned policies", () => {
    const root = temp();
    const registry = new Registry();
    registry.setOwner("test");
    registry.events.registerSource("test.item", { start() {} });
    registry.agents.register("fake", { run() {} });
    registry.workspaces.register("worktree", {
      create: () => ({ path: root }),
      attest: () => ({ version: 1, path: root, revision: "0".repeat(40), clean: true, verifiedAt: "now" }),
    });
    registry.executions.register("host", { isolation: "none", open: () => ({ process: new CoreProcessAPI(), close() {} }) });
    registry.actions.register("test.complete", {
      schema: z.object({ decision: z.literal("complete") }),
      policySchema: z.object({ max: z.literal(1), allowed: z.literal(true) }).strict(),
      prepare: () => ({}), executePrepared: () => ({}),
    });
    fs.writeFileSync(path.join(root, "invalid.md"), `---\nrepository: owner/repo\nagent: fake\non:\n  test.item: {}\nsafeActions:\n  test.complete:\n    max: 1\n    allowed: false\n---\nWork.\n`);
    expect(discoverWorkflows(root, registry).errors[0]?.errors[0]).toContain("Invalid policy for Safe Action test.complete");
    fs.writeFileSync(path.join(root, "invalid.md"), `---\nrepository: owner/repo\nagent: fake\non:\n  test.item: {}\nsafeActions:\n  unknown.action:\n    max: 1\n---\nWork.\n`);
    expect(discoverWorkflows(root, registry).errors[0]?.errors).toContain("Unknown Safe Action: unknown.action");
  });

  it("rejects duplicate capability names", () => {
    const registry = new Registry();
    registry.setOwner("one");
    registry.agents.register("same", { run() {} });
    registry.setOwner("two");
    expect(() => registry.agents.register("same", { run() {} })).toThrow("Duplicate agent");
  });
});

describe("runtime", () => {
  it("removes disabled workflow subscriptions and rejects new runs while preserving snapshot replay", async () => {
    const home = temp();
    ensureHome(resolvePaths(home));
    fs.writeFileSync(resolvePaths(home).config, JSON.stringify({ extensions: {} }));
    writeWorkflow(home);
    const file = path.join(home, "automations", "task.md");
    const original = fs.readFileSync(file, "utf8");
    let subscriptions: readonly WorkflowSubscription[] = [];
    const instance = new Runtime({ home, builtins: [{ extension: runtimeExtension({ agent: () => {}, subscriptions: (value) => { subscriptions = value; } }) }] });
    try {
      await instance.initialize();
      await instance.start();
      expect(subscriptions.map((item) => item.workflowId)).toEqual(["task.md"]);
      const existing = instance.runManual("task");
      await instance.idle();

      fs.writeFileSync(file, original.replace("---\n", "---\ndisabled: true\n"));
      instance.reloadWorkflows();
      expect(instance.workflowErrors).toEqual([]);
      expect(subscriptions).toEqual([]);
      expect(await instance.receive(event("disabled"))).toMatchObject({ status: "accepted", runIds: [] });
      expect(() => instance.runManual("task")).toThrow("Workflow not found: task");
      expect(() => instance.replayRun(existing.id, { workflow: "current" })).toThrow("Current workflow not found");
      expect(instance.database.getRun(existing.id)?.status).toBe("completed");
      const replay = instance.replayRun(existing.id);
      await instance.idle();
      expect(instance.database.getRun(replay.id)?.status).toBe("completed");

      fs.writeFileSync(file, original.replace("---\n", "---\ndisabled: false\n"));
      instance.reloadWorkflows();
      expect(subscriptions.map((item) => item.workflowId)).toEqual(["task.md"]);
      const enabled = instance.runManual("task");
      await instance.idle();
      expect(instance.database.getRun(enabled.id)?.status).toBe("completed");
    } finally {
      await instance.stop();
    }
  });

  it("gives a run its full timeout after waiting in the queue", async () => {
    const home = temp();
    ensureHome(resolvePaths(home));
    fs.writeFileSync(resolvePaths(home).config, JSON.stringify({ runtime: { timeout: 1_000 }, extensions: {} }));
    writeWorkflow(home);
    const agent = vi.fn();
    const instance = new Runtime({ home, builtins: [{ extension: runtimeExtension({ agent }) }] });
    await instance.initialize();
    const queued = await instance.receive(event());
    if (queued.status !== "accepted") throw new Error("Event not admitted");
    const id = queued.runIds?.[0]!;
    expect(instance.database.getRun(id)?.deadline).toBeUndefined();
    instance.database.db.prepare("UPDATE runs SET created_at = ? WHERE id = ?")
      .run(new Date(Date.now() - 30 * 60_000).toISOString(), id);

    await instance.idle();
    expect(agent).toHaveBeenCalledTimes(1);
    expect(instance.database.getRun(id)).toMatchObject({ status: "completed", deadline: expect.any(Number) });
    await instance.stop();
  });

  it("records execution timeout as primary error and attests with a live cleanup signal", async () => {
    const home = temp();
    ensureHome(resolvePaths(home));
    fs.writeFileSync(resolvePaths(home).config, JSON.stringify({ runtime: { timeout: 80 }, extensions: {} }));
    writeWorkflow(home);
    const attestationSignals: boolean[] = [];
    const cleanupSignals: boolean[] = [];
    const extension: Extension = {
      name: "timeout-test",
      setup(api) {
        api.events.registerSource("test.item", { start() {}, match: () => true });
        api.agents.register("fake", { run: (context) => new Promise((_resolve, reject) => {
          context.signal.addEventListener("abort", () => reject(new Error("agent interrupted")), { once: true });
        }) });
        api.workspaces.register("worktree", {
          create: (context) => ({ path: path.join(api.paths.workspaces, context.run.id) }),
          attest: (context, workspace) => {
            attestationSignals.push(context.signal.aborted);
            if (attestationSignals.length === 2) throw new Error("attestation diagnostic");
            return { version: 1, path: workspace.path, revision: "0".repeat(40), repository: context.repository, clean: true, verifiedAt: "now" };
          },
          cleanup: (context) => { cleanupSignals.push(context.signal.aborted); },
        });
        api.executions.register("host", { isolation: "none", open: () => ({ process: api.process, close() {} }) });
      },
    };
    const instance = new Runtime({ home, builtins: [{ extension }] });
    await instance.initialize();
    const admitted = await instance.receive(event());
    if (admitted.status !== "accepted") throw new Error("Event not admitted");
    await instance.idle();
    const result = instance.database.getRun(admitted.runIds?.[0]!);
    expect(result).toMatchObject({ status: "failed", error: "Run deadline exceeded", outcome: { reason: "Run deadline exceeded" } });
    expect(attestationSignals).toEqual([false, false]);
    expect(cleanupSignals).toEqual([false]);
    await instance.stop();
  });

  it("removes an expired terminal run and its per-run log when the daemon starts", async () => {
    const home = temp();
    const paths = resolvePaths(home);
    ensureHome(paths);
    fs.writeFileSync(resolvePaths(home).config, JSON.stringify({ history: { retention: "1ms" }, extensions: {} }));
    const instance = new Runtime({ home });
    const timestamp = "2026-01-01T00:00:00.000Z";
    const expired: Run = {
      ...run(), id: "rp_expired", event: event("expired-event"), status: "completed", createdAt: timestamp, updatedAt: timestamp,
    };
    instance.database.insertEvent(expired.event);
    instance.database.insertRun(expired, "fake", "host", "worktree", { workflow: workflow() });
    const log = path.join(paths.logs, `${expired.id}.log`);
    fs.writeFileSync(log, "expired run log\n");

    await instance.initialize();
    await instance.start();
    expect(instance.database.getRun(expired.id)).toBeUndefined();
    expect(fs.existsSync(log)).toBe(false);
    expect(instance.database.hasEvent(expired.event.id)).toBe(true);
    await instance.stop();
  });

  it("restarts only the selected extension source and stops it when disabled", async () => {
    const home = temp();
    ensureHome(resolvePaths(home));
    fs.writeFileSync(resolvePaths(home).config, JSON.stringify({ extensions: { hot: { enabled: true } } }));
    let starts = 0;
    let stops = 0;
    const hot: Extension = {
      name: "hot",
      setup(api) {
        api.events.registerSource("hot.item", { start() { starts++; }, stop() { stops++; } });
      },
    };
    const instance = new Runtime({ home, builtins: [{ extension: hot }] });
    await instance.initialize();
    await instance.start();
    expect(starts).toBe(1);
    await instance.reloadExtension("hot");
    expect({ starts, stops }).toEqual({ starts: 2, stops: 1 });
    setExtensionEnabled(resolvePaths(home).config, "hot", false);
    await instance.reloadExtension("hot");
    expect({ starts, stops }).toEqual({ starts: 2, stops: 2 });
    await instance.stop();
  });

  it("keeps enabled metadata out of extension config and can reload or disable one local extension", async () => {
    const home = temp();
    const paths = resolvePaths(home);
    ensureHome(paths);
    fs.writeFileSync(resolvePaths(home).config, JSON.stringify({ extensions: { personal: { enabled: true, message: "hello" } } }));
    const directory = path.join(paths.extensions, "personal");
    fs.mkdirSync(directory);
    const file = path.join(directory, "index.ts");
    const source = (field: string) => `import { defineExtension, z } from "@mixer/automations-sdk"; export default defineExtension({ name: "personal", setup(api) { if (JSON.stringify(api.config.get()) !== '{"message":"hello"}') throw new Error("bad config"); api.workflows.registerField("${field}", { schema: z.string() }); } });`;
    fs.writeFileSync(file, source("personal.one"));
    const instance = new Runtime({ home });
    await instance.initialize();
    expect(instance.registry.workflowFieldDefinitions.has("personal.one")).toBe(true);
    fs.writeFileSync(file, source("personal.two"));
    const next = new Date(Date.now() + 2_000);
    fs.utimesSync(file, next, next);
    await instance.reloadExtension("personal");
    expect([...instance.registry.workflowFieldDefinitions.keys()]).toEqual(["personal.two"]);
    setExtensionEnabled(resolvePaths(home).config, "personal", false);
    expect((await instance.reloadExtension("personal")).enabled).toBe(false);
    expect(instance.registry.workflowFieldDefinitions.size).toBe(0);
    await instance.stop();
  });

  it("turns one matching event into one normal autonomous prompt", async () => {
    const home = temp();
    ensureHome(resolvePaths(home));
    fs.writeFileSync(resolvePaths(home).config, JSON.stringify({ extensions: {} }));
    writeWorkflow(home);
    const agent = vi.fn();
    const instance = new Runtime({ home, builtins: [{ extension: runtimeExtension({ agent }) }] });
    await instance.initialize();
    expect(await instance.receive(event())).toMatchObject({ version: 1, status: "accepted", runIds: [expect.any(String)] });
    expect(await instance.receive(event())).toEqual({ version: 1, eventId: "event-1", status: "duplicate", reason: "duplicate_event" });
    await instance.idle();
    expect(agent).toHaveBeenCalledTimes(1);
    expect(agent.mock.calls[0]?.[0]).toMatchObject({
      model: "test-model", thinking: "high", workspaceAccess: "read-write", actions: [],
    });
    const prompt = agent.mock.calls[0]?.[0].prompt as string;
    expect(prompt).toContain("Handle the issue.");
    expect(prompt).toContain("Event: test.item");
    expect(prompt).toContain("https://github.com/owner/repo/issues/7");
    const recorded = instance.database.listRuns()[0];
    expect(recorded).toMatchObject({
      status: "completed", agent: "fake", execution: "host", workspace: "worktree",
      effectiveWorkspace: { initial: { clean: true } }, outcome: { version: 1, outcome: "no-op" },
    });
    expect(instance.database.getWorkflowSnapshot(recorded!.id)?.thinking).toBe("high");
    expect(path.dirname(recorded!.effectiveWorkspace!.initial.path)).toBe(path.join(home, ".roboplane", "workspaces"));
    await instance.stop();
  });

  it("expands repository subscriptions and binds each event and manual run to one configured repository", async () => {
    const home = temp();
    ensureHome(resolvePaths(home));
    fs.writeFileSync(resolvePaths(home).config, JSON.stringify({ extensions: {} }));
    fs.writeFileSync(path.join(home, "automations", "task.md"), `---\nrepository: [owner/one, owner/two]\nagent: fake\non:\n  test.item: {}\n---\nHandle it.\n`);
    const agent = vi.fn();
    let subscriptions: readonly WorkflowSubscription[] = [];
    const instance = new Runtime({ home, builtins: [{ extension: runtimeExtension({ agent, subscriptions: (value) => { subscriptions = value; } }) }] });
    await instance.initialize();
    await instance.start();
    expect(subscriptions.map((subscription) => subscription.repository)).toEqual(["owner/one", "owner/two"]);

    expect(await instance.receive({ ...event("other"), repository: "owner/other" })).toMatchObject({ status: "accepted", runIds: [] });
    expect(await instance.receive({ ...event("two"), repository: "owner/two" })).toMatchObject({ status: "accepted", runIds: [expect.any(String)] });
    expect(() => instance.runManual("task")).toThrow("specify --repository");
    expect(() => instance.runManual("task", {}, "owner/other")).toThrow("is not configured");
    const manual = instance.runManual("task", {}, "owner/one");
    expect(manual.repository).toBe("owner/one");
    await instance.idle();
    expect(instance.database.getRun(manual.id)?.repository).toBe("owner/one");
    expect(agent.mock.calls.map((call) => call[0].repository).sort()).toEqual(["owner/one", "owner/two"]);
    await instance.stop();
  });

  it("executes only a workflow-authorized serialized Safe Action after the harness exits", async () => {
    const home = temp();
    ensureHome(resolvePaths(home));
    fs.writeFileSync(resolvePaths(home).config, JSON.stringify({ extensions: {} }));
    fs.writeFileSync(path.join(home, "automations", "task.md"), `---\nrepository: owner/repo\nagent: fake\non:\n  test.item: {}\nsafeActions:\n  test.complete:\n    max: 1\n---\nHandle it.\n`);
    const execute = vi.fn(() => ({ completed: true }));
    let received: AgentContext | undefined;
    const agent = vi.fn((context: AgentContext) => {
      received = context;
      return {
      version: 1 as const, outcome: "acted" as const,
      actions: [{ name: "test.complete", input: { decision: "complete" } }],
      };
    });
    const instance = new Runtime({ home, builtins: [{ extension: runtimeExtension({ agent, safeAction: execute }) }] });
    await instance.initialize();
    await instance.receive(event());
    await instance.idle();
    expect(received!.actions).toEqual([expect.objectContaining({ name: "test.complete" })]);
    expect(received!.prompt).toContain("test.complete");
    expect(execute).toHaveBeenCalledWith({ decision: "complete" });
    expect(instance.database.listActions(instance.database.listRuns()[0]!.id)).toEqual([
      expect.objectContaining({ action: "test.complete", status: "executed", result: { completed: true } }),
    ]);
    expect(instance.database.getRun(instance.database.listRuns()[0]!.id)?.outcome).toMatchObject({ outcome: "acted" });
    await instance.stop();
  });

  it("rejects an undeclared Safe Action requested by the harness", async () => {
    const home = temp();
    ensureHome(resolvePaths(home));
    fs.writeFileSync(resolvePaths(home).config, JSON.stringify({ extensions: {} }));
    writeWorkflow(home);
    const execute = vi.fn();
    const agent = () => ({ version: 1 as const, outcome: "acted" as const, actions: [{ name: "test.complete", input: { decision: "complete" } }] });
    const instance = new Runtime({ home, builtins: [{ extension: runtimeExtension({ agent, safeAction: execute }) }] });
    await instance.initialize();
    await instance.receive(event());
    await instance.idle();
    expect(execute).not.toHaveBeenCalled();
    expect(instance.database.getRun(instance.database.listRuns()[0]!.id)?.outcome).toMatchObject({ outcome: "blocked", reason: "Safe Action rejected: safe_action_not_allowed" });
    await instance.stop();
  });

  it("reconciles a durable Safe Action effect after restart without rerunning its harness", async () => {
    const home = temp();
    const paths = resolvePaths(home);
    ensureHome(paths);
    fs.writeFileSync(resolvePaths(home).config, JSON.stringify({ extensions: {} }));
    fs.writeFileSync(path.join(home, "automations", "task.md"), `---\nrepository: owner/repo\nagent: fake\non:\n  test.item: {}\nsafeActions:\n  test.complete:\n    max: 1\n---\nHandle it.\n`);
    const persistedWorkflow = {
      ...workflow(),
      path: path.join(home, "automations", "task.md"),
      safeActions: { "test.complete": { max: 1 } },
    };
    const database = new StateDatabase(paths.state);
    database.insertEvent(event());
    database.insertRun(run(), "fake", "host", "worktree", { workflow: persistedWorkflow });
    database.insertAction({
      id: "act_recover", runId: "rp_test", action: "test.complete",
      payload: { decision: "complete" }, status: "validated", createdAt: new Date().toISOString(),
    });
    database.insertPlan({
      id: "plan_recover", runId: "rp_test", hash: "persisted-plan-hash", status: "applying",
      createdAt: new Date().toISOString(),
      plan: { version: 1, runId: "rp_test", actions: [{ id: "act_recover", action: "test.complete", payload: { decision: "complete" }, prepared: { decision: "complete" } }] },
    });
    database.insertEffect("effect_recover", "plan_recover", 0, "persisted-plan-hash:0", { decision: "complete" });
    database.close();

    const execute = vi.fn(() => ({ completed: true }));
    const agent = vi.fn();
    const instance = new Runtime({ home, builtins: [{ extension: runtimeExtension({ agent, safeAction: execute }) }] });
    await instance.initialize();

    expect(agent).not.toHaveBeenCalled();
    expect(execute).toHaveBeenCalledOnce();
    expect(instance.database.getPlan("rp_test")?.status).toBe("completed");
    expect(instance.database.getRun("rp_test")).toMatchObject({ status: "completed", phase: "recovered" });
    expect(instance.database.listActions("rp_test")).toEqual([
      expect.objectContaining({ id: "act_recover", status: "executed", result: { completed: true } }),
    ]);
    await instance.stop();
  });

  it("fails closed before invoking the harness when workspace attestation fails", async () => {
    const home = temp();
    ensureHome(resolvePaths(home));
    fs.writeFileSync(resolvePaths(home).config, JSON.stringify({ extensions: {} }));
    writeWorkflow(home);
    const agent = vi.fn();
    const instance = new Runtime({ home, builtins: [{ extension: runtimeExtension({ agent, dirtyAttestation: true }) }] });
    await instance.initialize();
    await instance.receive(event());
    await instance.idle();
    expect(agent).not.toHaveBeenCalled();
    expect(instance.database.listRuns()[0]).toMatchObject({ status: "failed", error: "Workspace attestation rejected a dirty initial checkout" });
    await instance.stop();
  });

  it("retries only when globally requested", async () => {
    const home = temp();
    ensureHome(resolvePaths(home));
    fs.writeFileSync(resolvePaths(home).config, JSON.stringify({ runtime: { maxAttempts: 2 }, extensions: {} }));
    writeWorkflow(home);
    let calls = 0;
    const agent = vi.fn(() => { calls++; if (calls === 1) throw new Error("temporary"); });
    const instance = new Runtime({ home, builtins: [{ extension: runtimeExtension({ agent }) }] });
    await instance.initialize();
    await instance.receive(event());
    await instance.idle();
    expect(agent).toHaveBeenCalledTimes(2);
    expect(instance.database.listRuns()[0]?.status).toBe("completed");
    await instance.stop();
  });

  it("closes the harness before cleaning its checkout", async () => {
    const home = temp();
    ensureHome(resolvePaths(home));
    fs.writeFileSync(resolvePaths(home).config, JSON.stringify({ extensions: {} }));
    writeWorkflow(home);
    const order: string[] = [];
    const instance = new Runtime({ home, builtins: [{ extension: runtimeExtension({ agent: () => { throw new Error("failed"); }, order }) }] });
    await instance.initialize();
    await instance.receive(event());
    await instance.idle();
    expect(order).toEqual(["execution", "workspace"]);
    expect(instance.database.listRuns()[0]?.status).toBe("failed");
    await instance.stop();
  });

  it("finalizes run hooks after a failed harness", async () => {
    const home = temp();
    ensureHome(resolvePaths(home));
    fs.writeFileSync(resolvePaths(home).config, JSON.stringify({ extensions: {} }));
    writeWorkflow(home);
    const after = vi.fn();
    const instance = new Runtime({ home, builtins: [{ extension: runtimeExtension({ agent: () => { throw new Error("failed"); }, after }) }] });
    await instance.initialize();
    await instance.receive(event());
    await instance.idle();
    expect(after).toHaveBeenCalledWith(expect.objectContaining({ succeeded: false, error: "failed" }));
    await instance.stop();
  });

  it("emits one terminal finalized hook with the final failure", async () => {
    const home = temp();
    ensureHome(resolvePaths(home));
    fs.writeFileSync(resolvePaths(home).config, JSON.stringify({ runtime: { maxAttempts: 2 }, extensions: {} }));
    writeWorkflow(home);
    const finalized = vi.fn();
    const instance = new Runtime({ home, builtins: [{ extension: runtimeExtension({
      agent: () => { throw new Error("terminal failure"); }, finalized,
    }) }] });
    await instance.initialize();
    await instance.receive(event());
    await instance.idle();
    expect(finalized).toHaveBeenCalledTimes(1);
    expect(finalized).toHaveBeenCalledWith(expect.objectContaining({
      status: "failed", succeeded: false, attempt: 2, error: "terminal failure",
    }));
    await instance.stop();
  });

  it("does not fail successful managed runs with a missing report", async () => {
    const home = temp();
    ensureHome(resolvePaths(home));
    fs.writeFileSync(resolvePaths(home).config, JSON.stringify({ extensions: {} }));
    writeWorkflow(home);
    const extension = runtimeExtension({ agent: () => ({ output: "legacy" }) });
    const instance = new Runtime({ home, builtins: [{ extension }] });
    await instance.initialize();
    await instance.receive(event());
    await instance.idle();
    expect(instance.database.listRuns()[0]).toMatchObject({
      status: "completed",
      outcome: { version: 1, outcome: "unknown", output: "legacy", reason: "report_missing" },
    });
    await instance.stop();
  });

  it("does not fail successful managed runs with a malformed report", async () => {
    const home = temp();
    ensureHome(resolvePaths(home));
    fs.writeFileSync(resolvePaths(home).config, JSON.stringify({ extensions: {} }));
    writeWorkflow(home);
    const output = 'Completed the task.\nMIXER_AUTOMATIONS_RESULT: {"version":1,"outcome":"done"}';
    const instance = new Runtime({ home, builtins: [{ extension: runtimeExtension({ agent: () => ({ output }) }) }] });
    await instance.initialize();
    await instance.receive(event());
    await instance.idle();
    expect(instance.database.listRuns()[0]).toMatchObject({
      status: "completed", outcome: { version: 1, outcome: "unknown", reason: "report_invalid" },
    });
    await instance.stop();
  });

  it("normalizes legacy results in unsafe-direct mode", async () => {
    const home = temp();
    ensureHome(resolvePaths(home));
    fs.writeFileSync(resolvePaths(home).config, JSON.stringify({ runtime: { mode: "unsafe-direct" }, extensions: {} }));
    writeWorkflow(home);
    const instance = new Runtime({ home, builtins: [{ extension: runtimeExtension({ agent: () => ({ output: "changed files" }) }) }] });
    await instance.initialize();
    await instance.receive(event());
    await instance.idle();
    expect(instance.database.listRuns()[0]).toMatchObject({
      status: "completed", outcome: { version: 1, outcome: "acted", output: "changed files", reason: "legacy_agent_result" },
    });
    await instance.stop();
  });

  it("persists cancellation and aborts an active run", async () => {
    const home = temp();
    ensureHome(resolvePaths(home));
    fs.writeFileSync(resolvePaths(home).config, JSON.stringify({ extensions: {} }));
    writeWorkflow(home);
    const started = vi.fn();
    const instance = new Runtime({ home, builtins: [{ extension: runtimeExtension({
      agent: ({ signal }) => new Promise((_, reject) => {
        started();
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      }),
    }) }] });
    await instance.initialize();
    const admitted = await instance.receive(event());
    const runId = admitted.runIds![0]!;
    await vi.waitFor(() => expect(started).toHaveBeenCalledOnce());
    expect(instance.cancelRun(runId, "operator request")).toBe(true);
    await instance.idle();
    expect(instance.database.getRun(runId)).toMatchObject({
      status: "cancelled", cancellation: { reason: "operator request" },
      outcome: { version: 1, outcome: "blocked", reason: "operator request" },
    });
    await instance.stop();
  });

  it("drains an active run during graceful shutdown", async () => {
    const home = temp();
    ensureHome(resolvePaths(home));
    fs.writeFileSync(resolvePaths(home).config, JSON.stringify({ extensions: {} }));
    writeWorkflow(home);
    let finish!: () => void;
    const active = new Promise<void>((resolve) => { finish = resolve; });
    const started = vi.fn();
    const instance = new Runtime({ home, builtins: [{ extension: runtimeExtension({
      agent: async ({ signal }) => {
        started();
        await active;
        expect(signal.aborted).toBe(false);
      },
    }) }] });
    await instance.initialize();
    await instance.receive(event());
    await vi.waitFor(() => expect(started).toHaveBeenCalledTimes(1));
    const stopping = instance.stop();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(instance.database.getRun(instance.database.listRuns()[0]!.id)?.status).toBe("running");
    finish();
    await stopping;

    const database = new StateDatabase(resolvePaths(home).state);
    expect(database.listRuns()[0]?.status).toBe("completed");
    database.close();
  });

  it("does not consume an event when routing fails", async () => {
    const home = temp();
    ensureHome(resolvePaths(home));
    fs.writeFileSync(resolvePaths(home).config, JSON.stringify({ extensions: {} }));
    writeWorkflow(home);
    let fail = true;
    const agent = vi.fn();
    const instance = new Runtime({ home, builtins: [{ extension: runtimeExtension({
      agent,
      match: () => {
        if (fail) throw new Error("temporary matcher failure");
        return true;
      },
    }) }] });
    await instance.initialize();
    await expect(instance.receive(event())).rejects.toThrow("temporary matcher failure");
    fail = false;
    expect(await instance.receive(event())).toMatchObject({ status: "accepted" });
    await instance.idle();
    expect(agent).toHaveBeenCalledTimes(1);
    await instance.stop();
  });

  it("passes the candidate workflow id to event matchers", async () => {
    const home = temp();
    ensureHome(resolvePaths(home));
    fs.writeFileSync(resolvePaths(home).config, JSON.stringify({ extensions: {} }));
    writeWorkflow(home);
    const operations: Array<OperationContext | undefined> = [];
    const instance = new Runtime({ home, builtins: [{ extension: runtimeExtension({
      agent: vi.fn(),
      match: (_event, _config, operation) => {
        operations.push(operation);
        return true;
      },
    }) }] });
    await instance.initialize();
    await instance.receive(event());
    await instance.idle();
    expect(operations).toHaveLength(2);
    expect(operations.every((operation) => operation?.workflowId === "task.md")).toBe(true);
    await instance.stop();
  });

  it("revalidates an activated event before creating a workspace", async () => {
    const home = temp();
    ensureHome(resolvePaths(home));
    fs.writeFileSync(resolvePaths(home).config, JSON.stringify({ extensions: {} }));
    writeWorkflow(home);
    let matches = 0;
    const agent = vi.fn();
    const instance = new Runtime({ home, builtins: [{ extension: runtimeExtension({
      agent,
      match: () => ++matches === 1,
      activate: () => ({ data: { state: "closed" } }),
    }) }] });
    await instance.initialize();
    await instance.receive(event());
    await instance.idle();
    expect(agent).not.toHaveBeenCalled();
    expect(instance.database.listRuns()[0]).toMatchObject({
      status: "completed", outcome: { version: 1, outcome: "no-op", reason: "event_no_longer_matches" },
    });
    await instance.stop();
  });

  it("replays a terminal run with lineage and fresh activation", async () => {
    const home = temp();
    ensureHome(resolvePaths(home));
    fs.writeFileSync(resolvePaths(home).config, JSON.stringify({ extensions: {} }));
    writeWorkflow(home);
    let revision = "1".repeat(40);
    const agent = vi.fn();
    const instance = new Runtime({ home, builtins: [{ extension: runtimeExtension({
      agent,
      activate: () => ({ data: { refreshed: revision }, workspaceSource: { repository: "owner/repo", revision } }),
    }) }] });
    await instance.initialize();
    await instance.receive(event());
    await instance.idle();
    const source = instance.database.listRuns()[0]!;

    revision = "2".repeat(40);
    const replay = instance.replayRun(source.id);
    expect(replay.repository).toBe("owner/repo");
    expect(() => instance.replayRun(source.id)).toThrow(`Replay already active for this lineage: ${replay.id}`);
    await instance.idle();

    expect(agent).toHaveBeenCalledTimes(2);
    expect(agent.mock.calls[1]?.[0].event.data).toEqual({ refreshed: revision });
    expect(replay.event.provenance).toEqual({
      kind: "replay", sourceRunId: source.id, rootRunId: source.id, sourceEventId: source.event.id,
    });
    expect(instance.database.getRun(replay.id)).toMatchObject({ status: "completed", sourceRevision: revision });
    expect(instance.database.getReplayForRun(replay.id)).toMatchObject({
      sourceRunId: source.id, rootRunId: source.id, workflowMode: "snapshot",
    });
    await instance.stop();
  });

  it("rejects replaying a non-terminal run", async () => {
    const home = temp();
    ensureHome(resolvePaths(home));
    fs.writeFileSync(resolvePaths(home).config, JSON.stringify({ extensions: {} }));
    writeWorkflow(home);
    const instance = new Runtime({ home, builtins: [{ extension: runtimeExtension({ agent: vi.fn() }) }] });
    await instance.initialize();
    instance.database.insertEvent(event());
    instance.database.insertRun(run(), "fake", "host", "worktree", { workflow: workflow() });
    expect(() => instance.replayRun("rp_test")).toThrow("cannot be replayed while running");
    instance.database.updateRun("rp_test", "cancelled");
    expect(instance.replayRun("rp_test").event.provenance).toMatchObject({ kind: "replay", rootRunId: "rp_test" });
    await instance.idle();
    await instance.stop();
  });

  it("rejects current-workflow replay when the source repository is no longer configured", async () => {
    const home = temp();
    ensureHome(resolvePaths(home));
    fs.writeFileSync(resolvePaths(home).config, JSON.stringify({ extensions: {} }));
    writeWorkflow(home);
    const instance = new Runtime({ home, builtins: [{ extension: runtimeExtension({ agent: vi.fn() }) }] });
    await instance.initialize();
    await instance.receive(event());
    await instance.idle();
    const source = instance.database.listRuns()[0]!;

    fs.writeFileSync(path.join(home, "automations", "task.md"), `---\nrepository: [owner/other, owner/third]\nagent: fake\non:\n  test.item: {}\n---\nHandle it.\n`);
    instance.reloadWorkflows();
    expect(() => instance.replayRun(source.id, { workflow: "current" })).toThrow("is not configured");
    expect(instance.replayRun(source.id).repository).toBe("owner/repo");
    await instance.idle();
    await instance.stop();
  });

  it("reroutes an unmatched persisted event through current workflow matchers", async () => {
    const home = temp();
    ensureHome(resolvePaths(home));
    fs.writeFileSync(resolvePaths(home).config, JSON.stringify({ extensions: {} }));
    writeWorkflow(home);
    let matches = false;
    const agent = vi.fn();
    const instance = new Runtime({ home, builtins: [{ extension: runtimeExtension({
      agent,
      match: () => matches,
    }) }] });
    await instance.initialize();
    const original = event();
    expect(await instance.receive(original)).toMatchObject({ status: "accepted", runIds: [] });

    matches = true;
    const result = await instance.rerouteEvent(original.id);
    expect(result).toMatchObject({ status: "accepted" });
    expect(result.runIds).toHaveLength(1);
    await instance.idle();

    expect(agent).toHaveBeenCalledTimes(1);
    expect(agent.mock.calls[0]?.[0].event).toMatchObject({
      type: original.type,
      source: original.source,
      actor: original.actor,
      repository: original.repository,
      data: original.data,
      provenance: { kind: "reroute", sourceEventId: original.id },
    });
    expect(agent.mock.calls[0]?.[0].event.id).not.toBe(original.id);
    expect(instance.database.getRerouteForSourceEvent(original.id)).toMatchObject({ eventId: result.eventId });
    expect(await instance.rerouteEvent(original.id)).toMatchObject({ status: "duplicate", reason: "duplicate_reroute" });
    await expect(instance.rerouteEvent(result.eventId)).rejects.toThrow(`Cannot reroute synthetic event: ${result.eventId}`);
    await instance.stop();
  });

  it("does not consume reroute eligibility when routing fails", async () => {
    const home = temp();
    ensureHome(resolvePaths(home));
    fs.writeFileSync(resolvePaths(home).config, JSON.stringify({ extensions: {} }));
    writeWorkflow(home);
    let mode: "skip" | "fail" | "match" = "skip";
    const agent = vi.fn();
    const instance = new Runtime({ home, builtins: [{ extension: runtimeExtension({
      agent,
      match: () => {
        if (mode === "fail") throw new Error("temporary matcher failure");
        return mode === "match";
      },
    }) }] });
    await instance.initialize();
    const original = event();
    await instance.receive(original);
    mode = "fail";
    await expect(instance.rerouteEvent(original.id)).rejects.toThrow("temporary matcher failure");
    expect(instance.database.getRerouteForSourceEvent(original.id)).toBeUndefined();
    mode = "match";
    expect(await instance.rerouteEvent(original.id)).toMatchObject({ status: "accepted" });
    await instance.idle();
    expect(agent).toHaveBeenCalledTimes(1);
    await instance.stop();
  });

  it("rejects rerouting an event that already created a run", async () => {
    const home = temp();
    ensureHome(resolvePaths(home));
    fs.writeFileSync(resolvePaths(home).config, JSON.stringify({ extensions: {} }));
    writeWorkflow(home);
    const instance = new Runtime({ home, builtins: [{ extension: runtimeExtension({ agent: vi.fn() }) }] });
    await instance.initialize();
    const original = event();
    await instance.receive(original);
    await instance.idle();
    await expect(instance.rerouteEvent(original.id)).rejects.toThrow(`Event already created runs; replay a run instead: ${original.id}`);
    await instance.stop();
  });
});

describe("configuration, persistence, and process supervision", () => {
  it("loads environment references and runtime defaults without a private dotenv file", () => {
    const home = temp();
    const paths = resolvePaths(home);
    ensureHome(paths);
    vi.stubEnv("GITHUB_TOKEN", "resolved");
    fs.writeFileSync(path.join(home, ".env"), "PRIVATE_ONLY=not-loaded\n");
    fs.writeFileSync(resolvePaths(home).config, JSON.stringify({ extensions: { github: { token: "${GITHUB_TOKEN}" } } }));
    expect(loadConfig(paths)).toMatchObject({
      extensions: { github: { token: "resolved" } },
      runtime: { concurrency: 1, maxAttempts: 1, timeout: 3_600_000, noOutputTimeout: 600_000, shutdownTimeout: 300_000 },
      history: { retention: 7 * 24 * 60 * 60 * 1_000 },
    });
    fs.writeFileSync(resolvePaths(home).config, JSON.stringify({ extensions: { github: { token: "${PRIVATE_ONLY}" } } }));
    expect(() => loadConfig(paths)).toThrow("Missing environment variable PRIVATE_ONLY at config.extensions.github.token");
  });

  it("rejects unknown configuration keys", () => {
    const home = temp();
    const paths = resolvePaths(home);
    ensureHome(paths);
    fs.writeFileSync(resolvePaths(home).config, JSON.stringify({ agents: {}, runtime: { concurency: 2 } }));
    expect(() => loadConfig(paths)).toThrow("config.agents is no longer supported");
    fs.writeFileSync(resolvePaths(home).config, JSON.stringify({ runtime: { concurency: 2 } }));
    expect(() => loadConfig(paths)).toThrow();
    fs.writeFileSync(resolvePaths(home).config, JSON.stringify({ history: { retention: "one day" } }));
    expect(() => loadConfig(paths)).toThrow("use a positive duration");
  });

  it("deduplicates events and recovers interrupted runs", () => {
    const database = new StateDatabase(temp());
    expect(database.insertEvent(event())).toBe(true);
    expect(database.insertEvent(event())).toBe(false);
    database.insertRun(run(), "fake", "host", "worktree", { workflow: workflow() });
    expect(database.claimRun("rp_test", "worker")).toBe(true);
    database.releaseRun("rp_test", "worker");
    database.recoverInterruptedRuns(2);
    expect(database.getRun("rp_test")?.status).toBe("queued");
    database.close();
  });

  it("recovers pre-agent interruptions without spending an attempt", () => {
    const database = new StateDatabase(temp());
    database.insertEvent(event());
    database.insertRun(run(), "fake", "host", "worktree", { workflow: workflow() });
    expect(database.claimRun("rp_test", "worker")).toBe(true);
    database.updateRun("rp_test", "interrupted", "daemon stopped", "preparing");
    database.releaseRun("rp_test", "worker");

    database.recoverInterruptedRuns(1);

    expect(database.getRun("rp_test")).toMatchObject({ status: "queued", phase: "queued", attempts: 0 });
    database.close();
  });

  it("enforces one run per workflow and event", () => {
    const database = new StateDatabase(temp());
    database.insertEvent(event());
    expect(database.insertRun(run(), "fake", "host", "worktree", { workflow: workflow() })).toBe(true);
    expect(database.insertRun({ ...run(), id: "rp_duplicate" }, "fake", "host", "worktree", { workflow: workflow() })).toBe(false);
    expect(database.listRuns()).toHaveLength(1);
    database.close();
  });

  it("closes stdin and aborts a silent unattended process", async () => {
    await expect(new CoreProcessAPI().run({
      command: process.execPath,
      args: ["-e", "setTimeout(() => {}, 1000)"],
      noOutputTimeout: 30,
    })).rejects.toThrow("produced no output");
  });

  it("reports spawn failures separately from command exit failures", async () => {
    await expect(new CoreProcessAPI().run({ command: "roboplane-command-that-does-not-exist" }))
      .resolves.toMatchObject({ exitCode: 1, errorCode: "ENOENT" });
  });

  it("redacts logged secrets", () => {
    expect(redactSecrets({ token: "plain", message: "Bearer abc" })).toEqual({ token: "[REDACTED]", message: "[REDACTED]" });
  });
});
