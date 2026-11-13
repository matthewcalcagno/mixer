import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import type { Extension, WorkflowRunnerContext } from "@mixer/automations-sdk";
import scratch from "@roboplane/extension-scratch";
import host from "@roboplane/extension-container";
import { Runtime } from "./runtime.js";
import { stepsSchema } from "../../extension-steps/src/schema.js";

const directories: string[] = [];
afterEach(() => { for (const dir of directories.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

async function exercise(action: (runtime: Runtime, context: WorkflowRunnerContext, token: string) => Promise<void>, options: { dryRun?: boolean; declared?: boolean; cleanupFailure?: boolean; toleratedFailure?: boolean } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "roboplane-scripted-actions-")); directories.push(home);
  const effect = path.join(home, "effect.json");
  let runtime: Runtime;
  const extension: Extension = { name: "probe", setup(api) {
    api.events.registerSource("manual", { start() {} });
    api.actions.register("test.effect", {
      schema: z.object({ decision: z.literal("write") }).strict(),
      prepare() {
        if (fs.existsSync(effect)) throw new Error("Effect ran before preparation");
        return { message: "prepared" };
      },
      executePrepared(_context, value) { fs.writeFileSync(effect, JSON.stringify(value)); return { message: "executed" }; },
    });
    api.workflows.registerRunner("steps", { schema: stepsSchema, async run(context) {
      context.recordStep({ id: "request", name: "request", ordinal: 0, attempt: 1, status: "running" });
      const token = context.stepEnvironment("request").MIXER_AUTOMATIONS_SUBMISSION_TOKEN;
      if (!token) throw new Error("Missing step token");
      await action(runtime, context, token);
      expect(fs.existsSync(effect)).toBe(false);
      const attempt = runtime.database.listSteps(context.run.id).filter(step => step.id === "request").at(-1)?.attempt ?? 1;
      context.recordStep({ id: "request", name: "request", ordinal: 0, attempt, status: options.toleratedFailure ? "failed" : "succeeded", ...(options.toleratedFailure ? { tolerated: true } : {}) });
      return { version: 1, outcome: "unknown", reason: "scripted_steps_completed" };
    } });
  } };
  const execution: Extension = options.cleanupFailure ? { name: "cleanup-host", setup(api) {
    api.executions.register("host", { isolation: "none", open() {
      return { process: api.process, close() { throw new Error("cleanup failed"); } };
    } });
  } } : host;
  runtime = new Runtime({ home, dryRun: options.dryRun, builtins: [{ extension: scratch }, { extension: execution }, { extension }] });
  fs.writeFileSync(path.join(home, "automations", "task.yaml"), "on: {manual: {}}\n" + (options.declared === false ? "" : "safeActions: {test.effect: {max: 1}}\n") + "steps: [{run: echo request}]\n");
  await runtime.initialize();
  try {
    expect(runtime.workflowErrors).toEqual([]);
    const run = runtime.runManual("task"); await runtime.idle();
    return { run: runtime.database.getRun(run.id), actions: runtime.database.listActions(run.id), plan: runtime.database.getPlan(run.id), effect: fs.existsSync(effect) ? JSON.parse(fs.readFileSync(effect, "utf8")) : undefined };
  } finally { await runtime.stop(); }
}

const input = { decision: "write" };
describe("scripted Safe Action requests", () => {
  it("records a deduplicated proposal and applies it only after successful execution", async () => {
    const result = await exercise(async (runtime, _context, token) => {
      const first = await runtime.requestAction("test.effect", input, { token, requestKey: "write" });
      const repeated = await runtime.requestAction("test.effect", input, { token, requestKey: "write" });
      expect(first.status).toBe("proposed"); expect(repeated.id).toBe(first.id);
    });
    expect(result.run).toMatchObject({ status: "completed", outcome: { outcome: "acted" } });
    expect(result.effect).toEqual({ message: "prepared" });
    expect(result.actions).toHaveLength(1); expect(result.actions[0]).toMatchObject({ status: "executed", result: { message: "executed" } });
  });
  it.each(["failed", "cancelled", "cleanup"])("does not apply a proposal after %s execution", async kind => {
    const result = await exercise(async (runtime, context, token) => {
      await runtime.requestAction("test.effect", input, { token, requestKey: "write" });
      if (kind === "failed") throw new Error("step failed");
      if (kind === "cancelled") runtime.cancelRun(context.run.id);
    }, { cleanupFailure: kind === "cleanup" });
    expect(result.run?.status).toBe(kind === "cancelled" ? "cancelled" : "failed");
    expect(result.effect).toBeUndefined(); expect(result.plan).toBeUndefined();
    expect(result.actions[0]?.status).toBe("rejected");
  });
  it("stages a proposal in dry-run without performing the effect", async () => {
    const result = await exercise(async (runtime, _context, token) => {
      await runtime.requestAction("test.effect", input, { token, requestKey: "write" });
    }, { dryRun: true });
    expect(result.run?.status).toBe("completed"); expect(result.actions[0]?.status).toBe("staged");
    expect(result.plan?.status).toBe("staged"); expect(result.effect).toBeUndefined();
  });
  it("does not apply a request made by a tolerated failed step", async () => {
    const result = await exercise(async (runtime, _context, token) => {
      await runtime.requestAction("test.effect", input, { token, requestKey: "write" });
    }, { toleratedFailure: true });
    expect(result.effect).toBeUndefined(); expect(result.plan).toBeUndefined();
    expect(result.actions[0]).toMatchObject({ status: "rejected", reason: "safe_action_request_step_not_successful" });
    expect(result.run?.outcome).toMatchObject({ outcome: "blocked" });
  });
  it("audits undeclared and invalid action requests", async () => {
    const result = await exercise(async (runtime, _context, token) => {
      expect(await runtime.requestAction("test.effect", input, { token, requestKey: "undeclared" })).toMatchObject({ status: "rejected", reason: "safe_action_not_allowed" });
    }, { declared: false });
    expect(result.actions[0]?.status).toBe("rejected"); expect(result.effect).toBeUndefined();
    const invalid = await exercise(async (runtime, _context, token) => {
      expect(await runtime.requestAction("test.effect", { decision: "wrong" }, { token, requestKey: "invalid" })).toMatchObject({ status: "rejected", reason: "safe_action_schema_invalid" });
    });
    expect(invalid.effect).toBeUndefined();
  });
  it("rejects forged tokens and tokens from finished step attempts", async () => {
    const result = await exercise(async (runtime, context, token) => {
      await expect(runtime.requestAction("test.effect", input, { token: "forged", requestKey: "write" })).rejects.toThrow("action_context_invalid");
      context.recordStep({ id: "request", name: "request", ordinal: 0, attempt: 1, status: "failed" });
      context.recordStep({ id: "request", name: "request", ordinal: 0, attempt: 2, status: "running" });
      await expect(runtime.requestAction("test.effect", input, { token, requestKey: "write" })).rejects.toThrow("action_context_invalid");
    });
    expect(result.actions).toEqual([]); expect(result.effect).toBeUndefined();
  });
  it("deduplicates across step retries and audits changed payload or second-effect requests", async () => {
    const result = await exercise(async (runtime, context, token) => {
      const first = await runtime.requestAction("test.effect", input, { token, requestKey: "write" });
      context.recordStep({ id: "request", name: "request", ordinal: 0, attempt: 1, status: "failed" });
      context.recordStep({ id: "request", name: "request", ordinal: 0, attempt: 2, status: "running" });
      const retryToken = context.stepEnvironment("request").MIXER_AUTOMATIONS_SUBMISSION_TOKEN;
      if (!retryToken) throw new Error("Missing retry token");
      expect((await runtime.requestAction("test.effect", input, { token: retryToken, requestKey: "write" })).id).toBe(first.id);
      expect(await runtime.requestAction("test.effect", { decision: "wrong" }, { token: retryToken, requestKey: "write" })).toMatchObject({ status: "rejected", reason: "safe_action_request_key_conflict" });
      expect(await runtime.requestAction("test.effect", input, { token: retryToken, requestKey: "second" })).toMatchObject({ status: "rejected" });
    });
    expect(result.actions.filter(action => action.status === "executed")).toHaveLength(1);
  });
});
