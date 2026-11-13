import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionState, JsonValue } from "@mixer/automations-sdk";
import { applyGitHubGarbageCollection, githubCaseRetentionMs, githubReceiptRetentionMs, planGitHubGarbageCollection } from "./garbage-collection.js";
import { writeRunCapability, type GitHubBranchCapability } from "./publication.js";

const temporary: string[] = [];
afterEach(() => { for (const item of temporary.splice(0)) fs.rmSync(item, { recursive: true, force: true }); });

function memoryState(): ExtensionState & { values: Map<string, JsonValue> } {
  const values = new Map<string, JsonValue>();
  return {
    values,
    get: (key) => values.get(key) as never,
    set: (key, value) => { values.set(key, value); },
    delete: (key) => { values.delete(key); },
    entries: (prefix = "") => [...values.entries()].filter(([key]) => key.startsWith(prefix)).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => ({ key, value })),
  };
}

function roots() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "roboplane-github-gc-"));
  temporary.push(home);
  const stateDirectory = path.join(home, "state");
  const caseRoot = path.join(home, "cases", "github");
  fs.mkdirSync(stateDirectory, { recursive: true });
  return { home, stateDirectory, caseRoot };
}

function capability(overrides: Partial<GitHubBranchCapability> = {}): GitHubBranchCapability {
  return {
    version: 1, runId: "run-one", repository: "owner/repo", mode: "new-branch",
    remote: "https://github.com/owner/repo.git", baseRevision: "a".repeat(40), baseBranch: "main", maxChangedFiles: 100,
    ...overrides,
  };
}

function createMemory(caseRoot: string, kind: "issue" | "pr" = "issue", number = 42): string {
  const file = path.join(caseRoot, "owner", "repo", kind, String(number), "memory.md");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "Durable context.\n");
  return file;
}

describe("GitHub garbage collection", () => {
  it("collects memory and capability only after a live-verified closed retention period", async () => {
    const root = roots();
    const state = memoryState();
    const now = Date.parse("2026-08-31T12:00:00.000Z");
    const closedKey = "case-memory:closed:owner/repo:issue:42";
    const capabilityKey = "branch-capability:owner/repo:issue:42";
    state.set(closedKey, new Date(now - githubCaseRetentionMs).toISOString());
    state.set(capabilityKey, capability({ case: { kind: "issue", number: 42 } }) as unknown as JsonValue);
    const memory = createMemory(root.caseRoot);
    const verifyCase = vi.fn(async () => ({ state: "closed" as const, linkedPullRequestOpen: false }));
    const plan = await planGitHubGarbageCollection({ ...root, state, now, verifyCase });
    expect(verifyCase).toHaveBeenCalledWith({ repository: "owner/repo", kind: "issue", number: 42 }, expect.objectContaining({ runId: "run-one" }));
    expect(plan.candidates.map((item) => item.kind)).toEqual(expect.arrayContaining(["case-memory", "case-capability", "case-closure"]));
    const result = applyGitHubGarbageCollection(plan, { ...root, state });
    expect(result.removed).toBe(3);
    expect(fs.existsSync(memory)).toBe(false);
    expect(state.get(closedKey)).toBeUndefined();
    expect(state.get(capabilityKey)).toBeUndefined();
  });

  it("cancels stale closure for a reopened case and protects a case with an open linked PR", async () => {
    const root = roots();
    const state = memoryState();
    const now = Date.parse("2026-08-31T12:00:00.000Z");
    const reopened = "case-memory:closed:owner/repo:pr:1";
    const linked = "case-memory:closed:owner/repo:issue:2";
    state.set(reopened, new Date(now - githubCaseRetentionMs).toISOString());
    state.set(linked, new Date(now - githubCaseRetentionMs).toISOString());
    state.set("branch-capability:owner/repo:issue:2", capability({ prNumber: 9, case: { kind: "issue", number: 2 } }) as unknown as JsonValue);
    const reopenedMemory = createMemory(root.caseRoot, "pr", 1);
    const linkedMemory = createMemory(root.caseRoot, "issue", 2);
    const plan = await planGitHubGarbageCollection({
      ...root, state, now,
      verifyCase: async (item) => item.number === 1 ? { state: "open" } : { state: "closed", linkedPullRequestOpen: true },
    });
    expect(plan.candidates.filter((item) => item.identifier === reopened).map((item) => item.kind)).toEqual(["case-closure"]);
    expect(plan.skipped).toContainEqual(expect.objectContaining({ identifier: "branch-capability:owner/repo:issue:2", reason: "linked pull request remains open" }));
    applyGitHubGarbageCollection(plan, { ...root, state });
    expect(state.get(reopened)).toBeUndefined();
    expect(state.get(linked)).toBeDefined();
    expect(fs.existsSync(reopenedMemory)).toBe(true);
    expect(fs.existsSync(linkedMemory)).toBe(true);
  });

  it("collects only confirmed finalized receipts and never age-deletes unresolved publication", async () => {
    const root = roots();
    const state = memoryState();
    const now = Date.parse("2026-08-31T12:00:00.000Z");
    const old = new Date(now - githubReceiptRetentionMs).toISOString();
    const confirmed = capability({ runId: "confirmed", createdAt: old, finalizedAt: old, lastReconciledAt: old, reconciliation: "confirmed" });
    const pending = capability({ runId: "pending", createdAt: old, finalizedAt: old, reconciliation: "pending", pending: { operation: "push", branch: "fix", head: "b".repeat(40), startedAt: old } });
    const uncertain = capability({ runId: "uncertain", createdAt: old, finalizedAt: old, reconciliation: "uncertain" });
    for (const item of [confirmed, pending, uncertain]) {
      writeRunCapability(root.stateDirectory, item);
      state.set(`branch-capability:run:${item.runId}`, item as unknown as JsonValue);
    }
    const plan = await planGitHubGarbageCollection({ ...root, state, now, verifyCase: async () => ({ state: "closed" }) });
    expect(plan.candidates).toContainEqual(expect.objectContaining({ kind: "run-receipt", identifier: "confirmed" }));
    expect(plan.skipped).toContainEqual(expect.objectContaining({ kind: "run-receipt", identifier: "pending", reason: "publication outcome is unresolved" }));
    expect(plan.skipped).toContainEqual(expect.objectContaining({ kind: "run-receipt", identifier: "uncertain", reason: "publication outcome is unresolved" }));
    applyGitHubGarbageCollection(plan, { ...root, state });
    expect(fs.existsSync(path.join(root.stateDirectory, "github-branch-capabilities", "runs", "confirmed.json"))).toBe(false);
    expect(fs.existsSync(path.join(root.stateDirectory, "github-branch-capabilities", "runs", "pending.json"))).toBe(true);
    expect(fs.existsSync(path.join(root.stateDirectory, "github-branch-capabilities", "runs", "uncertain.json"))).toBe(true);
  });

  it("plans expired transient markers without mutating them and revalidates before applying", async () => {
    const root = roots();
    const state = memoryState();
    const now = Date.parse("2026-08-31T12:00:00.000Z");
    state.set("self:owner/repo:42:opened", new Date(now - 1).toISOString());
    const marker = path.join(root.stateDirectory, "github-published-heads", "owner--repo", `${"a".repeat(40)}.json`);
    fs.mkdirSync(path.dirname(marker), { recursive: true });
    fs.writeFileSync(marker, JSON.stringify({ expiresAt: now - 1 }));
    const plan = await planGitHubGarbageCollection({ ...root, state, now, verifyCase: async () => ({ state: "closed" }) });
    expect(state.get("self:owner/repo:42:opened")).toBeDefined();
    expect(fs.existsSync(marker)).toBe(true);
    fs.writeFileSync(marker, JSON.stringify({ expiresAt: now + 60_000 }));
    const result = applyGitHubGarbageCollection(plan, { ...root, state });
    expect(state.get("self:owner/repo:42:opened")).toBeUndefined();
    expect(fs.existsSync(marker)).toBe(true);
    expect(result.skipped).toContainEqual(expect.objectContaining({ kind: "published-head", reason: "file changed after planning" }));
  });

  it("refuses recursive case deletion when unexpected files appear after planning", async () => {
    const root = roots();
    const state = memoryState();
    const now = Date.parse("2026-08-31T12:00:00.000Z");
    state.set("case-memory:closed:owner/repo:issue:42", new Date(now - githubCaseRetentionMs).toISOString());
    const memory = createMemory(root.caseRoot);
    const plan = await planGitHubGarbageCollection({ ...root, state, now, verifyCase: async () => ({ state: "closed" }) });
    fs.writeFileSync(path.join(path.dirname(memory), "unexpected.txt"), "retain me");
    const result = applyGitHubGarbageCollection(plan, { ...root, state });
    expect(fs.existsSync(memory)).toBe(true);
    expect(result.skipped).toContainEqual(expect.objectContaining({ kind: "case-memory", reason: "case directory changed after planning" }));
    expect(state.get("case-memory:closed:owner/repo:issue:42")).toBeDefined();
    expect(result.skipped).toContainEqual(expect.objectContaining({ kind: "case-closure", reason: "related target changed after planning" }));
  });

  it("retains case state when memory is a symbolic link", async () => {
    const root = roots();
    const state = memoryState();
    const now = Date.parse("2026-08-31T12:00:00.000Z");
    const closedKey = "case-memory:closed:owner/repo:issue:42";
    state.set(closedKey, new Date(now - githubCaseRetentionMs).toISOString());
    const memory = path.join(root.caseRoot, "owner", "repo", "issue", "42", "memory.md");
    fs.mkdirSync(path.dirname(memory), { recursive: true });
    fs.symlinkSync(path.join(root.home, "outside.md"), memory);
    const plan = await planGitHubGarbageCollection({ ...root, state, now, verifyCase: async () => ({ state: "closed" }) });
    expect(plan.skipped).toContainEqual(expect.objectContaining({ kind: "case-memory", identifier: memory, reason: "case memory is not a regular file" }));
    expect(plan.candidates.some((item) => item.identifier === closedKey)).toBe(false);
    expect(state.get(closedKey)).toBeDefined();
  });
});
