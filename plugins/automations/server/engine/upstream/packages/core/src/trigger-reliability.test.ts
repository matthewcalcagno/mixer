import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Extension, Event, Run, Workflow } from "@mixer/automations-sdk";
import { StateDatabase } from "./database.js";
import { Runtime } from "./runtime.js";

const roots: string[] = [];
const runtimes: Runtime[] = [];
const databases: StateDatabase[] = [];
function root() { const value = fs.mkdtempSync(path.join(os.tmpdir(), "rp-routing-")); roots.push(value); return value; }
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.stop();
  for (const database of databases.splice(0)) database.close();
  for (const directory of roots.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});
const event = (id: string): Event => ({ id, source: "provider", type: "provider.item", timestamp: new Date().toISOString(), data: {} });
const workflow: Workflow = { id: "task.md", name: "Task", path: "/task.md", agent: "fake", execution: "host", workspace: "scratch", on: { "provider.item": {} }, safeActions: {}, prompt: "Handle it." };
function database() { const value = new StateDatabase(root()); databases.push(value); return value; }
function admit(db: StateDatabase, id: string) {
  const now = new Date().toISOString();
  const run: Run = { id, workflowId: workflow.id, event: event(id), status: "queued", createdAt: now, updatedAt: now };
  expect(db.admitEventWithRuns(run.event, [{ run, agent: "fake", execution: "host", metadata: { workflow } }], 100)).toMatchObject({ admitted: true });
  return run;
}

async function runtime(options: { matched?: () => void; acquire?: () => void; activate?: () => void; concurrency?: number } = {}) {
  const home = root(); const agent = vi.fn(() => ({ version: 1 as const, outcome: "no-op" as const }));
  fs.mkdirSync(path.join(home, ".roboplane"));
  fs.writeFileSync(path.join(home, ".roboplane", "config.json"), JSON.stringify({ runtime: { concurrency: options.concurrency ?? 1 } }));
  const extension: Extension = { name: "provider", setup(api) {
    api.workflows.registerDiscovery("test", { watchPaths: [], discover: () => ({ workflows: [workflow], errors: [] }) });
    api.events.registerSource("provider.item", { start() {}, match: () => true, activate() { options.activate?.(); return {}; } });
    api.hooks.on("workflow:matched", () => options.matched?.());
    api.hooks.on("run:acquire", () => options.acquire?.());
    api.agents.register("fake", { run: agent });
    api.workspaces.register("scratch", { create: () => ({ path: home }), attest: () => ({ version: 1, kind: "directory", path: home, revision: "scratch", clean: true, verifiedAt: new Date().toISOString() }) });
    api.executions.register("host", { isolation: "none", open: () => ({ process: api.process, close() {} }) });
  } };
  const instance = new Runtime({ home, builtins: [{ extension }] }); runtimes.push(instance); await instance.initialize();
  return { instance, agent, extension };
}

describe("durable trigger reliability", () => {
  it("terminalizes a cancelled worker during restart recovery instead of stranding it", () => {
    const db = database(); admit(db, "cancelled"); const now = Date.now();
    const lease = db.claimEligibleRun("worker", 10, now); if (!lease) throw new Error("No lease");
    db.updateRunFenced(lease, "running"); db.requestRunCancellation("cancelled", "Stop");
    db.db.prepare("UPDATE runs SET lease_expires_at = ? WHERE id = ?").run(now - 1, "cancelled");
    db.recoverInterruptedRuns(3);
    expect(db.getRun("cancelled")).toMatchObject({ status: "cancelled", outcome: { outcome: "blocked", reason: "Stop" } });
    expect(db.hasPendingRuns()).toBe(false); expect(db.hasPendingLifecycle()).toBe(true);
  });

  it("enqueues finalized lifecycle delivery for an agent interrupted during startup", () => {
    const db = database(); admit(db, "interrupted"); const lease = db.claimEligibleRun("worker"); if (!lease) throw new Error("No lease");
    db.updateRunFenced(lease, "running"); db.releaseRunFenced(lease); db.recoverInterruptedRuns(1);
    expect(db.getRun("interrupted")?.status).toBe("interrupted");
    expect(db.getLifecycle("run-finalized:interrupted")).toMatchObject({ runId: "interrupted", event: "run:finalized", payload: { status: "interrupted" } });
  });

  it("reserves the concurrency slot atomically when granting a queued lease", () => {
    const db = database(); admit(db, "one"); admit(db, "two"); const now = Date.now();
    expect(db.claimEligibleRun("worker-one", 60_000, now, 1)?.runId).toBe("one");
    expect(db.claimEligibleRun("worker-two", 60_000, now, 1)).toBeUndefined();
  });

  it("requires the event source to exist before executing a stored snapshot", async () => {
    const { instance, agent } = await runtime();
    await instance.receive(event("missing-source")); instance.registry.eventSources.delete("provider.item");
    await instance.idle();
    expect(agent).not.toHaveBeenCalled();
    expect(instance.database.listRuns()[0]?.outcome).toMatchObject({ reason: "event_source_unavailable:provider.item" });
  });

  it("does not admit a workflow removed during an awaited matching hook", async () => {
    let instance: Runtime;
    const fixture = await runtime({ matched: () => { instance.workflows = []; } }); instance = fixture.instance;
    const result = await instance.receive(event("removed-workflow"));
    expect(result).toMatchObject({ status: "accepted", runIds: [] });
    expect(instance.database.listRuns()).toEqual([]);
  });

  it("acquires resource ownership before refreshing live eligibility", async () => {
    const order: string[] = [];
    const { instance } = await runtime({ acquire: () => { order.push("acquire"); }, activate: () => { order.push("activate"); } });
    await instance.receive(event("order")); await instance.idle();
    expect(order).toEqual(["acquire", "activate"]);
  });

  it("keeps same-resource work queued while unrelated work proceeds, then checks fresh eligibility", async () => {
    const { instance } = await runtime({ concurrency: 2 });
    const source = instance.registry.eventSources.get("provider.item"); if (!source) throw new Error("No source");
    source.resourceKey = value => value.id === "other" ? "case:other" : "case:42";
    let eligible = true;
    source.activate = () => ({ data: { eligible } });
    source.match = value => !(typeof value.data === "object" && value.data && "eligible" in value.data && value.data.eligible === false);
    let release: () => void = () => {};
    const first = new Promise<void>(resolve => { release = resolve; });
    const started: string[] = [];
    instance.registry.agentProviders.set("fake", { async run(context) {
      started.push(context.event.id);
      if (context.event.id === "first") await first;
      return { version: 1, outcome: "no-op" };
    } });
    await instance.receive(event("first"));
    await vi.waitFor(() => expect(started).toEqual(["first"]));
    const second = await instance.receive(event("second")); await instance.receive(event("other"));
    await vi.waitFor(() => expect(started).toEqual(["first", "other"]));
    expect(instance.database.explainEvent("second").runs[0]).toMatchObject({ status: "queued", resourceKey: "case:42", waitingFor: expect.any(String) });
    eligible = false; release(); await instance.idle();
    expect(started).toEqual(["first", "other"]);
    expect(instance.database.getRun(second.runIds?.[0] ?? "")?.outcome).toMatchObject({ reason: "event_no_longer_matches" });
  });

  it("returns temporarily lost eligibility to the queue without spending an agent attempt", async () => {
    const { instance, agent } = await runtime();
    const source = instance.registry.eventSources.get("provider.item"); if (!source) throw new Error("No source");
    let ready = true;
    source.match = () => ready ? true : { kind: "defer", resourceKey: "case:42", reason: "not_ready", retryAfter: 1000, expiresAfter: 60_000 };
    source.activate = () => { ready = false; return {}; };
    const accepted = await instance.receive(event("wait"));
    await vi.waitFor(() => expect(instance.database.getRun(accepted.runIds?.[0] ?? "")).toMatchObject({ status: "queued", phase: "waiting", attempts: 0 }));
    expect(agent).not.toHaveBeenCalled();
    expect(instance.database.explainEvent("wait").decisions).toEqual([{ eventId: "wait", workflowId: "task.md", decision: "deferred", reason: "not_ready" }]);
    ready = true; source.activate = () => ({});
    instance.database.db.prepare("UPDATE runs SET available_at = 0 WHERE event_id = ?").run("wait");
    await instance.idle(); expect(agent).toHaveBeenCalledTimes(1);
    expect(instance.database.getRun(accepted.runIds?.[0] ?? "")?.attempts).toBe(1);
  });

  it("completes obsolete activated work as a no-op without creating a workspace or starting an agent", async () => {
    const { instance, agent } = await runtime();
    const source = instance.registry.eventSources.get("provider.item"); if (!source) throw new Error("No source");
    const workspace = instance.registry.workspaceProviders.get("scratch"); if (!workspace) throw new Error("No workspace");
    const create = vi.spyOn(workspace, "create");
    source.activate = () => ({ decision: { kind: "skip", reason: "scheduled_pr_already_merged" } });
    const result = await instance.receive(event("merged"));
    await instance.idle();
    expect(instance.database.getRun(result.runIds?.[0] ?? "")).toMatchObject({ status: "completed",
      outcome: { version: 1, outcome: "no-op", reason: "scheduled_pr_already_merged" } });
    expect(create).not.toHaveBeenCalled();
    expect(agent).not.toHaveBeenCalled();
    expect(instance.database.listActions(result.runIds?.[0] ?? "")).toEqual([]);
  });

  it("records why an event was ignored and never creates a run for it", async () => {
    const { instance } = await runtime();
    const source = instance.registry.eventSources.get("provider.item"); if (!source) throw new Error("No source");
    source.match = () => ({ kind: "ignore", reason: "obsolete_revision" });
    expect(await instance.receive(event("ignored"))).toMatchObject({ runIds: [] });
    expect(instance.database.explainEvent("ignored")).toMatchObject({ decisions: [{ decision: "ignored", reason: "obsolete_revision" }], runs: [] });
  });

  it("resumes an actual shutdown during preparation without spending the only agent attempt", async () => {
    const { instance, agent, extension } = await runtime();
    instance.config.runtime.shutdownTimeout = 10;
    let block = true;
    instance.registry.hooks.on("run:acquire", async hook => {
      if (!block) return; block = false;
      const signal = hook.signal; if (!signal) throw new Error("No cancellation signal");
      await new Promise<void>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    });
    const accepted = await instance.receive(event("shutdown"));
    await vi.waitFor(() => expect(instance.database.getRun(accepted.runIds?.[0] ?? "")?.status).toBe("preparing"));
    await instance.stop();
    expect(agent).not.toHaveBeenCalled();
    const restarted = new Runtime({ home: instance.paths.home, builtins: [{ extension }] }); runtimes.push(restarted);
    await restarted.initialize(); await restarted.idle();
    expect(agent).toHaveBeenCalledTimes(1);
    expect(restarted.database.getRun(accepted.runIds?.[0] ?? "")).toMatchObject({ status: "completed", attempts: 1 });
  });

  it("does not overwrite degraded health reported by a source during startup", async () => {
    const { instance } = await runtime();
    const source = instance.registry.eventSources.get("provider.item"); if (!source) throw new Error("No source");
    source.start = context => context.reportHealth?.({ version: 1, status: "degraded", reason: "upstream_unavailable", observedAt: new Date().toISOString() });
    await instance.start();
    expect(instance.database.getSourceHealth("provider.item")).toMatchObject({ status: "degraded", error: "upstream_unavailable" });
  });

  it("records successful polling with a persistent warning without counting another failure", async () => {
    const { instance } = await runtime();
    const source = instance.registry.eventSources.get("provider.item"); if (!source) throw new Error("No source");
    source.start = context => {
      context.reportHealth?.({ version: 1, status: "degraded", result: "failure", reason: "poll_failed", observedAt: "2026-01-01T00:00:00Z" });
      context.reportHealth?.({ version: 1, status: "degraded", result: "success", reason: "history_gap", observedAt: "2026-01-01T00:05:00Z" });
      context.reportHealth?.({ version: 1, status: "degraded", result: "success", reason: "history_gap", observedAt: "2026-01-01T00:10:00Z" });
    };
    await instance.start();
    expect(instance.database.getSourceHealth("provider.item")).toEqual({ source: "provider.item", status: "degraded", consecutiveFailures: 0,
      lastSuccessAt: "2026-01-01T00:10:00Z", lastFailureAt: "2026-01-01T00:00:00Z", nextAttemptAt: undefined,
      error: "history_gap", updatedAt: "2026-01-01T00:10:00Z" });
  });

  it("does not log a deferred route that was invalidated before admission", async () => {
    const { instance } = await runtime();
    const source = instance.registry.eventSources.get("provider.item"); if (!source) throw new Error("No source");
    source.match = () => {
      instance.workflows = [];
      return { kind: "defer", resourceKey: "case:42", reason: "not_ready", retryAfter: 1000, expiresAfter: 60_000 };
    };
    const logged = vi.spyOn(instance.logger, "info");
    await instance.receive(event("invalidated-route"));
    expect(instance.database.explainEvent("invalidated-route").decisions).toEqual([
      { eventId: "invalidated-route", workflowId: "task.md", decision: "ignored", reason: "configuration_changed" },
    ]);
    expect(logged).toHaveBeenCalledWith(expect.objectContaining({ deferred: 0 }), "Event routed");
    expect(logged.mock.calls.some(([, message]) => message === "Workflow route deferred")).toBe(false);
  });
});
