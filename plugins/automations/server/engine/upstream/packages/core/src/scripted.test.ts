import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import type { Event, Extension, WorkflowRunnerContext } from "@mixer/automations-sdk";
import steps from "../../extension-steps/src/index.js";
import scratch from "@roboplane/extension-scratch";
import host from "@roboplane/extension-container";
import { Registry } from "./registry.js";
import { Runtime } from "./runtime.js";
import { ensureHome, resolvePaths } from "./paths.js";
import { discoverWorkflows, parseWorkflow, resolveWorkflow } from "./workflows.js";
import { stepsSchema } from "../../extension-steps/src/schema.js";

const directories: string[] = [];
function temp() { const dir = fs.mkdtempSync(path.join(os.tmpdir(), "roboplane-scripted-")); directories.push(dir); return dir; }
afterEach(() => { for (const dir of directories.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
function registry() {
  const result = new Registry();
  result.setOwner("test");
  result.workflows.registerRunner("steps", { schema: stepsSchema, run: () => ({ version: 1, outcome: "no-op" }) });
  return result;
}
function file(source: string, extension = "yaml") {
  const root = temp(); const target = path.join(root, `task.${extension}`); fs.writeFileSync(target, source); return { root, target };
}
const minimal = "on:\n  schedule: {}\nsteps:\n  - run: echo hello\n";

describe("scripted workflow parsing", () => {
  it.each(["yaml", "yml"])("discovers nested .%s files", (extension) => {
    const root = temp(); fs.mkdirSync(path.join(root, "one", "two"), { recursive: true });
    fs.writeFileSync(path.join(root, "one", "two", `task.${extension}`), minimal);
    const found = discoverWorkflows(root, registry());
    // With a registry, unknown event sources are a semantic error, not a discovery failure.
    expect(found.errors[0]?.path).toBe(`one/two/task.${extension}`);
    const parsed = parseWorkflow(path.join(root, "one", "two", `task.${extension}`), root, registry());
    expect(parsed).toMatchObject({ id: `one/two/task.${extension}`, name: "one/two/task", agent: "", workspace: "scratch", task: { kind: "steps" } });
  });
  it.each([
    ["duplicate key", "name: one\nname: two\n" + minimal],
    ["multiple documents", minimal + "---\n" + minimal],
    ["root scalar", "hello"],
    ["empty steps", "on: {schedule: {}}\nsteps: []"],
    ["empty script", "on: {schedule: {}}\nsteps: [{run: '  '}]"],
    ["unknown field", minimal + "jobs: {}"],
    ["agent", minimal + "agent: codex"],
    ["invalid safe action limit", minimal + "safeActions: {test.effect: {max: 0}}"],
    ["duplicate id", "on: {schedule: {}}\nsteps: [{id: a, run: echo one}, {id: a, run: echo two}]"],
    ["unknown step", "on: {schedule: {}}\nsteps: [{run: echo one, uses: something}]"],
    ["invalid env", minimal + "env: {FLAG: true}"],
    ["reserved env", minimal + "env: {MIXER_AUTOMATIONS_RUN_ID: spoof}"],
    ["invalid directory", "on: {schedule: {}}\nsteps: [{run: echo one, working-directory: ../outside}]"],
    ["invalid timeout", "on: {schedule: {}}\nsteps: [{run: echo one, timeout: 0s}]"],
    ["invalid shell", "on: {schedule: {}}\nsteps: [{run: echo one, shell: fish}]"],
    ["invalid retry", "on: {schedule: {}}\nsteps: [{run: echo one, retry: {maxAttempts: 0}}]"],
    ["expression", "on: {schedule: {}}\nsteps: [{run: 'echo ${{ github.event }}'}]"],
    ["custom tag", "on: {schedule: {}}\nsteps: [{run: !command echo}]"],
    ["merge keys", minimal + "<<: {name: hidden}"],
    ["oversized id", `on: {schedule: {}}\nsteps: [{id: ${"a".repeat(65)}, run: echo one}]`],
    ["YAML 1.1", "%YAML 1.1\n---\n" + minimal],
    ["non-finite number", minimal + "env: {VALUE: .inf}"],
    ["circular aliases", minimal + "env: &cycle {VALUE: *cycle}"],
  ])("rejects %s", (_name, source) => {
    const { root, target } = file(source); expect(() => parseWorkflow(target, root, registry())).toThrow();
  });
  it("requires explicit filenames for ambiguous identifiers", () => {
    const { root, target } = file(minimal); const one = parseWorkflow(target, root, registry());
    const two = { ...one, id: "task.yml" };
    expect(resolveWorkflow([one, two], "task.yaml")).toBe(one);
    expect(() => resolveWorkflow([one, two], "task")).toThrow("Ambiguous");
  });
  it("accepts declared Safe Actions without requiring an agent", () => {
    const { root, target } = file(minimal + "safeActions: {test.effect: {max: 1}}\n");
    expect(parseWorkflow(target, root, registry())).toMatchObject({ agent: "", safeActions: { "test.effect": { max: 1 } }, task: { kind: "steps" } });
  });
  it("reports step field paths and positions", () => {
    const { root, target } = file("on: {schedule: {}}\nsteps:\n  - run: echo one\n    timeout: bad\n");
    expect(() => parseWorkflow(target, root, registry())).toThrow("4:14 steps.0.timeout");
  });
  it("validates disabled scripts but excludes them from discovery", () => {
    const { root, target } = file(minimal + "disabled: true\n");
    expect(parseWorkflow(target, root, registry()).disabled).toBe(true);
    expect(discoverWorkflows(root, registry())).toEqual({ workflows: [], errors: [] });
    fs.writeFileSync(target, "disabled: true\non: {schedule: {}}\nsteps: []\n");
    expect(discoverWorkflows(root, registry()).errors).toHaveLength(1);
  });
  it("accepts Unicode names and CRLF multiline scripts", () => {
    const { root, target } = file("name: Comprobar cambios\r\non: {schedule: {}}\r\nsteps:\r\n  - name: Verificación\r\n    run: |\r\n      echo hello\r\n      echo world\r\n");
    expect(parseWorkflow(target, root, registry()).name).toBe("Comprobar cambios");
  });
  it("rejects oversized documents", () => {
    const { root, target } = file(minimal + "#".repeat(1024 * 1024));
    expect(() => parseWorkflow(target, root, registry())).toThrow("size limit");
  });
});

async function execute(script: string, cancel = false, providerEnv?: Record<string, string>) {
  const home = temp();
  ensureHome(resolvePaths(home));
  if (providerEnv) fs.writeFileSync(resolvePaths(home).config, JSON.stringify({ extensions: { steps: { env: providerEnv } } }));
  const runtime = new Runtime({ home, builtins: [{ extension: steps }, { extension: scratch }, { extension: host }] });
  fs.writeFileSync(path.join(home, "automations", "task.yaml"), `on: {manual: {}}\n${script}`);
  // Manual invocation does not subscribe to an event source.
  runtime.registry.setOwner("test");
  runtime.registry.events.registerSource("manual", { start() {} });
  await runtime.initialize();
  const run = runtime.runManual("task");
  const idle = runtime.idle();
  if (cancel) {
    const deadline = Date.now() + 3000;
    while (!runtime.database.listSteps(run.id).some((step) => step.status === "running") && Date.now() < deadline) await delay(10);
    runtime.cancelRun(run.id);
  }
  await idle;
  const result = runtime.database.getRun(run.id);
  const records = runtime.database.listSteps(run.id);
  await runtime.stop();
  return { result, records };
}

describe("scripted runtime", () => {
  it("runs real shell steps and records results", async () => {
    const { result, records } = await execute("steps:\n  - id: first\n    run: printf hello > result.txt\n  - id: second\n    run: test \"$(cat result.txt)\" = hello\n");
    expect(result?.status, JSON.stringify({ error: result?.error, outcome: result?.outcome, records })).toBe("completed");
    expect(records.map((record) => [record.id, record.status])).toEqual([["first", "succeeded"], ["second", "succeeded"]]);
  });
  it("keeps failures sticky and executes diagnostic conditions", async () => {
    const { result, records } = await execute("steps:\n  - id: fail\n    run: exit 7\n  - id: skipped\n    run: exit 0\n  - id: diagnostic\n    if: failure\n    run: exit 0\n  - id: final\n    if: always\n    run: exit 0\n");
    expect(result?.status).toBe("failed");
    expect(records.map((record) => [record.id, record.status, record.exitCode])).toEqual([["fail", "failed", 7], ["skipped", "skipped", undefined], ["diagnostic", "succeeded", 0], ["final", "succeeded", 0]]);
  });
  it("records tolerated failures without stopping subsequent steps", async () => {
    const { result, records } = await execute("steps:\n  - run: exit 2\n    continue-on-error: true\n  - run: exit 0\n");
    expect(result?.status).toBe("completed"); expect(records[0]).toMatchObject({ status: "failed", tolerated: true }); expect(records[1]?.status).toBe("succeeded");
  });
  it("retries only explicitly requested steps", async () => {
    const { result, records } = await execute("steps:\n  - retry: {maxAttempts: 2, delay: 1ms}\n    run: if test -f marker; then exit 0; else touch marker; exit 1; fi\n");
    expect(result?.status).toBe("completed"); expect(records.map((record) => [record.attempt, record.status])).toEqual([[1, "failed"], [2, "succeeded"]]);
  });
  it("stops after exhausting retries", async () => {
    const { result, records } = await execute("steps:\n  - retry: {maxAttempts: 2, delay: 1ms}\n    run: exit 1\n");
    expect(result?.status).toBe("failed"); expect(records.map((record) => record.attempt)).toEqual([1, 2]);
  });
  it("applies workflow and step environments without leaking exports", async () => {
    const { result } = await execute("env: {VALUE: global}\nsteps:\n  - env: {VALUE: local}\n    run: test \"$VALUE\" = local; export LEAK=bad\n  - run: test \"$VALUE\" = global; test -z \"${LEAK:-}\"\n");
    expect(result?.status).toBe("completed");
  });
  it("supports explicitly configured provider environment without overriding workflow values", async () => {
    const { result } = await execute("env: {VALUE: workflow}\nsteps:\n  - run: test \"$VALUE\" = workflow; test \"$PROVIDER\" = configured\n", false, { VALUE: "provider", PROVIDER: "configured" });
    expect(result?.status).toBe("completed");
  });
  it.each(["bash", "sh"])("uses %s with documented pipeline behavior", async (shell) => {
    const { result } = await execute(`steps:\n  - shell: ${shell}\n    run: false | true\n`);
    expect(result?.status).toBe(shell === "bash" ? "failed" : "completed");
  });
  it("supports defaults and workspace-relative directories", async () => {
    const { result } = await execute("defaults: {run: {shell: sh, working-directory: .}}\nsteps:\n  - run: mkdir child; printf hello > child/result\n  - working-directory: child\n    run: test \"$(cat result)\" = hello\n"); expect(result?.status).toBe("completed");
  });
  it("rejects runtime symlink escapes", async () => {
    const { result, records } = await execute("steps:\n  - run: ln -s \"$HOME\" outside\n  - working-directory: outside\n    run: exit 0\n");
    expect(result?.status).toBe("failed"); expect(records[1]?.error).toContain("escapes");
  });
  it("fails when a working directory is absent", async () => {
    const { result } = await execute("steps:\n  - working-directory: missing\n    run: exit 0\n"); expect(result?.status).toBe("failed");
  });
  it.each(["timeout", "no-output-timeout"])("enforces %s", async (field) => {
    const { result, records } = await execute(`steps:\n  - ${field}: 30ms\n    run: sleep 5\n  - run: exit 0\n`);
    expect(result?.status).toBe("failed"); expect(records[0]?.status).toBe("failed"); expect(records[1]?.status).toBe("skipped");
  });
  it("does not launch or parse an agent result for scripted execution", async () => {
    const { result } = await execute("steps:\n  - run: echo 'MIXER_AUTOMATIONS_RESULT {invalid}'\n");
    expect(result?.outcome).toEqual({ version: 1, outcome: "unknown", reason: "scripted_steps_completed" });
  });
  it("records a no-op when every step is skipped by its condition", async () => {
    const { result, records } = await execute("steps:\n  - if: failure\n    run: exit 8\n");
    expect(result?.outcome).toEqual({ version: 1, outcome: "no-op", reason: "no_steps_selected" });
    expect(records[0]).toMatchObject({ attempt: 0, status: "skipped" }); expect(records[0]?.finishedAt).toBeDefined();
  });
  it("cancels an active step and skips the remaining work", async () => {
    const { result, records } = await execute("steps:\n  - id: active\n    run: sleep 10\n  - id: never\n    if: always\n    run: exit 0\n", true);
    expect(result?.status).toBe("cancelled"); expect(records.map((record) => [record.id, record.status])).toEqual([["active", "cancelled"], ["never", "skipped"]]);
  });
  it("replays the immutable YAML snapshot or explicitly selected current configuration", async () => {
    const home = temp();
    const runtime = new Runtime({ home, builtins: [{ extension: steps }, { extension: scratch }, { extension: host }] });
    runtime.registry.setOwner("test"); runtime.registry.events.registerSource("manual", { start() {} });
    const file = path.join(home, "automations", "task.yaml");
    fs.writeFileSync(file, "on: {manual: {}}\nsteps: [{run: exit 0}]\n");
    await runtime.initialize();
    try {
      const original = runtime.runManual("task"); await runtime.idle();
      fs.writeFileSync(file, "on: {manual: {}}\nsteps: [{run: exit 3}]\n"); runtime.reloadWorkflows();
      const snapshot = runtime.replayRun(original.id); await runtime.idle(); expect(runtime.database.getRun(snapshot.id)?.status).toBe("completed");
      const current = runtime.replayRun(original.id, { workflow: "current" }); await runtime.idle(); expect(runtime.database.getRun(current.id)?.status).toBe("failed");
    } finally { await runtime.stop(); }
  });
});

describe("durable scripted handoffs", () => {
  async function exercise(action: (runtime: Runtime, context: WorkflowRunnerContext, token: string) => Promise<void>, eventDriven = false) {
    const home = temp(); let runtime: Runtime; const received: Event[] = [];
    const extension: Extension = { name: "probe", setup(api) {
      api.events.registerSource("manual", { start() {} });
      api.events.registerSource("test.item", { start() {}, match(_event, subscription) {
        if (subscription === undefined) throw new Error("Manual-only children must not rematch an undeclared trigger");
        return true;
      }, activate() { return { data: { original: true, live: true } }; } });
      api.agents.register("fake", { run(context) { received.push(context.event); return { version: 1, outcome: "no-op" }; } });
      api.commands.register({ name: "wait-for-scope", description: "Observe scope cancellation", run() {}, query(_args, context) {
        return new Promise<"scope-ended">((resolve) => context.signal.addEventListener("abort", () => resolve("scope-ended"), { once: true }));
      } });
      api.workflows.registerRunner("steps", { schema: stepsSchema, async run(context) {
        context.recordStep({ id: "submit", name: "submit", ordinal: 0, attempt: 1, status: "running" });
        const token = context.stepEnvironment("submit").MIXER_AUTOMATIONS_SUBMISSION_TOKEN;
        if (!token) throw new Error("Missing submission token");
        await action(runtime, context, token);
        const attempt = runtime.database.listSteps(context.run.id).filter((record) => record.id === "submit").at(-1)?.attempt ?? 1;
        context.recordStep({ id: "submit", name: "submit", ordinal: 0, attempt, status: "succeeded" });
        return { version: 1, outcome: "no-op" };
      } });
    } };
    runtime = new Runtime({ home, builtins: [{ extension }, { extension: scratch }, { extension: host }] });
    fs.writeFileSync(path.join(home, "automations", "parent.yaml"), `on: {${eventDriven ? "test.item" : "manual"}: {}}\nsteps: [{run: echo parent}]\n`);
    fs.writeFileSync(path.join(home, "automations", "child.md"), `---\nagent: fake\non: ${eventDriven ? "{}" : "{manual: {}}"}\n---\nInspect input.\n`);
    await runtime.initialize();
    let parentId: string;
    if (eventDriven) {
      const routing = await runtime.receive({ id: "upstream", type: "test.item", source: "probe", timestamp: new Date().toISOString(), data: { original: true } });
      expect(routing.runIds).toHaveLength(1);
      const id = routing.runIds?.[0]; if (!id) throw new Error("Parent was not routed");
      parentId = id;
    } else parentId = runtime.runManual("parent", { original: true }).id;
    await runtime.idle();
    const parentResult = runtime.database.getRun(parentId);
    const children = runtime.database.childRuns(parentId);
    const childResults = children.map((id) => runtime.database.getRun(id));
    await runtime.stop();
    expect(parentResult?.status, JSON.stringify(parentResult?.outcome)).toBe("completed");
    return { parentResult, received, children, childResults };
  }
  it("enqueues once, returns the same child on retry, and rejects changed input", async () => {
    const { parentResult, children, childResults, received } = await exercise(async (runtime, context, token) => {
      const first = await runtime.submitRun("child", { token, handoffKey: "investigate", input: { note: "hello" } });
      const second = await runtime.submitRun("child.md", { token, handoffKey: "investigate", input: { note: "hello" } });
      expect(second.id).toBe(first.id);
      await expect(runtime.submitRun("child", { token, handoffKey: "investigate", input: { note: "different" } })).rejects.toThrow("handoff_key_conflict");
      expect(runtime.database.parentRun(first.id)).toBe(context.run.id);
    });
    expect(parentResult?.status).toBe("completed"); expect(children).toHaveLength(1); expect(childResults[0]?.status).toBe("completed"); expect(received[0]?.data).toEqual({ note: "hello" });
  });
  it("preserves event data and passes separate handoff input", async () => {
    const { received } = await exercise(async (runtime, _context, token) => {
      await runtime.submitRun("child", { token, inheritEvent: true, input: { report: "context" } });
    });
    expect(received[0]?.data).toEqual({ original: true }); expect(received[0]?.input).toEqual({ report: "context" });
  });
  it("rejects recursive, forged, and incompatible submissions", async () => {
    const { children } = await exercise(async (runtime, _context, token) => {
      await expect(runtime.submitRun("parent", { token })).rejects.toThrow("recursive");
      await expect(runtime.submitRun("child", { token: "forged" })).rejects.toThrow("context_invalid");
      await expect(runtime.submitRun("child", { token, repository: "owner/other", inheritEvent: true })).rejects.toThrow("repository");
      await expect(runtime.submitRun("child", { inheritEvent: true })).rejects.toThrow("active scripted parent");
    }); expect(children).toEqual([]);
  });
  it("rejects expired tokens from previous attempts", async () => {
    const { children } = await exercise(async (runtime, context, token) => {
      context.recordStep({ id: "submit", name: "submit", ordinal: 0, attempt: 1, status: "failed" });
      context.recordStep({ id: "submit", name: "submit", ordinal: 0, attempt: 2, status: "running" });
      await expect(runtime.submitRun("child", { token })).rejects.toThrow("context_invalid");
    }); expect(children).toEqual([]);
  });
  it("does not transfer authority for an undeclared inherited event", async () => {
    const { children } = await exercise(async (runtime, _context, token) => {
      fs.writeFileSync(path.join(runtime.paths.workflows, "child.md"), "---\nagent: fake\non: {other: {}}\n---\nInvestigate.\n");
      runtime.registry.events.registerSource("other", { start() {} });
      await expect(runtime.submitRun("child", { token, inheritEvent: true })).rejects.toThrow("event_not_supported");
    }); expect(children).toEqual([]);
  });
  it("aborts scoped queries and expires their credentials when the step ends", async () => {
    await exercise(async (runtime, context, token) => {
      const query = runtime.queryCommand("wait-for-scope", [], token);
      context.recordStep({ id: "submit", name: "submit", ordinal: 0, attempt: 1, status: "succeeded" });
      expect(await query).toBe("scope-ended");
      await expect(runtime.queryCommand("wait-for-scope", [], token)).rejects.toThrow("query_context_invalid");
    });
  });
  it("starts a manual-only child exactly once and still refreshes inherited event activation", async () => {
    const { children, childResults, received } = await exercise(async (runtime, _context, token) => {
      await runtime.submitRun("child", { token, inheritEvent: true, input: { report: "prepared" } });
    }, true);
    expect(children).toHaveLength(1); expect(childResults[0]?.status).toBe("completed");
    expect(received).toHaveLength(1); expect(received[0]?.type).toBe("test.item");
    expect(received[0]?.data).toEqual({ original: true, live: true }); expect(received[0]?.input).toEqual({ report: "prepared" });
  });
});
