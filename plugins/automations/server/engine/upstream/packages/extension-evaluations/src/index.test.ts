import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Runtime, ensureHome, resolvePaths } from "@roboplane/core";
import { z, type AgentContext, type Extension } from "@mixer/automations-sdk";
import scratch from "@roboplane/extension-scratch";
import evaluations from "./index.js";
import { definitionSchema, loadDefinitions } from "./definitions.js";
import { batchSchema, evidenceSchema } from "./model.js";

const homes: string[] = [];
const runtimes: Runtime[] = [];
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.stop();
  vi.useRealTimers();
  for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true });
});

const comment = "The defect is confirmed. Next: implement a focused correction.";
const runDataSchema = z.object({ runs: z.array(z.object({ runId: z.string(), output: z.string() })) });
function judgeOutput(context: AgentContext, result = "pass", suggestion: string | null = null): string {
  const prompt = context.instructions.join("\n");
  const text = prompt.split("BEGIN_UNTRUSTED_EVALUATION_DATA\n\n")[1]?.split("\n\nEND_UNTRUSTED_EVALUATION_DATA")[0];
  if (!text) throw new Error("Missing captured evidence");
  const data = runDataSchema.parse(JSON.parse(text));
  const source = data.runs[0];
  if (!source) throw new Error("Missing source run");
  return `MIXER_AUTOMATIONS_EVALUATION: ${JSON.stringify({ criteria: [{ criterion: 1, result,
    explanation: "The captured response names the finding and the next action.", evidence: [{ runId: source.runId, excerpt: comment }] }], suggestion })}\nMIXER_AUTOMATIONS_RESULT: {"version":1,"outcome":"no-op","actions":[]}`;
}

function home(options: { afterRuns?: number; history?: string; retention?: string; pollInterval?: string } = {}): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rp-evaluations-"));
  homes.push(root);
  const paths = resolvePaths(root);
  ensureHome(paths);
  fs.writeFileSync(paths.config, JSON.stringify({ runtime: { concurrency: 1 }, history: { retention: options.history ?? "7d" },
    extensions: { evaluations: { pollInterval: options.pollInterval ?? "1h" } } }));
  fs.writeFileSync(path.join(paths.workflows, "triage.md"), "---\nagent: source\non: {}\n---\nInvestigate and explain the next action.\n");
  const folder = path.join(root, "evaluations", "comments");
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, "evaluation.yaml"), `workflow: triage.md\nagent: judge\nmodel: selected-model\nthinking: high\nafterRuns: ${options.afterRuns ?? 2}\n${options.retention ? `evidence:\n  retention: ${options.retention}\n` : ""}criteria:\n  - description: Explain the next action\n    passWhen: The comment names the finding and the next action.\n`);
  return root;
}

async function runtime(root: string, options: { judge?: (context: AgentContext) => string | Promise<string>; source?: () => void } = {}): Promise<Runtime> {
  const fake: Extension = {
    name: "evaluation-test",
    setup(api) {
      api.agents.register("source", { run() { options.source?.(); return { version: 1, outcome: "no-op", output: comment }; } });
      api.agents.register("judge", { async run(context) {
        const output = await (options.judge?.(context) ?? judgeOutput(context));
        return { version: 1, outcome: "no-op", output };
      } });
      api.executions.register("host", { isolation: "none", open: () => ({ process: api.process, close() {} }) });
    },
  };
  const instance = new Runtime({ home: root, builtins: [{ extension: scratch }, { extension: fake }, { extension: evaluations }] });
  runtimes.push(instance);
  await instance.initialize();
  expect(instance.workflowErrors).toEqual([]);
  return instance;
}

function reports(root: string): string[] {
  const directory = path.join(root, "evaluations", "comments", "reports");
  return fs.existsSync(directory) ? fs.readdirSync(directory).filter((file) => file.endsWith(".md")) : [];
}
function readReport(root: string): string {
  const file = reports(root)[0];
  if (!file) throw new Error("No evaluation report was produced");
  return fs.readFileSync(path.join(root, "evaluations", "comments", "reports", file), "utf8");
}

describe("evaluation definitions", () => {
  it("creates an empty evaluations directory when loaded into an existing home", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rp-eval-layout-")); homes.push(root);
    const instance = await runtime(root);
    const directory = path.join(root, "evaluations");
    expect(fs.existsSync(directory)).toBe(true);
    expect(fs.readdirSync(directory)).toEqual([]);
    await instance.stop();
    await runtime(root);
    expect(fs.readdirSync(directory)).toEqual([]);
  });

  it("accepts description and passWhen without ids, assessment, or required flags", () => {
    expect(definitionSchema.parse({ workflow: "issues/triage.md", criteria: [{ description: "Clear", passWhen: "Names the next action" }] })).toMatchObject({
      workflow: "issues/triage.md", agent: "codex", afterRuns: 10, timeout: "10m", criteria: [{ description: "Clear", passWhen: "Names the next action" }],
    });
  });
  it.each([
    { workflow: "../triage.md" }, { workflow: "/triage.md" }, { workflow: "triage" }, { afterRuns: 0 },
    { criteria: [] }, { safeActions: { "github.pr.merge": { max: 1 } } },
    { criteria: [{ description: "Clear", passWhen: "Good", required: true }] },
    { agent: "opencode", thinking: "high" },
  ])("rejects unsupported or unsafe definitions %j", (override) => {
    expect(definitionSchema.safeParse({ workflow: "triage.md", criteria: [{ description: "Clear", passWhen: "Good" }], ...override }).success).toBe(false);
  });
  it("ignores reports and unrelated YAML instead of discovering them as definitions", () => {
    const root = home();
    const directory = path.join(root, "evaluations", "comments", "reports");
    fs.mkdirSync(directory);
    fs.writeFileSync(path.join(directory, "evaluation.yaml"), "not a definition");
    fs.writeFileSync(path.join(root, "evaluations", "comments", "notes.yaml"), "not a definition");
    const result = loadDefinitions(path.join(root, "evaluations"));
    expect(result.errors).toEqual([]);
    expect(result.evaluations.map((item) => item.slug)).toEqual(["comments"]);
  });
  it("rejects duplicate manifests and duplicate YAML keys", () => {
    const root = home();
    const directory = path.join(root, "evaluations", "comments");
    fs.writeFileSync(path.join(directory, "evaluation.yml"), "workflow: triage.md");
    expect(loadDefinitions(path.join(root, "evaluations")).errors[0]?.errors.join(" ")).toContain("exactly one");
    fs.unlinkSync(path.join(directory, "evaluation.yml"));
    fs.appendFileSync(path.join(directory, "evaluation.yaml"), "workflow: other.md\n");
    expect(loadDefinitions(path.join(root, "evaluations")).errors[0]?.errors.join(" ")).toContain("unique");
  });
});

describe("report-only evaluation lifecycle", () => {
  it("waits for the run count, selects the harness and model, and writes a report without editing", async () => {
    const root = home({ pollInterval: "20ms" });
    const definition = path.join(root, "evaluations", "comments", "evaluation.yaml");
    const automation = path.join(root, "automations", "triage.md");
    const before = [fs.readFileSync(definition, "utf8"), fs.readFileSync(automation, "utf8")];
    const judge = vi.fn((context: AgentContext) => {
      expect(context.model).toBe("selected-model"); expect(context.thinking).toBe("high");
      expect(context.repository).toBeUndefined(); expect(context.actions).toEqual([]);
      expect(context.workspace?.path).not.toContain("evaluations/comments");
      return judgeOutput(context);
    });
    const instance = await runtime(root, { judge });
    await instance.start();
    const first = instance.runManual("triage.md");
    await instance.idle();
    expect(judge).not.toHaveBeenCalled(); expect(reports(root)).toEqual([]);
    const second = instance.runManual("triage.md");
    await instance.idle();
    await vi.waitFor(() => expect(reports(root)).toHaveLength(1));
    const report = readReport(root);
    expect(report).toContain("Result: No change justified");
    expect(report).toContain(first.id); expect(report).toContain(second.id); expect(report).toContain(`> ${comment}`);
    expect(report).toContain("No automation files were changed");
    expect(judge).toHaveBeenCalledTimes(1);
    expect([fs.readFileSync(definition, "utf8"), fs.readFileSync(automation, "utf8")]).toEqual(before);
    expect(instance.database.state("evaluations").entries("evidence:").map(({ value }) => evidenceSchema.parse(value).state)).toEqual(["consumed", "consumed"]);
    expect(instance.database.listRuns().filter((run) => run.workflowId.startsWith("evaluations/"))).toHaveLength(1);
  });

  it("deduplicates terminal delivery and recovers pending evidence across restart", async () => {
    const root = home();
    const firstRuntime = await runtime(root);
    const first = firstRuntime.runManual("triage.md"); await firstRuntime.idle();
    const stored = firstRuntime.database.getRun(first.id);
    const workflow = firstRuntime.database.getWorkflowSnapshot(first.id);
    if (!stored || !workflow) throw new Error("Source run missing");
    await firstRuntime.registry.runHooks("run:finalized", { event: stored.event, run: stored, workflow, instructions: [], metadata: { outcome: stored.outcome } });
    expect(firstRuntime.database.state("evaluations").entries("evidence:")).toHaveLength(1);
    await firstRuntime.stop();
    const secondRuntime = await runtime(root);
    const second = secondRuntime.runManual("triage.md"); await secondRuntime.idle();
    await secondRuntime.start(); await secondRuntime.idle();
    expect(reports(root)).toHaveLength(1);
    expect(readReport(root)).toContain(first.id); expect(readReport(root)).toContain(second.id);
    await secondRuntime.registry.runHooks("run:finalized", { event: stored.event, run: stored, workflow, instructions: [], metadata: { outcome: stored.outcome } });
    expect(secondRuntime.database.state("evaluations").entries("evidence:").map(({ value }) => evidenceSchema.parse(value).state)).toEqual(["consumed", "consumed"]);
  });

  it("does not count expired evidence with one-day history retention", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const now = Date.now();
    const root = home({ history: "1d", afterRuns: 1 });
    const judge = vi.fn(judgeOutput);
    const instance = await runtime(root, { judge });
    const source = instance.runManual("triage.md"); await instance.idle();
    vi.setSystemTime(now + 25 * 3_600_000);
    await instance.start(); await instance.idle();
    expect(judge).not.toHaveBeenCalled(); expect(reports(root)).toEqual([]);
    expect(instance.database.state("evaluations").entries("evidence:")).toEqual([]);
    expect(instance.database.getRun(source.id)).toBeUndefined();
    expect(fs.existsSync(path.join(instance.paths.logs, `${source.id}.log`))).toBe(false);
  });

  it("adopts an admitted run when a crash lost the creation-hook state update", async () => {
    const root = home({ afterRuns: 1 });
    const judge = vi.fn(judgeOutput);
    const instance = await runtime(root, { judge });
    instance.runManual("triage.md"); await instance.idle(); await instance.start();
    const state = instance.database.state("evaluations");
    const entry = state.entries("batch:")[0]; if (!entry) throw new Error("Batch missing");
    const record = batchSchema.parse(entry.value);
    if (record.state !== "active") throw new Error("Expected an admitted batch");
    const { runId: _runId, attempt: _attempt, ...pending } = record;
    state.set(entry.key, { ...pending, state: "pending" });
    await instance.idle();
    expect(judge).toHaveBeenCalledTimes(1);
    expect(reports(root)).toHaveLength(1);
    expect(readReport(root)).toContain("Result: No change justified");
  });

  it("uses explicitly retained evidence after source history and logs are deleted", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const now = Date.now();
    const root = home({ history: "1d", retention: "14d", afterRuns: 1 });
    const instance = await runtime(root);
    const source = instance.runManual("triage.md"); await instance.idle();
    vi.setSystemTime(now + 25 * 3_600_000);
    await instance.start(); await instance.idle();
    expect(instance.database.getRun(source.id)).toBeUndefined();
    expect(readReport(root)).toContain(source.id); expect(readReport(root)).toContain(`> ${comment}`);
  });

  it("keeps workflow versions separate instead of combining incompatible evidence", async () => {
    const root = home({ pollInterval: "20ms" });
    const judge = vi.fn(judgeOutput);
    const instance = await runtime(root, { judge });
    const old = instance.runManual("triage.md"); await instance.idle();
    fs.appendFileSync(path.join(root, "automations", "triage.md"), "Use a revised writing policy.\n");
    instance.reloadWorkflows();
    const next = instance.runManual("triage.md"); await instance.idle();
    await instance.start(); await instance.idle();
    expect(judge).not.toHaveBeenCalled();
    const third = instance.runManual("triage.md"); await instance.idle();
    await vi.waitFor(() => expect(reports(root)).toHaveLength(1));
    expect(readReport(root)).not.toContain(old.id);
    expect(readReport(root)).toContain(next.id); expect(readReport(root)).toContain(third.id);
  });

  it("can lower the threshold without throwing away pending source evidence", async () => {
    const root = home({ afterRuns: 3 });
    const instance = await runtime(root);
    const first = instance.runManual("triage.md"); await instance.idle();
    const second = instance.runManual("triage.md"); await instance.idle();
    const file = path.join(root, "evaluations", "comments", "evaluation.yaml");
    fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("afterRuns: 3", "afterRuns: 2"));
    instance.reloadWorkflows(); await instance.start(); await instance.idle();
    expect(readReport(root)).toContain(first.id); expect(readReport(root)).toContain(second.id);
    expect(reports(root)).toHaveLength(1);
  });

  it.each(["malformed", "invented-evidence", "unjustified-suggestion"])("records %s as an evaluation error without modifying the source result", async (kind) => {
    const root = home({ afterRuns: 1 });
    const instance = await runtime(root, { judge(context) {
      if (kind === "malformed") return "Everything looks good.";
      if (kind === "invented-evidence") return judgeOutput(context).replace(comment, "An invented comment");
      return judgeOutput(context, "pass", "Rewrite the whole automation.");
    } });
    const source = instance.runManual("triage.md"); await instance.idle();
    await instance.start(); await instance.idle();
    expect(readReport(root)).toContain("Result: Evaluation error");
    expect(readReport(root)).toContain("No change proposed.");
    expect(instance.database.getRun(source.id)).toMatchObject({ status: "completed", outcome: { outcome: "no-op" } });
  });

  it("leaves supported suggestions in the report without applying them", async () => {
    const root = home({ afterRuns: 1 });
    const automation = path.join(root, "automations", "triage.md");
    const original = fs.readFileSync(automation, "utf8");
    const instance = await runtime(root, { judge: (context) => judgeOutput(context, "fail", "Make the next action more specific when the evidence supports it.") });
    instance.runManual("triage.md"); await instance.idle(); await instance.start(); await instance.idle();
    expect(readReport(root)).toContain("Result: Improvement suggested");
    expect(readReport(root)).toContain("Make the next action more specific");
    expect(fs.readFileSync(automation, "utf8")).toBe(original);
  });

  it("does not invoke a model when the evidence exceeds the prompt budget", async () => {
    const root = home({ afterRuns: 1 });
    const config = JSON.parse(fs.readFileSync(resolvePaths(root).config, "utf8"));
    config.extensions.evaluations.maxPromptBytes = 4096;
    fs.writeFileSync(resolvePaths(root).config, JSON.stringify(config));
    fs.appendFileSync(path.join(root, "automations", "triage.md"), "Long context. ".repeat(1000));
    const judge = vi.fn(judgeOutput);
    const instance = await runtime(root, { judge });
    instance.runManual("triage.md"); await instance.idle(); await instance.start(); await instance.idle();
    expect(judge).not.toHaveBeenCalled();
    expect(readReport(root)).toContain("Result: Insufficient evidence");
    expect(readReport(root)).toContain("prompt budget");
  });

  it("records missing evidence as inconclusive instead of treating it as a pass", async () => {
    const root = home({ afterRuns: 1 });
    const instance = await runtime(root, { judge() {
      return 'MIXER_AUTOMATIONS_EVALUATION: {"criteria":[{"criterion":1,"result":"insufficient-evidence","explanation":"The published comment is absent.","evidence":[]}],"suggestion":null}';
    } });
    instance.runManual("triage.md"); await instance.idle(); await instance.start(); await instance.idle();
    expect(readReport(root)).toContain("Result: Insufficient evidence");
    expect(readReport(root)).toContain("The published comment is absent.");
    expect(readReport(root)).toContain("No change proposed.");
  });

  it("writes a failure report when the selected harness fails", async () => {
    const root = home({ afterRuns: 1 });
    const instance = await runtime(root, { judge() { throw new Error("Harness unavailable"); } });
    const source = instance.runManual("triage.md"); await instance.idle(); await instance.start(); await instance.idle();
    expect(readReport(root)).toContain("Result: Evaluation error");
    expect(readReport(root)).toContain("Harness unavailable");
    expect(instance.database.getRun(source.id)?.status).toBe("completed");
  });

  it("cancels an evaluator without cancelling or changing its source run", async () => {
    const root = home({ afterRuns: 1 });
    const instance = await runtime(root, { async judge(context) {
      await new Promise<void>((resolve) => context.signal.addEventListener("abort", () => resolve(), { once: true }));
      context.signal.throwIfAborted(); return "not reached";
    } });
    const source = instance.runManual("triage.md"); await instance.idle(); await instance.start();
    await vi.waitFor(() => expect(instance.database.listRuns().some((run) => run.workflowId.startsWith("evaluations/") && run.status === "running")).toBe(true));
    const evaluation = instance.database.listRuns().find((run) => run.workflowId.startsWith("evaluations/"));
    if (!evaluation) throw new Error("Evaluation run missing");
    expect(instance.cancelRun(evaluation.id, "Stop evaluation")).toBe(true);
    await instance.idle();
    expect(instance.database.getRun(evaluation.id)?.status).toBe("cancelled");
    expect(instance.database.getRun(source.id)?.status).toBe("completed");
    expect(readReport(root)).toContain("Result: Evaluation error");
  });

  it("expires generated reports and leaves manually modified reports alone", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const now = Date.now();
    const root = home({ afterRuns: 1, history: "1d" });
    const instance = await runtime(root);
    instance.runManual("triage.md"); await instance.idle(); await instance.start(); await instance.idle();
    const file = reports(root)[0]; if (!file) throw new Error("Report missing");
    const report = path.join(root, "evaluations", "comments", "reports", file);
    if (process.platform !== "win32") expect(fs.statSync(report).mode & 0o777).toBe(0o600);
    await instance.stop();
    vi.setSystemTime(now + 25 * 3_600_000);
    const restarted = await runtime(root); await restarted.start(); await restarted.idle();
    expect(reports(root)).toEqual([]);
    expect(restarted.database.state("evaluations").entries("batch:")).toEqual([]);
    restarted.runManual("triage.md"); await restarted.idle();
    await restarted.stop();
    const finalRuntime = await runtime(root); await finalRuntime.start(); await finalRuntime.idle();
    const nextFile = reports(root)[0]; if (!nextFile) throw new Error("Second report missing");
    const nextReport = path.join(root, "evaluations", "comments", "reports", nextFile);
    fs.appendFileSync(nextReport, "\nUser annotation.\n"); await finalRuntime.stop();
    vi.setSystemTime(now + 50 * 3_600_000);
    const cleanup = await runtime(root); await cleanup.start(); await cleanup.idle();
    expect(fs.readFileSync(nextReport, "utf8")).toContain("User annotation.");
  });

  it("redacts recognized credential patterns before saving evaluation evidence", async () => {
    const root = home({ afterRuns: 2 });
    const token = `ghp_${"a".repeat(30)}`;
    fs.appendFileSync(path.join(root, "automations", "triage.md"), `Do not expose ${token}.\n`);
    const instance = await runtime(root); instance.runManual("triage.md"); await instance.idle();
    const records = instance.database.state("evaluations").entries("evidence:");
    expect(JSON.stringify(records)).not.toContain(token);
    expect(JSON.stringify(records)).toContain("[REDACTED]");
  });

  it("rejects a symlinked reports directory without writing outside the evaluation", async () => {
    const root = home({ afterRuns: 1 });
    const outside = path.join(root, "outside"); fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(root, "evaluations", "comments", "reports"));
    const instance = await runtime(root);
    instance.runManual("triage.md"); await instance.idle(); await instance.start();
    await vi.waitFor(() => expect(instance.database.state("evaluations").entries("batch:").some(({ value }) => batchSchema.parse(value).state === "reporting")).toBe(true));
    expect(fs.readdirSync(outside)).toEqual([]);
    fs.unlinkSync(path.join(root, "evaluations", "comments", "reports"));
    await instance.idle();
    expect(reports(root)).toHaveLength(1);
  });
});
