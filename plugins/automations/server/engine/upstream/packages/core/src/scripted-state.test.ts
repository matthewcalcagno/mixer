import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Event, Run, Workflow } from "@mixer/automations-sdk";
import { StateDatabase } from "./database.js";

const databases: StateDatabase[] = [];
const directories: string[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); for (const dir of directories.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "roboplane-step-state-")); directories.push(dir);
  const db = new StateDatabase(dir); databases.push(db);
  const event: Event = { id: "event", type: "manual", source: "cli", timestamp: new Date().toISOString(), data: {} };
  const workflow: Workflow = { id: "parent.yaml", path: "/parent.yaml", name: "parent", agent: "", execution: "host", on: { manual: {} }, prompt: "", safeActions: {},
    task: { kind: "steps", runner: "steps", configuration: { steps: [{ id: "submit", run: "echo hello" }] } } };
  const run: Run = { id: "parent", workflowId: workflow.id, event, status: "queued", createdAt: event.timestamp, updatedAt: event.timestamp };
  db.insertRun(run, "", "host", "scratch", { workflow });
  const lease = db.claimEligibleRun("worker"); if (!lease) throw new Error("Could not claim fixture run");
  db.updateRunFenced(lease, "running");
  db.recordStepFenced(lease, { id: "submit", ordinal: 0, name: "submit", attempt: 1, status: "running" });
  return { db, lease, workflow, event, run };
}

describe("fenced scripted state", () => {
  it("rejects stale step writers", () => {
    const { db, lease } = fixture();
    db.db.prepare("UPDATE runs SET lease_generation = lease_generation + 1 WHERE id = ?").run(lease.runId);
    expect(() => db.recordStepFenced(lease, { id: "submit", ordinal: 0, name: "submit", attempt: 1, status: "succeeded" })).toThrow("run_lease_lost");
    expect(db.listSteps(lease.runId)[0]?.status).toBe("running");
  });
  it("persists idempotent action admission across reopening the database", () => {
    const { db, lease } = fixture();
    const record = { id: "action", runId: lease.runId, action: "test.effect", payload: { decision: "write" }, status: "proposed" as const, createdAt: new Date().toISOString() };
    expect(db.admitActionRequest(lease, "submit", 1, "write", "hash", record).status).toBe("proposed");
    const other = new StateDatabase(path.dirname(db.db.name)); databases.push(other);
    expect(other.admitActionRequest(lease, "submit", 1, "write", "hash", { ...record, id: "duplicate" }).id).toBe("action");
    expect(other.listActions(lease.runId).map(action => action.id)).toEqual(["action"]);
  });
  it.each(["lease", "attempt", "deadline", "cancellation"])("rejects action admission with invalid %s scope", kind => {
    const { db, lease } = fixture();
    if (kind === "lease") db.db.prepare("UPDATE runs SET lease_generation = lease_generation + 1 WHERE id = ?").run(lease.runId);
    if (kind === "attempt") db.recordStepFenced(lease, { id: "submit", ordinal: 0, name: "submit", attempt: 2, status: "running" });
    if (kind === "deadline") db.db.prepare("UPDATE runs SET deadline = 0 WHERE id = ?").run(lease.runId);
    if (kind === "cancellation") db.requestRunCancellation(lease.runId);
    expect(() => db.admitActionRequest(lease, "submit", 1, "write", "hash", { id: "action", runId: lease.runId, action: "test.effect", payload: {}, status: "proposed", createdAt: new Date().toISOString() })).toThrow("action_parent_unavailable");
    expect(db.listActions(lease.runId)).toEqual([]);
  });
  it.each(["expired", "startup"])("does not retry interrupted scripts during %s recovery", (mode) => {
    const { db, lease } = fixture();
    db.admitActionRequest(lease, "submit", 1, "write", "hash", { id: "action", runId: lease.runId, action: "test.effect", payload: {}, status: "proposed", createdAt: new Date().toISOString() });
    db.db.prepare("UPDATE runs SET lease_expires_at = 0 WHERE id = ?").run(lease.runId);
    if (mode === "expired") db.recoverExpiredRuns(10); else db.recoverInterruptedRuns(10);
    expect(db.getRun(lease.runId)?.status).toBe("interrupted"); expect(db.listSteps(lease.runId)[0]?.status).toBe("interrupted");
    expect(db.listActions(lease.runId)[0]?.status).toBe("rejected");
  });
  it("atomically admits one linked child and reconciles duplicate submission", () => {
    const { db, lease, workflow, event } = fixture();
    const childEvent = { ...event, id: "child-event" };
    const child: Run = { id: "child", workflowId: "child.md", event: childEvent, status: "queued", createdAt: event.timestamp, updatedAt: event.timestamp };
    const record = { run: child, agent: "fake", execution: "host", metadata: { workflow: { ...workflow, id: "child.md", task: undefined, agent: "fake" } } };
    expect(db.admitChild(lease, "submit", "key", "hash", childEvent, record, 10, 1).id).toBe("child");
    expect(db.admitChild(lease, "submit", "key", "hash", childEvent, record, 10, 1).id).toBe("child");
    expect(db.childRuns("parent")).toEqual(["child"]); expect(db.parentRun("child")).toBe("parent");
    expect(() => db.admitChild(lease, "submit", "key", "different", childEvent, record, 10, 1)).toThrow("handoff_key_conflict");
  });
  it("rejects cancelled parents without creating a child", () => {
    const { db, lease, workflow, event, run } = fixture(); db.requestRunCancellation(run.id);
    expect(() => db.admitChild(lease, "submit", "key", "hash", { ...event, id: "child-event" }, { run: { ...run, id: "child" }, agent: "fake", execution: "host", metadata: { workflow } }, 10, 1)).toThrow("parent_unavailable");
    expect(db.childRuns(run.id)).toEqual([]); expect(db.getRun("child")).toBeUndefined();
  });
  it("rolls back child admission at queue capacity", () => {
    const { db, lease, workflow, event, run } = fixture();
    const childEvent = { ...event, id: "child-event" };
    expect(() => db.admitChild(lease, "submit", "key", "hash", childEvent, { run: { ...run, id: "child", event: childEvent }, agent: "fake", execution: "host", metadata: { workflow } }, 0, 1)).toThrow("capacity");
    expect(db.childRuns(run.id)).toEqual([]); expect(db.hasEvent(childEvent.id)).toBe(false);
  });
});
