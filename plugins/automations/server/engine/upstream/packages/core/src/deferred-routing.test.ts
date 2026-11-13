import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Event, EventMatch, EventSourceContext, Extension, JsonValue } from "@mixer/automations-sdk";
import { Runtime } from "./runtime.js";

const homes: string[] = [];
const runtimes: Runtime[] = [];
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.stop();
  for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true });
});

function fixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "roboplane-deferred-"));
  homes.push(home);
  fs.mkdirSync(path.join(home, "automations"));
  const handled: Array<{ workflow: string; eventId: string; data: unknown }> = [];
  let ready = false;
  let fail = false;
  let context: EventSourceContext | undefined;
  const waiting: EventMatch = { kind: "defer", resourceKey: "item:42", reason: "not_ready", retryAfter: 30_000, expiresAfter: 86_400_000 };
  const extension: Extension = {
    name: "items",
    setup(api) {
      api.events.registerSource("items.feedback", {
        start(value) { context = value; },
        match(event, _config, operation) {
          if (event.data === "irrelevant") return false;
          if (fail) throw new Error("temporarily unavailable");
          return operation?.workflowId === "immediate.md" || ready ? true : waiting;
        },
        activate: () => ({ data: { ready } }),
      });
      api.agents.register("fake", {
        run(value) {
          handled.push({ workflow: value.run.workflowId, eventId: value.event.id, data: value.event.data });
          return { version: 1, outcome: "acted", verification: ["Feedback handled"] };
        },
      });
      api.workspaces.register("scratch", {
        create: () => ({ path: home }),
        attest: () => ({ version: 1, kind: "directory", path: home, revision: "scratch", clean: true, verifiedAt: new Date().toISOString() }),
        cleanup() {},
      });
      api.executions.register("host", { isolation: "none", open: () => ({ process: api.process, close() {} }) });
    },
  };
  const write = (id = "waiting.md", prompt = "Handle feedback.") => fs.writeFileSync(path.join(home, "automations", id),
    `---\nagent: fake\non:\n  items.feedback: {}\n---\n${prompt}\n`);
  write();
  const open = async () => {
    const runtime = new Runtime({ home, builtins: [{ extension }] });
    runtimes.push(runtime);
    await runtime.initialize();
    return runtime;
  };
  const event = (id = "review-42", data: JsonValue = { reviewId: 42 }): Event => ({
    id, type: "items.feedback", source: "items", timestamp: new Date().toISOString(), data,
  });
  const wake = (runtime: Runtime) => runtime.database.wakeDeferredRoutes("items.feedback", "item:42");
  return { home, open, event, write, handled, wake, ready: (value = true) => { ready = value; },
    fail: (value: boolean) => { fail = value; }, notify: () => context?.reconcile?.("item:42") };
}

describe("durable deferred workflow routing", () => {
  it("waits for eligibility and handles the original event exactly once", async () => {
    const f = fixture();
    const runtime = await f.open();
    const event = f.event();
    expect(await runtime.receive(event)).toMatchObject({ status: "accepted", runIds: [] });
    expect(runtime.database.listDeferredRoutes(Date.now() + 30_000)).toMatchObject([
      { workflowId: "waiting.md", eventId: "review-42", reason: "not_ready" },
    ]);
    await expect(runtime.rerouteEvent(event.id)).rejects.toThrow("Event has deferred routes");
    f.ready();
    f.wake(runtime);
    await Promise.all([runtime.reconcileDeferredRoutes(), runtime.reconcileDeferredRoutes()]);
    await runtime.idle();
    expect(f.handled).toEqual([{ workflow: "waiting.md", eventId: "review-42", data: { ready: true } }]);
    expect(await runtime.receive(event)).toMatchObject({ status: "duplicate" });
    f.wake(runtime);
    await runtime.reconcileDeferredRoutes();
    await runtime.idle();
    expect(runtime.database.listRuns().map((run) => ({ id: run.event.id, status: run.status })))
      .toEqual([{ id: "review-42", status: "completed" }]);
  });

  it("tracks eligibility per workflow even when another workflow already ran", async () => {
    const f = fixture();
    f.write("immediate.md");
    const runtime = await f.open();
    await runtime.receive(f.event());
    await runtime.idle();
    expect(f.handled).toEqual([{ workflow: "immediate.md", eventId: "review-42", data: { ready: false } }]);
    f.ready();
    f.wake(runtime);
    await runtime.reconcileDeferredRoutes();
    await runtime.idle();
    expect(f.handled).toEqual([
      { workflow: "immediate.md", eventId: "review-42", data: { ready: false } },
      { workflow: "waiting.md", eventId: "review-42", data: { ready: true } },
    ]);
  });

  it("recovers pending routes after a restart without a new source event", async () => {
    const f = fixture();
    const first = await f.open();
    await first.receive(f.event());
    await first.stop();
    runtimes.splice(runtimes.indexOf(first), 1);
    f.ready();
    const second = await f.open();
    f.wake(second);
    await second.reconcileDeferredRoutes();
    await second.idle();
    expect(f.handled).toEqual([{ workflow: "waiting.md", eventId: "review-42", data: { ready: true } }]);
  });

  it.each(["removed", "changed", "expired"])("discards %s routes instead of executing stale work", async (mode) => {
    const f = fixture();
    const runtime = await f.open();
    await runtime.receive(f.event());
    if (mode === "removed") fs.unlinkSync(path.join(f.home, "automations", "waiting.md"));
    if (mode === "changed") f.write("waiting.md", "Different authority.");
    if (mode === "expired") runtime.database.db.prepare("UPDATE deferred_routes SET expires_at = ?").run(Date.now() - 1);
    runtime.reloadWorkflows();
    f.ready();
    f.wake(runtime);
    await runtime.reconcileDeferredRoutes();
    await runtime.idle();
    expect(runtime.database.listDeferredRoutes(Date.now() + 86_400_000)).toEqual([]);
    expect(f.handled).toEqual([]);
    // A new event under the current configuration still executes normally.
    f.write();
    runtime.reloadWorkflows();
    await runtime.receive(f.event("new-review"));
    await runtime.idle();
    expect(f.handled).toEqual([{ workflow: "waiting.md", eventId: "new-review", data: { ready: true } }]);
  });

  it("retains pending work across temporary source failures", async () => {
    const f = fixture();
    const runtime = await f.open();
    await runtime.receive(f.event());
    f.fail(true);
    f.wake(runtime);
    await runtime.reconcileDeferredRoutes();
    expect(runtime.database.listDeferredRoutes(Date.now() + 30_000)).toMatchObject([{ reason: "evaluation_failed" }]);
    f.fail(false);
    f.ready();
    f.wake(runtime);
    await runtime.reconcileDeferredRoutes();
    await runtime.idle();
    expect(f.handled).toEqual([{ workflow: "waiting.md", eventId: "review-42", data: { ready: true } }]);
  });

  it("keeps a ready route pending while the queue is full", async () => {
    const f = fixture();
    f.write("immediate.md");
    const runtime = await f.open();
    runtime.config.runtime.maxQueuedRuns = 1;
    await runtime.receive(f.event());
    f.ready();
    f.wake(runtime);
    await runtime.reconcileDeferredRoutes();
    expect(runtime.database.listDeferredRoutes(Date.now() + 30_000)).toMatchObject([{ reason: "capacity" }]);
    await runtime.idle();
    f.wake(runtime);
    await runtime.reconcileDeferredRoutes();
    await runtime.idle();
    expect(f.handled.map((item) => ({ workflow: item.workflow, eventId: item.eventId }))).toEqual([
      { workflow: "immediate.md", eventId: "review-42" }, { workflow: "waiting.md", eventId: "review-42" },
    ]);
  });

  it("ignores irrelevant events and rechecks eligibility before execution", async () => {
    const f = fixture();
    const runtime = await f.open();
    await runtime.receive(f.event("unrelated", "irrelevant"));
    expect(runtime.database.listDeferredRoutes(Date.now() + 30_000)).toEqual([]);
    await runtime.receive(f.event());
    f.ready();
    f.wake(runtime);
    await runtime.reconcileDeferredRoutes();
    f.ready(false);
    await vi.waitFor(() => expect(runtime.database.listRuns()).toMatchObject([{ status: "queued", phase: "waiting", attempts: 0 }]));
    expect(f.handled).toEqual([]);
    f.ready();
    f.wake(runtime);
    await runtime.idle();
    expect(f.handled).toEqual([{ workflow: "waiting.md", eventId: "review-42", data: { ready: true } }]);
    await runtime.receive(f.event("fresh-review"));
    await runtime.idle();
    expect(f.handled).toEqual([
      { workflow: "waiting.md", eventId: "review-42", data: { ready: true } },
      { workflow: "waiting.md", eventId: "fresh-review", data: { ready: true } },
    ]);
  });

  it("wakes deferred routes through the public source context", async () => {
    const f = fixture();
    const runtime = await f.open();
    await runtime.start();
    await runtime.receive(f.event());
    f.ready();
    f.notify();
    await vi.waitFor(() => expect(f.handled).toEqual([{ workflow: "waiting.md", eventId: "review-42", data: { ready: true } }]));
  });

  it("reconciles on the timer when no resource notification arrives", async () => {
    const f = fixture();
    const runtime = await f.open();
    await runtime.start();
    await runtime.receive(f.event());
    f.ready();
    // Make the persisted retry due without publishing a state-change event.
    runtime.database.db.prepare("UPDATE deferred_routes SET available_at = ?").run(Date.now());
    await vi.waitFor(() => expect(f.handled).toEqual([{ workflow: "waiting.md", eventId: "review-42", data: { ready: true } }]), { timeout: 2_000 });
  });
});
