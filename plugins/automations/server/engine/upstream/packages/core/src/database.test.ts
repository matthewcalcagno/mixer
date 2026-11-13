import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import type { Event, Run, Workflow } from "@mixer/automations-sdk";
import { StateDatabase } from "./database.js";

const temporary: string[] = [];

function temp(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "roboplane-database-test-"));
  temporary.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporary.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function event(id: string): Event {
  return { id, type: "test.item", source: "test", timestamp: "2026-09-03T08:00:00.000Z", data: {} };
}

function workflow(): Workflow {
  return {
    id: "task.md", path: "/task.md", name: "task", on: { "test.item": {} }, extensions: {}, agent: "fake",
    execution: "host", workspace: "worktree", safeActions: {}, prompt: "Work.",
  };
}

function run(id: string, eventId = `${id}-event`): Run {
  const createdAt = "2026-09-03T08:00:00.000Z";
  return { id, workflowId: "task.md", event: event(eventId), status: "queued", createdAt, updatedAt: createdAt };
}

function insert(database: StateDatabase, value: Run, scheduling?: { availableAt?: number; deadline?: number }): void {
  expect(database.admitEventWithRuns(value.event, [{
    run: value, agent: "fake", execution: "host", workspace: "worktree", metadata: { workflow: workflow() }, ...scheduling,
  }], 10)).toMatchObject({ admitted: true });
}

describe("StateDatabase autonomy persistence", () => {
  it("migrates a current unversioned database without losing runs", () => {
    const directory = temp();
    const legacy = new Database(path.join(directory, "roboplane.db"));
    legacy.exec(`
      CREATE TABLE events (id TEXT PRIMARY KEY, type TEXT NOT NULL, source TEXT NOT NULL, timestamp TEXT NOT NULL, payload TEXT NOT NULL);
      CREATE TABLE runs (
        id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL, repository TEXT, event_id TEXT NOT NULL,
        event_json TEXT NOT NULL, agent TEXT NOT NULL, workspace TEXT, status TEXT NOT NULL,
        error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
    `);
    const value = run("legacy");
    legacy.prepare("INSERT INTO events VALUES (?, ?, ?, ?, ?)").run(value.event.id, value.event.type, value.event.source, value.event.timestamp, JSON.stringify(value.event));
    legacy.prepare("INSERT INTO runs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
      value.id, value.workflowId, null, value.event.id, JSON.stringify(value.event), "fake", null,
      value.status, null, value.createdAt, value.updatedAt,
    );
    legacy.close();

    const database = new StateDatabase(directory);
    expect(database.getRun("legacy")).toMatchObject({ id: "legacy", leaseGeneration: 0 });
    expect(database.db.pragma("user_version", { simple: true })).toBe(8);
    database.close();
  });

  it("rejects stale fenced mutations after a run is reclaimed", () => {
    const database = new StateDatabase(temp());
    insert(database, run("fenced"));
    const now = Date.now();
    const first = database.claimEligibleRun("worker", 10, now)!;
    const second = database.claimEligibleRun("worker", 60_000, now + 11)!;

    expect(second.generation).toBe(first.generation + 1);
    expect(database.updateRunFenced(first, "running")).toBe(false);
    expect(database.updateRunFenced(second, "running", {
      outcome: { started: true },
      lifecycle: { id: "fenced-started", event: "run:started", payload: { generation: second.generation }, availableAt: 0 },
    })).toBe(true);
    expect(database.getRun("fenced")).toMatchObject({ status: "running", outcome: { started: true } });
    expect(database.getLifecycle("fenced-started")).toMatchObject({ runId: "fenced", event: "run:started" });
    database.close();
  });

  it("claims only available, unexpired, uncancelled runs", () => {
    const database = new StateDatabase(temp());
    const now = Date.now();
    insert(database, run("future"), { availableAt: now + 10_000 });
    insert(database, run("expired"), { deadline: now });
    insert(database, run("cancelled"));
    insert(database, run("eligible"), { availableAt: now - 1, deadline: now + 10_000 });
    expect(database.requestRunCancellation("cancelled", "operator request")).toBe(true);

    expect(database.claimEligibleRun("worker", 60_000, now)?.runId).toBe("eligible");
    expect(database.claimEligibleRun("worker", 60_000, now)).toBeUndefined();
    expect(database.getRun("cancelled")?.cancellation).toMatchObject({ reason: "operator request" });
    database.close();
  });

  it("starts the full execution window on first claim, not admission, and retains it across recovery", () => {
    const database = new StateDatabase(temp());
    const admittedAt = Date.now() - 30 * 60_000;
    const claimedAt = Date.now();
    insert(database, { ...run("waiting"), createdAt: new Date(admittedAt).toISOString() });
    expect(database.getRun("waiting")?.deadline).toBeUndefined();

    const first = database.claimEligibleRun("first", 10, claimedAt, 1, 3_600_000)!;
    expect(database.getRun("waiting")?.deadline).toBe(claimedAt + 3_600_000);
    expect(database.updateRunFenced(first, "running")).toBe(true);
    database.recoverExpiredRuns(2, claimedAt + 11);
    const second = database.claimEligibleRun("second", 60_000, claimedAt + 11, 1, 3_600_000)!;
    expect(database.getRun("waiting")?.deadline).toBe(claimedAt + 3_600_000);
    expect(second.generation).toBe(first.generation + 1);
    database.close();
  });

  it("uses the snapshotted workflow timeout instead of the runtime default", () => {
    const database = new StateDatabase(temp());
    const value = run("custom-timeout");
    const custom = { ...workflow(), timeout: 12_000 };
    expect(database.admitEventWithRuns(value.event, [{
      run: value, agent: "fake", execution: "host", metadata: { workflow: custom },
    }], 10).admitted).toBe(true);
    const now = Date.now();
    expect(database.claimEligibleRun("worker", 60_000, now, 1, 3_600_000)).toBeDefined();
    expect(database.getRun(value.id)?.deadline).toBe(now + 12_000);
    database.close();
  });

  it("removes admission-time deadlines from never-started legacy runs", () => {
    const directory = temp();
    const database = new StateDatabase(directory);
    insert(database, run("never-started"), { deadline: Date.now() - 1 });
    insert(database, run("retry"), { deadline: Date.now() + 10_000 });
    database.db.prepare("UPDATE runs SET attempts = 1 WHERE id = 'retry'").run();
    database.db.pragma("user_version = 3");
    database.close();

    const migrated = new StateDatabase(directory);
    expect(migrated.getRun("never-started")?.deadline).toBeUndefined();
    expect(migrated.getRun("retry")?.deadline).toBeDefined();
    migrated.close();
  });

  it("rejects over-capacity admission atomically", () => {
    const database = new StateDatabase(temp());
    insert(database, run("existing"));
    const incoming = event("incoming-event");
    const result = database.admitEventWithRuns(incoming, [
      { run: run("one", incoming.id), agent: "fake", execution: "host", metadata: { workflow: workflow() } },
      { run: { ...run("two", incoming.id), workflowId: "other.md" }, agent: "fake", execution: "host", metadata: { workflow: workflow() } },
    ], 2);

    expect(result).toEqual({ admitted: false, reason: "capacity" });
    expect(database.hasEvent(incoming.id)).toBe(false);
    expect(database.listRuns()).toHaveLength(1);
    database.close();
  });

  it("lists recent terminal runs oldest-first and always places active runs last", () => {
    const database = new StateDatabase(temp());
    for (const id of ["expired", "recent-old", "recent-new", "active-old"]) insert(database, run(id));
    const update = database.db.prepare("UPDATE runs SET status = ?, created_at = ?, updated_at = ? WHERE id = ?");
    update.run("completed", "2026-09-04T08:00:00.000Z", "2026-09-05T08:00:00.000Z", "expired");
    update.run("completed", "2026-09-06T08:00:00.000Z", "2026-09-06T10:00:00.000Z", "recent-old");
    update.run("failed", "2026-09-06T09:00:00.000Z", "2026-09-06T12:00:00.000Z", "recent-new");
    update.run("running", "2026-09-01T08:00:00.000Z", "2026-09-01T08:00:00.000Z", "active-old");

    expect(database.listRunsForDisplay({ since: "2026-09-06T00:00:00.000Z" }).map(({ id }) => id))
      .toEqual(["recent-old", "recent-new", "active-old"]);
    expect(database.listRunsForDisplay({ since: "2026-09-06T00:00:00.000Z", limit: 1 }).map(({ id }) => id))
      .toEqual(["recent-new", "active-old"]);
    expect(database.listRunsForDisplay().map(({ id }) => id))
      .toEqual(["expired", "recent-old", "recent-new", "active-old"]);
    database.close();
  });

  it("prunes complete run graphs while retaining deduplication and unfinished work", () => {
    const database = new StateDatabase(temp());
    for (const id of ["expired", "pending-lifecycle", "active", "recent"]) insert(database, run(id));
    const update = database.db.prepare("UPDATE runs SET status = ?, updated_at = ? WHERE id = ?");
    update.run("completed", "2026-09-01T08:00:00.000Z", "expired");
    update.run("failed", "2026-09-01T08:00:00.000Z", "pending-lifecycle");
    update.run("running", "2026-09-01T08:00:00.000Z", "active");
    update.run("completed", "2026-09-06T08:00:00.000Z", "recent");
    database.insertAction({ id: "expired-action", runId: "expired", action: "test.done", payload: {}, status: "rejected", createdAt: "2026-09-01T08:00:00.000Z" });
    database.insertArtifact("expired-artifact", "expired", "workspace", { version: 1, files: [], hash: "artifact-hash" }, "artifact-hash", "2026-09-01T08:00:00.000Z");
    database.insertHandoff({ id: "expired-handoff", runId: "expired", role: "planner", ordinal: 0, payload: {}, hash: "handoff-hash", createdAt: "2026-09-01T08:00:00.000Z" });
    database.enqueueLifecycle({ id: "expired-lifecycle", runId: "expired", event: "run:finalized", payload: {}, availableAt: 0 });
    const delivery = database.claimLifecycle("worker")!;
    database.completeLifecycle(delivery.id, "worker", delivery.leaseGeneration);
    database.enqueueLifecycle({ id: "pending-lifecycle", runId: "pending-lifecycle", event: "run:finalized", payload: {}, availableAt: 0 });

    expect(database.pruneHistory("2026-09-06T00:00:00.000Z")).toEqual(["expired"]);
    expect(database.getRun("expired")).toBeUndefined();
    expect(database.hasEvent("expired-event")).toBe(true);
    expect(database.eventHasRuns("expired-event")).toBe(true);
    expect(database.getRun("pending-lifecycle")).toBeDefined();
    expect(database.getRun("active")).toBeDefined();
    expect(database.getRun("recent")).toBeDefined();
    for (const table of ["safe_actions", "artifacts", "agent_handoffs", "lifecycle_outbox"]) {
      expect((database.db.prepare(`SELECT COUNT(*) count FROM ${table} WHERE run_id = 'expired'`).get() as { count: number }).count).toBe(0);
    }
    database.close();
  });

  it("fences lifecycle outbox delivery", () => {
    const database = new StateDatabase(temp());
    expect(database.enqueueLifecycle({ id: "notice", runId: "run", event: "run:finalized", payload: { ok: true }, availableAt: 0 })).toBe(true);
    const first = database.claimLifecycle("worker", 10, 100)!;
    const second = database.claimLifecycle("worker", 10, 111)!;

    expect(database.completeLifecycle(first.id, "worker", first.leaseGeneration)).toBe(false);
    expect(database.completeLifecycle(second.id, "worker", second.leaseGeneration)).toBe(true);
    expect(database.getLifecycle("notice")).toMatchObject({ status: "delivered", attempts: 2 });
    database.close();
  });

  it("recovers an expired active lease while another worker remains live", () => {
    const database = new StateDatabase(temp());
    insert(database, run("expired-active"));
    const now = Date.now();
    const lease = database.claimEligibleRun("dead-worker", 10, now)!;
    expect(database.updateRunFenced(lease, "running")).toBe(true);
    database.recoverExpiredRuns(2, now + 11);
    expect(database.getRun("expired-active")).toMatchObject({ status: "queued", error: "Recovered after expired run lease" });
    expect(database.claimEligibleRun("live-worker", 60_000, now + 11)?.generation).toBe(lease.generation + 1);
    database.close();
  });

  it("cancels a queued run after its stale lease expires", () => {
    const database = new StateDatabase(temp());
    insert(database, run("stale-queued"));
    const now = Date.now();
    const lease = database.claimEligibleRun("dead-worker", 10, now)!;
    expect(database.updateRunFenced(lease, "queued", { availableAt: now + 1_000 })).toBe(true);
    expect(database.requestRunCancellation("stale-queued", "operator request")).toBe(true);
    expect(database.cancelQueuedRun("stale-queued", "operator request", { version: 1, outcome: "blocked" }, now)).toBe(false);
    expect(database.cancelQueuedRun("stale-queued", "operator request", { version: 1, outcome: "blocked" }, now + 11)).toBe(true);
    expect(database.getRun("stale-queued")?.status).toBe("cancelled");
    database.close();
  });
});
