import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Event, ExtensionState, JsonValue } from "@mixer/automations-sdk";
import { caseForEvent, GitHubCaseLocks, GitHubCaseMemory } from "./memory.js";

const temporary: string[] = [];
afterEach(() => { for (const item of temporary.splice(0)) fs.rmSync(item, { recursive: true, force: true }); });

function state(): ExtensionState {
  const values = new Map<string, JsonValue>();
  return {
    get: (key) => values.get(key) as never,
    set: (key, value) => { values.set(key, value); },
    delete: (key) => { values.delete(key); },
    entries: (prefix = "") => [...values.entries()].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ key, value })),
  };
}

function event(type: string, action: string, isPullRequest: boolean, timestamp = "2026-08-28T10:00:00.000Z"): Event {
  return { id: `${type}:${action}`, type, source: "github", timestamp, repository: "owner/repo", data: { number: 42, action, isPullRequest } };
}

describe("GitHub case memory", () => {
  it("maps issue and pull-request events to stable cases", () => {
    expect(caseForEvent(event("github.issue.comment", "created", false))).toEqual({ repository: "owner/repo", kind: "issue", number: 42 });
    expect(caseForEvent(event("github.issue.comment", "created", true))).toEqual({ repository: "owner/repo", kind: "pr", number: 42 });
    expect(caseForEvent(event("github.pr.comment", "created", true))).toEqual({ repository: "owner/repo", kind: "pr", number: 42 });
  });

  it("keeps only memory.md and records closure for the verified collector", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "roboplane-memory-"));
    temporary.push(root);
    let now = Date.parse("2026-08-28T10:00:00.000Z");
    const memory = new GitHubCaseMemory(root, state(), () => now);
    const item = caseForEvent(event("github.issue", "opened", false))!;
    const loaded = memory.load(item);
    fs.writeFileSync(loaded.path, "Investigated the reproduction.\n");
    expect(fs.readdirSync(path.dirname(loaded.path))).toEqual(["memory.md"]);
    memory.observe(event("github.issue", "closed", false));
    now += 24 * 60 * 60 * 1_000;
    expect(fs.existsSync(loaded.path)).toBe(true);
  });

  it("cancels cleanup when a case is reopened", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "roboplane-memory-"));
    temporary.push(root);
    let now = Date.parse("2026-08-28T10:00:00.000Z");
    const memory = new GitHubCaseMemory(root, state(), () => now);
    const item = caseForEvent(event("github.pull-request", "opened", true))!;
    const loaded = memory.load(item);
    memory.observe(event("github.pull-request", "closed", true));
    memory.observe(event("github.pull-request", "reopened", true, "2026-08-28T11:00:00.000Z"));
    now += 2 * 24 * 60 * 60 * 1_000;
    expect(fs.existsSync(loaded.path)).toBe(true);
  });
});

describe("GitHub case locks", () => {
  it("serializes the same case without blocking a different case", async () => {
    const locks = new GitHubCaseLocks();
    const first = await locks.acquire({ repository: "owner/repo", kind: "issue", number: 1 });
    let secondReady = false;
    const second = locks.acquire({ repository: "owner/repo", kind: "issue", number: 1 }).then((release) => { secondReady = true; return release; });
    const unrelated = await locks.acquire({ repository: "owner/repo", kind: "issue", number: 2 });
    await Promise.resolve();
    expect(secondReady).toBe(false);
    unrelated();
    first();
    const releaseSecond = await second;
    expect(secondReady).toBe(true);
    releaseSecond();
  });
});
