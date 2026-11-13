import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Event, EventSource, EventSourceContext, HookContext, HookName, Logger, MixerAutomationsAPI, Run, SafeActionDefinition, Workflow, Workspace, WorkspaceArtifact } from "@mixer/automations-sdk";
import github, { buildWorkflowFailureIssue, hasPublishedHeadMarker, installPublishGuard, persistedReviewId, pullRequestPublicationMode, resolveGitHubToken } from "./index.js";
import type { GitHubEventData } from "./matcher.js";
import { readRunCapability, writeRunCapability } from "./publication.js";

const temporary: string[] = [];
afterEach(() => {
  for (const item of temporary.splice(0)) fs.rmSync(item, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

const logger: Logger = { debug() {}, info() {}, warn() {}, error() {}, child() { return logger; } };

function git(root: string, ...args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(",")}}`;
  return JSON.stringify(value);
}

function artifact(revision: string): WorkspaceArtifact {
  const file = { path: "src/fix.ts", operation: "update" as const, mode: "644", size: 2, sha256: createHash("sha256").update("ok").digest("hex"), content: Buffer.from("ok").toString("base64") };
  const unsigned = { version: 1 as const, baseRevision: revision, files: [file] };
  return { ...unsigned, hash: createHash("sha256").update(stable(unsigned)).digest("hex") };
}

function setupActions(stateDirectory = "/tmp/roboplane-github-tests/state"): Map<string, SafeActionDefinition> {
  const actions = new Map<string, SafeActionDefinition>();
  const api = {
    config: { get: () => ({ token: "test-token" }) },
    state: { namespace: () => ({ get: () => undefined, set() {}, delete() {} }) },
    events: { registerSource() {} },
    inputs: { register() {} }, workflows: { registerField() {}, registerRunner() {} },
    commands: { register() {} },
    hooks: { on() {} },
    actions: { register(name: string, definition: SafeActionDefinition) { actions.set(name, definition); } },
    paths: { home: path.dirname(stateDirectory), state: stateDirectory, cases: path.join(path.dirname(stateDirectory), "cases") },
  } as unknown as MixerAutomationsAPI;
  github.setup!(api);
  return actions;
}

function setupAction(name = "github.pr-comment.resolve", stateDirectory?: string): SafeActionDefinition {
  return setupActions(stateDirectory).get(name)!;
}

async function setupSources(): Promise<Map<string, EventSource>> {
  const sources = new Map<string, EventSource>();
  const api = {
    config: { get: () => ({ token: "test-token" }) },
    state: { namespace: () => ({ get: () => undefined, set() {}, delete() {} }) },
    events: { registerSource(name: string, source: EventSource) { sources.set(name, source); } },
    inputs: { register() {} }, workflows: { registerField() {}, registerRunner() {} },
    commands: { register() {} },
    hooks: { on() {} },
    actions: { register() {} },
    paths: { home: "/tmp/roboplane-github-tests", cases: "/tmp/roboplane-github-tests/.roboplane/cases" },
  } as unknown as MixerAutomationsAPI;
  await github.setup!(api);
  return sources;
}

function workflow(repository: Workflow["repository"] = "owner/repo"): Workflow {
  return {
    id: "maintainer/issue-intake.md", path: "/automations/maintainer/issue-intake.md", name: "Issue intake",
    repository, on: { "github.issue": {} }, agent: "codex", execution: "host", safeActions: {}, prompt: "Handle it.",
  };
}

function repositoryComment(id: string) {
  return {
    id, type: "IssueCommentEvent", created_at: "2026-09-28T09:00:00Z", actor: { login: "reviewer" },
    payload: { action: "created", issue: { number: 42, title: "An issue", state: "open" }, comment: { id: Number(id), body: "Please investigate", user: { login: "reviewer" } } },
  };
}

async function startPoller(state: Map<string, unknown>, emit: EventSourceContext["emit"], reportHealth = vi.fn()) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "roboplane-github-poller-"));
  temporary.push(home);
  fs.mkdirSync(path.join(home, "state"));
  const sources = new Map<string, EventSource>();
  const error = vi.fn();
  const warn = vi.fn();
  const commands = new Map<string, Parameters<MixerAutomationsAPI["commands"]["register"]>[0]>();
  const api = {
    config: { get: () => ({ token: "test-token", pollInterval: "5m" }) },
    state: { namespace: () => ({ get: (key: string) => state.get(key), set: (key: string, value: unknown) => { state.set(key, value); }, delete: (key: string) => { state.delete(key); }, entries: (prefix = "") => [...state].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ key, value })) }) },
    events: { registerSource(name: string, source: EventSource) { sources.set(name, source); } },
    inputs: { register() {} }, workflows: { registerField() {}, registerRunner() {} }, commands: { register(command: Parameters<MixerAutomationsAPI["commands"]["register"]>[0]) { commands.set(command.name, command); } }, hooks: { on() {} }, actions: { register() {} },
    paths: { home, state: path.join(home, "state"), cases: path.join(home, ".roboplane", "cases") }, logger: { ...logger, error, warn },
  } as unknown as MixerAutomationsAPI;
  await github.setup!(api);
  const source = sources.get("github.issue")!;
  const controller = new AbortController();
  await source.start!({ type: "github.issue", signal: controller.signal, subscriptions: [{ type: "github.issue", repository: "owner/repo", workflowId: "test.md", config: {} }], emit, reportHealth });
  return { source, commands, error, warn, reportHealth, stop: () => { controller.abort(); void source.stop?.(); } };
}

describe("polling trigger provenance and health", () => {
  it("keeps the original PR revision separate from current resource state", async () => {
    const original = "a".repeat(40); const current = "b".repeat(40);
    const state = new Map<string, unknown>([["events:owner/repo:cursor", "old"]]);
    const emit = vi.fn(async (_event: Event) => ({ version: 1 as const, eventId: "new", status: "accepted" as const }));
    vi.stubGlobal("fetch", vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url.endsWith("/user")) return Response.json({ id: 1, login: "maintainer" });
      if (url.includes("/events?")) return Response.json([
        { id: "new", type: "PullRequestEvent", created_at: new Date().toISOString(), actor: { login: "human" }, payload: {
          action: "opened", pull_request: { number: 42, head: { sha: original } },
        } }, { id: "old", type: "Unsupported" },
      ]);
      if (url.endsWith("/pulls/42")) return Response.json({ number: 42, state: "open", draft: false,
        head: { sha: current, ref: "feature/fix", repo: { full_name: "owner/repo" } }, base: { sha: current, ref: "main", repo: { full_name: "owner/repo" } } });
      throw new Error(`Unexpected request: ${url}`);
    }));
    const poller = await startPoller(state, emit);
    try {
      await vi.waitFor(() => expect(emit).toHaveBeenCalledTimes(1));
      expect(emit.mock.calls[0]?.[0]).toMatchObject({ data: { triggerHeadSha: original, headSha: current } });
    } finally { poller.stop(); }
  });

  it("reports polling failures and restores ready health after a successful pass", async () => {
    vi.useFakeTimers();
    const state = new Map<string, unknown>([["events:owner/repo:cursor", "old"]]);
    let fail = true;
    vi.stubGlobal("fetch", vi.fn(async () => fail ? new Response("No access", { status: 401 }) : Response.json([{ id: "old", type: "Unsupported" }])));
    const reportHealth = vi.fn();
    const poller = await startPoller(state, async () => true, reportHealth);
    try {
      await vi.waitFor(() => expect(reportHealth).toHaveBeenCalledWith(expect.objectContaining({ status: "degraded", reason: "github_poll_failed" })));
      expect(state.get("events:owner/repo:cursor")).toBe("old");
      fail = false;
      await vi.advanceTimersByTimeAsync(300_000);
      expect(reportHealth).toHaveBeenLastCalledWith(expect.objectContaining({ status: "ready" }));
    } finally { poller.stop(); vi.useRealTimers(); }
  });
});

const revision = "a".repeat(40);
const run: Run = { id: "run-test", workflowId: "workflow.md", repository: "owner/repo", event: {} as Event, status: "running", createdAt: "now", updatedAt: "now" };
const data = {
  isPullRequest: true, state: "open", merged: false, fork: false, number: 42,
  baseRepository: "owner/repo", headRepository: "owner/repo", headRef: "feature/fix", headSha: revision,
  commentId: 9, commentKind: "conversation" as const,
};

describe("scheduled pull-request runs", () => {
  const config = { cron: "0 * * * *", where: { all: [
    { "pull-request-author": "me" }, { state: "open" }, { draft: false }, { merged: false },
    { labels: { all: ["mcalcagno:auto-pr"], none: ["roboplane-ignore"] } },
  ] } };
  const pr = (number: number, extra: Record<string, unknown> = {}) => ({
    number, state: "open", draft: false, user: { login: "maintainer" },
    labels: [{ name: "mcalcagno:auto-pr" }],
    head: { ref: `fix-${number}`, sha: "a".repeat(40), repo: { full_name: "owner/repo" } },
    base: { ref: "develop", sha: "b".repeat(40), repo: { full_name: "owner/repo" } },
    ...extra,
  });

  async function scheduledSource(values: Map<string, unknown>) {
    const sources = new Map<string, EventSource>();
    const errors: unknown[] = [];
    const api = {
      config: { get: () => ({ token: "test-token" }) },
      state: { namespace: () => ({ get: (key: string) => values.get(key), set: (key: string, value: unknown) => { values.set(key, value); }, delete: (key: string) => { values.delete(key); } }) },
      events: { registerSource(name: string, source: EventSource) { sources.set(name, source); } },
      inputs: { register() {} }, workflows: { registerField() {}, registerRunner() {} }, commands: { register() {} }, hooks: { on() {} }, actions: { register() {} },
      paths: { home: "/tmp/roboplane-github-tests", cases: "/tmp/roboplane-github-tests/.roboplane/cases" }, logger: { ...logger, error: (detail: unknown) => { errors.push(detail); } },
    } as unknown as MixerAutomationsAPI;
    await github.setup!(api);
    return { source: sources.get("github.pr.schedule")!, errors };
  }

  it("starts one activated PR run per eligible PR and not for ignored, draft, or other authors", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const { source, errors } = await scheduledSource(new Map());
    const emitted: Event[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/user")) return new Response(JSON.stringify({ login: "maintainer", id: 1 }));
      if (url.includes("/pulls?")) return new Response(JSON.stringify([
        pr(64), pr(65), pr(66, { labels: [{ name: "mcalcagno:auto-pr" }, { name: "roboplane-ignore" }] }),
        pr(67, { draft: true }), pr(68, { user: { login: "someone-else" } }),
        pr(69, { merged: true }), pr(70, { draft: undefined }),
      ]));
      if (url.endsWith("/pulls/64")) return new Response(JSON.stringify(pr(64)));
      throw new Error(`unexpected request ${url}`);
    }));
    const controller = new AbortController();
    const subscription = { type: "github.pr.schedule", workflowId: "merge.md", repository: "owner/repo", config };
    try {
      source.start({ type: "github.pr.schedule", signal: controller.signal, subscriptions: [subscription], emit: async (event) => {
        emitted.push(event);
        return { version: 1, eventId: event.id, status: "accepted" };
      } });
      await vi.advanceTimersByTimeAsync(3_600_000);
      expect({ numbers: emitted.map((event) => (event.data as GitHubEventData).number), errors }).toEqual({ numbers: [64, 65], errors: [] });
      expect(emitted[0]?.id).toBe("github.pr.schedule:merge.md:owner/repo:2026-01-01T01:00:00.000Z:64");
      expect(emitted[0]?.data).toMatchObject({ merged: false, pullRequest: { merged: false } });
      expect(await source.match!(emitted[0]!, config, { signal: controller.signal, workflowId: "merge.md" })).toBe(true);
      expect(await source.match!(emitted[0]!, config, { signal: controller.signal, workflowId: "other.md" })).toBe(false);
      const activated = await source.activate!(emitted[0]!);
      expect(activated.workspaceSource).toEqual({ repository: "owner/repo", revision: "a".repeat(40) });
      expect((activated.data as GitHubEventData).number).toBe(64);
      vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url.endsWith("/user")) return new Response(JSON.stringify({ login: "maintainer", id: 1 }));
        if (url.endsWith("/pulls/65")) return new Response(JSON.stringify(pr(65, { labels: [{ name: "roboplane-ignore" }] })));
        throw new Error(`unexpected request ${url}`);
      }));
      expect(await source.activate!(emitted[1]!)).toMatchObject({ decision: { kind: "skip", reason: "scheduled_pr_filter_changed" } });
    } finally { controller.abort(); source.stop?.(); vi.useRealTimers(); }
  });

  it.each([
    { change: { state: "closed", merged: true }, reason: "scheduled_pr_already_merged" },
    { change: { state: "closed", merged: false }, reason: "scheduled_pr_closed" },
    { change: { draft: true }, reason: "scheduled_pr_filter_changed" },
    { change: { labels: [] }, reason: "scheduled_pr_filter_changed" },
  ])("skips obsolete scheduled work with $reason", async ({ change, reason }) => {
    const { source } = await scheduledSource(new Map());
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/user")) return Response.json({ login: "maintainer", id: 1 });
      if (url.endsWith("/pulls/65")) return Response.json(pr(65, change));
      throw new Error(`unexpected request ${url}`);
    }));
    const activated = await source.activate!({ id: "scheduled", type: "github.pr.schedule", source: "github",
      repository: "owner/repo", timestamp: new Date().toISOString(), data: { number: 65, isPullRequest: true, scheduledWhere: config.where } });
    expect(activated.decision).toEqual({ kind: "skip", reason });
  });

  it("does not disguise scheduled activation authentication failures as obsolete work", async () => {
    const { source } = await scheduledSource(new Map());
    vi.stubGlobal("fetch", vi.fn(async () => new Response("Bad credentials", { status: 401 })));
    await expect(source.activate!({ id: "scheduled", type: "github.pr.schedule", source: "github",
      repository: "owner/repo", timestamp: new Date().toISOString(), data: { number: 65, isPullRequest: true, scheduledWhere: config.where } })).rejects.toThrow("401");
  });

  it("does not disguise a missing live PR state as closed work", async () => {
    const { source } = await scheduledSource(new Map());
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/user")) return Response.json({ login: "maintainer", id: 1 });
      if (url.endsWith("/pulls/65")) return Response.json(pr(65, { state: undefined }));
      throw new Error(`unexpected request ${url}`);
    }));
    await expect(source.activate!({ id: "scheduled", type: "github.pr.schedule", source: "github",
      repository: "owner/repo", timestamp: new Date().toISOString(), data: { number: 65, isPullRequest: true, scheduledWhere: config.where } })).rejects.toThrow("authoritative state");
  });

  it("retries a partially rejected hourly scan without duplicating accepted PRs", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const values = new Map<string, unknown>();
    const { source, errors } = await scheduledSource(values);
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/user")) return new Response(JSON.stringify({ login: "maintainer", id: 1 }));
      if (url.includes("/pulls?")) return new Response(JSON.stringify([pr(64), pr(65)]));
      throw new Error(`unexpected request ${url}`);
    }));
    const accepted = new Map<string, Event>();
    let failed = false;
    const controller = new AbortController();
    try {
      source.start({
        type: "github.pr.schedule", signal: controller.signal,
        subscriptions: [{ type: "github.pr.schedule", workflowId: "merge.md", repository: "owner/repo", config }],
        emit: async (event) => {
          if ((event.data as GitHubEventData).number === 65 && !failed) {
            failed = true;
            return { version: 1, eventId: event.id, status: "rejected", reason: "capacity" };
          }
          const status = accepted.has(event.id) ? "duplicate" : "accepted";
          accepted.set(event.id, event);
          return { version: 1, eventId: event.id, status };
        },
      });
      await vi.advanceTimersByTimeAsync(3_630_000);
      expect({ numbers: [...accepted.values()].map((event) => (event.data as GitHubEventData).number), errors }).toEqual({ numbers: [64, 65], errors: [{ repository: "owner/repo", workflowId: "merge.md", error: "PR schedule delivery rejected: capacity" }] });
      expect([...accepted.keys()]).toEqual([
        "github.pr.schedule:merge.md:owner/repo:2026-01-01T01:00:00.000Z:64",
        "github.pr.schedule:merge.md:owner/repo:2026-01-01T01:00:00.000Z:65",
      ]);
    } finally { controller.abort(); source.stop?.(); vi.useRealTimers(); }
  });

  it("includes eligible PRs beyond the first page", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const { source } = await scheduledSource(new Map());
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/user")) return new Response(JSON.stringify({ login: "maintainer", id: 1 }));
      if (url.includes("&page=1")) return new Response(JSON.stringify(Array.from({ length: 100 }, (_, index) => pr(index + 1))));
      if (url.includes("&page=2")) return new Response(JSON.stringify([pr(101)]));
      throw new Error(`unexpected request ${url}`);
    }));
    const numbers: number[] = [];
    const controller = new AbortController();
    try {
      source.start({
        type: "github.pr.schedule", signal: controller.signal,
        subscriptions: [{ type: "github.pr.schedule", workflowId: "merge.md", repository: "owner/repo", config }],
        emit: async (event) => {
          numbers.push((event.data as GitHubEventData).number!);
          return { version: 1, eventId: event.id, status: "accepted" };
        },
      });
      await vi.advanceTimersByTimeAsync(3_600_000);
      expect(numbers).toEqual(Array.from({ length: 101 }, (_, index) => index + 1));
    } finally { controller.abort(); source.stop?.(); vi.useRealTimers(); }
  });
});
const context = {
  run, event: { id: "event", type: "github.issue.comment", source: "github", timestamp: "now", repository: "owner/repo", data } as Event,
  repository: "owner/repo", logger, policy: { max: 1, maxReplyChars: 20_000, maxFiles: 100, maxPatchBytes: 10_000, allowedPaths: [], protectedPaths: [".git"] },
  activation: { data }, artifact: artifact(revision), verification: [{ command: "pnpm", args: ["test"], exitCode: 0, stdout: "", stderr: "", passed: true }],
  communication: { version: 1 as const, language: "English", messages: [
    { purpose: "reply" as const, body: "Applied the focused fix and verified it.", references: [] },
    { purpose: "review" as const, body: "Please add a regression test for the failing path.", references: [] },
    { purpose: "change" as const, subject: "Fix review feedback", body: "The failing path now validates its input before use.", references: [] },
    { purpose: "status" as const, body: "I couldn't safely apply the change to the current branch.", references: [] },
  ] },
};

describe("GitHub repository event polling", () => {
  const cursorKey = "events:owner/repo:cursor";
  const ok = (value: unknown) => new Response(JSON.stringify(value), { status: 200 });

  it.each([5 * 60_000, 2 * 60 * 60_000])("delivers manual issue replies with %i ms remaining on the self-event guard", async (remaining) => {
    const state = new Map<string, unknown>([
      [cursorKey, "0"],
      ["self:active-run:owner/repo:issue:42", new Date(Date.now() + remaining).toISOString()],
    ]);
    const comment = repositoryComment("1");
    comment.actor.login = "maintainer";
    comment.payload.comment.user.login = "maintainer";
    comment.payload.comment.body = 'issue-reply: The hook is included. I tested sendEvent("goBack").';
    const emitted: Event[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/events?")) return ok([comment, { id: "0", type: "IssuesEvent" }]);
      if (url.endsWith("/user")) return ok({ login: "maintainer", id: 1 });
      throw new Error(`unexpected request ${url}`);
    }));
    const poller = await startPoller(state, async (event) => {
      emitted.push(event);
      return { version: 1, eventId: event.id, status: "accepted" };
    });
    try {
      await vi.waitFor(() => expect(state.get(cursorKey)).toBe("1"));
      expect(emitted.map((event) => ({ id: event.id, data: event.data }))).toEqual([
        expect.objectContaining({ id: "github:owner/repo:1", data: expect.objectContaining({
          author: "maintainer", body: 'issue-reply: The hook is included. I tested sendEvent("goBack").',
        }) }),
      ]);
    } finally { poller.stop(); }
  });

  it("replays available events oldest-first when the cursor is missing instead of discarding the batch", async () => {
    const state = new Map<string, unknown>([[cursorKey, "expired"]]);
    const emitted: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/events?")) return ok([repositoryComment("3"), repositoryComment("2"), repositoryComment("1")]);
      if (url.endsWith("/user")) return ok({ login: "maintainer", id: 1 });
      throw new Error(`unexpected request ${url}`);
    }));
    const poller = await startPoller(state, async (event) => {
      emitted.push(event.id);
      expect(state.get(cursorKey)).toBe(emitted.length === 1 ? "expired" : String(emitted.length - 1));
      return { version: 1, eventId: event.id, status: "accepted" };
    });
    try {
      await vi.waitFor(() => expect(state.get(cursorKey)).toBe("3"));
      expect(emitted).toEqual(["github:owner/repo:1", "github:owner/repo:2", "github:owner/repo:3"]);
      expect(state.get("events:owner/repo:gap")).toMatchObject({ cursor: "expired", oldestAvailable: "1", newestAvailable: "3" });
      expect(poller.reportHealth).toHaveBeenCalledWith(expect.objectContaining({ status: "degraded", result: "success", reason: "github_event_history_gap" }));
    } finally { poller.stop(); }

    const restarted = await startPoller(state, async (event) => {
      emitted.push(event.id);
      return { version: 1, eventId: event.id, status: "accepted" };
    });
    try {
      await vi.waitFor(() => expect(restarted.reportHealth).toHaveBeenCalledWith(expect.objectContaining({ status: "degraded", result: "success", reason: "github_event_history_gap" })));
      expect(emitted).toHaveLength(3);
    } finally { restarted.stop(); }
  });

  it("acknowledges a historical gap without changing the cursor and reports new gaps separately", async () => {
    vi.useFakeTimers();
    const state = new Map<string, unknown>([[cursorKey, "expired"]]);
    let events = [repositoryComment("3"), repositoryComment("2"), repositoryComment("1")];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/events?")) return ok(events);
      if (url.endsWith("/user")) return ok({ login: "maintainer", id: 1 });
      throw new Error(`unexpected request ${url}`);
    }));
    const poller = await startPoller(state, async () => true);
    const output = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await vi.waitFor(() => expect(state.get(cursorKey)).toBe("3"));
      const command = poller.commands.get("github")!;
      await command.run(["gaps", "--json"]);
      const gaps = JSON.parse(String(output.mock.calls.at(-1)?.[0]));
      expect(gaps).toEqual([expect.objectContaining({ repository: "owner/repo", cursor: "expired", acknowledgedAt: null, detectedAt: expect.any(String) })]);
      const id = gaps[0].id;
      await command.run(["gaps", "acknowledge", "--id", id, "--reason", "Reviewed affected PRs"]);
      expect(state.get(cursorKey)).toBe("3");
      await command.run(["gaps", "--json"]);
      expect(JSON.parse(String(output.mock.calls.at(-1)?.[0]))).toEqual([expect.objectContaining({ id, acknowledgmentReason: "Reviewed affected PRs", acknowledgedAt: expect.any(String) })]);
      await vi.advanceTimersByTimeAsync(300_000);
      expect(poller.reportHealth).toHaveBeenLastCalledWith(expect.objectContaining({ status: "ready", result: "success" }));
      events = [repositoryComment("4")];
      await vi.advanceTimersByTimeAsync(300_000);
      expect(poller.reportHealth).toHaveBeenLastCalledWith(expect.objectContaining({ status: "degraded", result: "success", reason: "github_event_history_gap" }));
      await command.run(["gaps", "--json"]);
      expect(JSON.parse(String(output.mock.calls.at(-1)?.[0]))).toEqual([
        expect.objectContaining({ id, cursor: "expired", acknowledgedAt: expect.any(String) }),
        expect.objectContaining({ cursor: "3", acknowledgedAt: null }),
      ]);
      expect(state.get(cursorKey)).toBe("4");
    } finally { poller.stop(); output.mockRestore(); vi.useRealTimers(); }
  });

  it("retains legacy gap acknowledgments across restart and still reports actual polling failures", async () => {
    vi.useFakeTimers();
    const legacy = { cursor: "expired", oldestAvailable: "1", newestAvailable: "3" };
    const state = new Map<string, unknown>([[cursorKey, "3"], ["events:owner/repo:gap", legacy]]);
    let fail = false;
    vi.stubGlobal("fetch", vi.fn(async () => fail ? new Response("No access", { status: 401 }) : ok([{ id: "3", type: "Unsupported" }])));
    const output = vi.spyOn(console, "log").mockImplementation(() => {});
    const poller = await startPoller(state, async () => true);
    let restarted: Awaited<ReturnType<typeof startPoller>> | undefined;
    try {
      await vi.waitFor(() => expect(poller.reportHealth).toHaveBeenCalled());
      const command = poller.commands.get("github")!;
      await command.run(["gaps", "--json"]);
      const gaps = JSON.parse(String(output.mock.calls.at(-1)?.[0]));
      expect(gaps).toEqual([expect.objectContaining({ repository: "owner/repo", cursor: "expired", detectedAt: null, acknowledgedAt: null })]);
      const id = gaps[0].id;
      const before = [...state];
      await expect(command.run(["gaps", "acknowledge", "--id", "0".repeat(64), "--reason", "Review"])).rejects.toThrow("Unknown GitHub event history gap");
      await expect(command.run(["gaps", "acknowledge", "--id", id, "--reason", " "])).rejects.toThrow();
      expect([...state]).toEqual(before);
      await command.run(["gaps", "acknowledge", "--id", id, "--reason", "Reviewed legacy history"]);
      await command.run(["gaps", "--json"]);
      const acknowledged = JSON.parse(String(output.mock.calls.at(-1)?.[0]));
      await vi.advanceTimersByTimeAsync(1_000);
      await command.run(["gaps", "acknowledge", "--id", id, "--reason", "Duplicate acknowledgment"]);
      await command.run(["gaps", "--json"]);
      expect(JSON.parse(String(output.mock.calls.at(-1)?.[0]))).toEqual(acknowledged);
      expect(state.get(cursorKey)).toBe("3");
      expect(state.get("events:owner/repo:gap")).toEqual(legacy);
      poller.stop();
      restarted = await startPoller(state, async () => true);
      await vi.waitFor(() => expect(restarted?.reportHealth).toHaveBeenLastCalledWith(expect.objectContaining({ status: "ready", result: "success" })));
      fail = true;
      await vi.advanceTimersByTimeAsync(300_000);
      expect(restarted.reportHealth).toHaveBeenLastCalledWith(expect.objectContaining({ status: "degraded", result: "failure", reason: "github_poll_failed" }));
      expect(state.get(cursorKey)).toBe("3");
      fail = false;
      await vi.advanceTimersByTimeAsync(300_000);
      expect(restarted.reportHealth).toHaveBeenLastCalledWith(expect.objectContaining({ status: "ready", result: "success" }));
    } finally { poller.stop(); restarted?.stop(); output.mockRestore(); vi.useRealTimers(); }
  });

  it("preserves the first gap detection time when replay delivery is retried", async () => {
    vi.useFakeTimers();
    const state = new Map<string, unknown>([[cursorKey, "expired"]]);
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/events?")) return ok([repositoryComment("1")]);
      if (url.endsWith("/user")) return ok({ login: "maintainer", id: 1 });
      throw new Error(`unexpected request ${url}`);
    }));
    const poller = await startPoller(state, async () => false);
    const output = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await vi.waitFor(() => expect(poller.reportHealth).toHaveBeenCalled());
      const command = poller.commands.get("github")!;
      await command.run(["gaps", "--json"]);
      const first = JSON.parse(String(output.mock.calls.at(-1)?.[0]));
      expect(first).toEqual([expect.objectContaining({ cursor: "expired", detectedAt: expect.any(String) })]);
      await vi.advanceTimersByTimeAsync(300_000);
      await command.run(["gaps", "--json"]);
      expect(JSON.parse(String(output.mock.calls.at(-1)?.[0]))).toEqual(first);
      expect(state.get(cursorKey)).toBe("expired");
      expect(poller.reportHealth).toHaveBeenLastCalledWith(expect.objectContaining({ result: "failure", reason: "github_poll_failed" }));
    } finally { poller.stop(); output.mockRestore(); vi.useRealTimers(); }
  });

  it("skips only a deleted review comment, then delivers and checkpoints the following event", async () => {
    const state = new Map<string, unknown>([[cursorKey, "0"]]);
    const emitted: string[] = [];
    const bad = { id: "1", type: "PullRequestReviewCommentEvent", actor: { login: "reviewer" }, payload: {
      action: "created", pull_request: { number: 42 }, comment: { id: 900, body: "Deleted", user: { login: "reviewer" } },
    } };
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/events?")) return ok([repositoryComment("2"), bad, { id: "0", type: "IssuesEvent" }]);
      if (url.endsWith("/pulls/42")) return ok({ number: 42, state: "open", head: { sha: revision, ref: "feature", repo: { full_name: "owner/repo" } }, base: { sha: revision, ref: "main", repo: { full_name: "owner/repo" } } });
      if (url.endsWith("/pulls/comments/900")) return new Response('{"message":"Not Found"}', { status: 404 });
      if (url.endsWith("/user")) return ok({ login: "maintainer", id: 1 });
      throw new Error(`unexpected request ${url}`);
    }));
    const poller = await startPoller(state, async (event) => { emitted.push(event.id); return { version: 1, eventId: event.id, status: "accepted" }; });
    try {
      await vi.waitFor(() => expect(state.get(cursorKey)).toBe("2"));
      expect(emitted).toEqual(["github:owner/repo:2"]);
      expect(poller.warn).toHaveBeenCalledWith(expect.objectContaining({ eventId: "1", commentId: 900 }), expect.stringContaining("missing review comment"));
      expect(state.get("events:owner/repo:skipped:1")).toMatchObject({ reason: "missing_review_comment", commentId: 900 });
      expect(poller.error).not.toHaveBeenCalledWith(expect.anything(), "GitHub poll failed");
    } finally { poller.stop(); }
  });

  it.each([
    { name: "deleted parent", commentStatus: 404, skipped: true },
    { name: "inaccessible parent", commentStatus: 403, skipped: false },
  ])("handles a $name review comment without losing later events", async ({ commentStatus, skipped }) => {
    const state = new Map<string, unknown>([[cursorKey, "0"]]);
    const emitted: string[] = [];
    const reply = { id: "1", type: "PullRequestReviewCommentEvent", actor: { login: "reviewer" }, payload: {
      action: "created", pull_request: { number: 42 }, comment: { id: 901, body: "Reply", user: { login: "reviewer" } },
    } };
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/events?")) return ok([repositoryComment("2"), reply, { id: "0", type: "IssuesEvent" }]);
      if (url.endsWith("/pulls/42")) return ok({ number: 42, state: "open", head: { sha: revision, ref: "feature", repo: { full_name: "owner/repo" } }, base: { sha: revision, ref: "main", repo: { full_name: "owner/repo" } } });
      if (url.endsWith("/pulls/comments/901")) return ok({ id: 901, in_reply_to_id: 900 });
      if (url.endsWith("/pulls/comments/900")) return new Response('{"message":"unavailable"}', { status: commentStatus });
      if (url.endsWith("/user")) return ok({ login: "maintainer", id: 1 });
      throw new Error(`unexpected request ${url}`);
    }));
    const poller = await startPoller(state, async (event) => { emitted.push(event.id); return { version: 1, eventId: event.id, status: "accepted" }; });
    try {
      if (skipped) {
        await vi.waitFor(() => expect(state.get(cursorKey)).toBe("2"));
        expect(state.get("events:owner/repo:skipped:1")).toMatchObject({ commentId: 900 });
        expect(emitted).toEqual(["github:owner/repo:2"]);
      } else {
        await vi.waitFor(() => expect(poller.error).toHaveBeenCalledWith(expect.anything(), "GitHub poll failed"));
        expect(state.get(cursorKey)).toBe("0");
        expect(emitted).toEqual([]);
      }
    } finally { poller.stop(); }
  });

  it("keeps the last successful checkpoint when a later event is rejected, then resumes on restart", async () => {
    const state = new Map<string, unknown>([[cursorKey, "0"]]);
    const emitted: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/events?")) return ok([repositoryComment("2"), repositoryComment("1"), { id: "0", type: "IssuesEvent" }]);
      if (url.endsWith("/user")) return ok({ login: "maintainer", id: 1 });
      throw new Error(`unexpected request ${url}`);
    }));
    const first = await startPoller(state, async (event) => {
      emitted.push(event.id);
      return { version: 1, eventId: event.id, status: event.id.endsWith(":2") ? "rejected" : "accepted" };
    });
    try {
      await vi.waitFor(() => expect(first.error).toHaveBeenCalledWith(expect.objectContaining({ repository: "owner/repo" }), "GitHub poll failed"));
      expect(state.get(cursorKey)).toBe("1");
      expect(emitted).toEqual(["github:owner/repo:1", "github:owner/repo:2"]);
    } finally { first.stop(); }

    emitted.length = 0;
    const second = await startPoller(state, async (event) => {
      emitted.push(event.id);
      return { version: 1, eventId: event.id, status: "accepted" };
    });
    try {
      await vi.waitFor(() => expect(state.get(cursorKey)).toBe("2"));
      expect(emitted).toEqual(["github:owner/repo:2"]);
    } finally { second.stop(); }
  });

  it("does not acknowledge later events after the source stops mid-batch", async () => {
    const state = new Map<string, unknown>([[cursorKey, "0"]]);
    const emitted: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/events?")) return ok([repositoryComment("2"), repositoryComment("1"), { id: "0", type: "IssuesEvent" }]);
      if (url.endsWith("/user")) return ok({ login: "maintainer", id: 1 });
      throw new Error(`unexpected request ${url}`);
    }));
    let stop: (() => void) | undefined;
    const poller = await startPoller(state, async (event) => {
      emitted.push(event.id);
      stop?.();
      return { version: 1, eventId: event.id, status: "accepted" };
    });
    stop = poller.stop;
    await vi.waitFor(() => expect(state.get(cursorKey)).toBe("1"));
    expect(emitted).toEqual(["github:owner/repo:1"]);
    poller.stop();
  });
});

describe("GitHub authentication", () => {
  it("rejects the obsolete writerToken alias with migration guidance", async () => {
    const api = {
      config: { get: () => ({ writerToken: "old-token" }) },
    } as unknown as MixerAutomationsAPI;
    await expect(github.setup!(api)).rejects.toThrow("extensions.github.writerToken is no longer supported; use extensions.github.token");
  });

  it("rejects invalid failure report configuration", async () => {
    const api = {
      config: { get: () => ({ token: "test-token", failureReports: { enabled: "no" } }) },
      inputs: { register() {} }, workflows: { registerField() {}, registerRunner() {} },
    } as unknown as MixerAutomationsAPI;
    await expect(github.setup!(api)).rejects.toThrow();
  });

  it("prefers an explicitly configured token", async () => {
    const process = { run: vi.fn() };
    await expect(resolveGitHubToken({ process } as unknown as Pick<MixerAutomationsAPI, "process">, "configured-token")).resolves.toBe("configured-token");
    expect(process.run).not.toHaveBeenCalled();
  });

  it("falls back to the authenticated GitHub CLI", async () => {
    const process = { run: vi.fn().mockResolvedValue({ exitCode: 0, stdout: "cli-token\n", stderr: "" }) };
    await expect(resolveGitHubToken({ process } as unknown as Pick<MixerAutomationsAPI, "process">)).resolves.toBe("cli-token");
    expect(process.run).toHaveBeenCalledWith({ command: "gh", args: ["auth", "token"], timeout: 30_000 });
  });

  it("reports missing and unauthenticated GitHub CLI installations", async () => {
    const missing = { run: vi.fn().mockRejectedValue(Object.assign(new Error("spawn gh ENOENT"), { code: "ENOENT" })) };
    await expect(resolveGitHubToken({ process: missing } as unknown as Pick<MixerAutomationsAPI, "process">)).rejects.toThrow("install GitHub CLI");
    const missingResult = { run: vi.fn().mockResolvedValue({ exitCode: 1, stdout: "", stderr: "", errorCode: "ENOENT" }) };
    await expect(resolveGitHubToken({ process: missingResult } as unknown as Pick<MixerAutomationsAPI, "process">)).rejects.toThrow("install GitHub CLI");
    const unauthenticated = { run: vi.fn().mockResolvedValue({ exitCode: 1, stdout: "", stderr: "not logged in" }) };
    await expect(resolveGitHubToken({ process: unauthenticated } as unknown as Pick<MixerAutomationsAPI, "process">)).rejects.toThrow("run 'gh auth login'");
  });
});

describe("GitHub check routing", () => {
  it("hydrates live PR author and draft state before matching a check workflow", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/user")) return new Response(JSON.stringify({ id: 1, login: "maintainer" }), { status: 200 });
      if (url.endsWith("/pulls/42")) return new Response(JSON.stringify({
        number: 42, state: "open", draft: false, merged: false,
        user: { id: 9, login: "dependabot[bot]" },
        head: { sha: revision, ref: "dependabot/npm/update", repo: { id: 2, full_name: "owner/repo" } },
        base: { sha: "b".repeat(40), ref: "main", repo: { id: 2, full_name: "owner/repo" } },
      }), { status: 200 });
      throw new Error(`unexpected request ${url}`);
    }));
    const source = (await setupSources()).get("github.check")!;
    const matched = await source.match!({
      id: "check-event", type: "github.check", source: "github", timestamp: "now", repository: "owner/repo",
      data: { action: "completed", number: 42, isPullRequest: true, checkConclusion: "success", headSha: revision },
    }, {
      events: ["completed"],
      where: { all: [{ "pull-request": true }, { "pull-request-author": "dependabot[bot]" }, { "check-conclusion": "success" }, { draft: false }] },
    });
    expect(matched).toBe(true);
  });

  it("preserves issue-comment author and body when activating live issue state", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/user")) return new Response(JSON.stringify({ id: 1, login: "maintainer" }), { status: 200 });
      if (url.endsWith("/issues/42")) return new Response(JSON.stringify({
        number: 42, title: "Issue title", body: "Issue body", state: "open",
        user: { id: 2, login: "maintainer" }, labels: [{ name: "automation" }],
      }), { status: 200 });
      if (url.endsWith("/repos/owner/repo")) return new Response(JSON.stringify({ default_branch: "main" }), { status: 200 });
      if (url.endsWith("/commits/main")) return new Response(JSON.stringify({ sha: revision }), { status: 200 });
      throw new Error(`unexpected request ${url}`);
    }));
    const source = (await setupSources()).get("github.issue.comment")!;
    const event = {
      id: "comment-event", type: "github.issue.comment", source: "github", timestamp: "now", repository: "owner/repo",
      actor: { id: "3", name: "reviewer" },
      data: {
        action: "created", number: 42, isPullRequest: false, author: "reviewer", actor: "reviewer",
        authorAssociation: "MEMBER", body: "@maintainer please try again", labels: ["automation"],
      },
    } as Event;
    const activated = await source.activate!(event);
    expect(activated.data).toMatchObject({
      title: "Issue title", body: "@maintainer please try again", author: "reviewer",
      actor: "reviewer", authorAssociation: "MEMBER", state: "open", labels: ["automation"],
    });
    await expect(source.match!({ ...event, data: activated.data }, {
      events: ["created"],
      where: { all: [{ mentioned: "me" }, { not: { author: "me" } }] },
    })).resolves.toBe(true);
  });
});

describe("GitHub review author routing", () => {
  const bot = "copilot-pull-request-reviewer[bot]";
  const pullRequest = {
    number: 42, state: "open", draft: false, merged: false,
    user: { login: "maintainer" }, labels: [{ name: "mcalcagno:auto-pr" }],
    head: { sha: revision, ref: "feature/fix", repo: { full_name: "owner/repo" } },
    base: { sha: revision, ref: "main", repo: { full_name: "owner/repo" } },
  };
  const review = {
    id: 77, node_id: "PRR_77", state: "COMMENTED", body: "Please reject whitespace-only input.",
    user: { id: 175728472, login: bot }, author_association: "NONE",
    html_url: "https://github.com/owner/repo/pull/42#pullrequestreview-77",
  };
  const event: Event = {
    id: "review-event", type: "github.pr.review", source: "github", timestamp: "now", repository: "owner/repo",
    actor: { id: "175728472", name: "Copilot" },
    data: {
      action: "created", number: 42, isPullRequest: true, author: "Copilot", actor: "Copilot",
      pullRequestAuthor: "maintainer", draft: false, state: "open", merged: false,
      labels: ["mcalcagno:auto-pr"], reviewId: 77, reviewState: "commented",
    },
  };
  const copilotTrigger = { events: ["created"], where: { all: [
    { author: bot }, { "pull-request-author": "me" }, { draft: false },
    { labels: { any: ["mcalcagno:auto-pr"] } }, { "review-state": ["commented", "changes_requested"] },
  ] } };
  const feedbackTrigger = { events: ["created"], where: { all: [
    { "pull-request-author": "me" }, { not: { author: "me" } }, { not: { author: bot } },
  ] } };
  const ok = (value: unknown) => new Response(JSON.stringify(value));
  function stubReview(value: unknown = review) {
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/user")) return ok({ login: "maintainer", id: 1 });
      if (url.endsWith("/pulls/42")) return ok(pullRequest);
      if (url.endsWith("/reviews/77")) return ok(value);
      if (url.endsWith("/reviews/77/comments?per_page=100")) return ok([]);
      throw new Error(`unexpected request ${url}`);
    }));
  }

  it("reconciles the same draft review using live readiness and labels", async () => {
    let draft = true;
    let currentLabels: Array<{ name: string }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/user")) return ok({ login: "maintainer", id: 1 });
      if (url.endsWith("/pulls/42")) return ok({ ...pullRequest, draft, labels: currentLabels });
      if (url.endsWith("/reviews/77")) return ok(review);
      throw new Error(`unexpected request ${url}`);
    }));
    const source = (await setupSources()).get("github.pr.review")!;
    const trigger = { ...copilotTrigger, reconcile: true };
    expect(await source.match!(event, trigger)).toEqual({ kind: "defer", resourceKey: "owner/repo:pr:42",
      reason: "resource_conditions", retryAfter: 30_000, expiresAfter: 604_800_000 });
    draft = false;
    expect(await source.match!(event, trigger)).toMatchObject({ kind: "defer" });
    currentLabels = [{ name: "mcalcagno:auto-pr" }];
    expect(await source.match!(event, trigger)).toBe(true);
    // Removing the label must override the historical event's labels too.
    currentLabels = [];
    expect(await source.match!(event, trigger)).toMatchObject({ kind: "defer" });
  });

  it("shares a resource fetch within a reconciliation batch but refreshes the next batch", async () => {
    let reads = 0;
    let draft = true;
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/user")) return ok({ login: "maintainer", id: 1 });
      if (url.endsWith("/pulls/42")) { reads++; return ok({ ...pullRequest, draft }); }
      if (url.endsWith("/reviews/77")) return ok(review);
      throw new Error(`unexpected request ${url}`);
    }));
    const source = (await setupSources()).get("github.pr.review")!;
    const trigger = { ...copilotTrigger, reconcile: true };
    const operation = { signal: new AbortController().signal, batchId: "batch-1" };
    expect(await source.match!(event, trigger, operation)).toMatchObject({ kind: "defer" });
    draft = false;
    expect(await source.match!({ ...event, id: "another-review" }, trigger, operation)).toMatchObject({ kind: "defer" });
    expect(reads).toBe(1);
    expect(await source.match!(event, trigger, { ...operation, batchId: "batch-2" })).toBe(true);
    expect(reads).toBe(2);
    draft = true;
    expect(await source.match!(event, trigger, { signal: operation.signal })).toMatchObject({ kind: "defer" });
    expect(reads).toBe(3);
  });

  it.each(["numeric ID", "persisted URL"])("routes a historical Copilot review by its canonical author using its %s", async (identity) => {
    stubReview();
    const source = (await setupSources()).get("github.pr.review")!;
    const candidate = identity === "numeric ID" ? event : {
      ...event, data: { ...event.data as GitHubEventData, reviewId: undefined, review: { url: review.html_url } },
    };
    await expect(source.match!(candidate, copilotTrigger)).resolves.toBe(true);
    await expect(source.match!(candidate, feedbackTrigger)).resolves.toBe(false);
  });

  it("emits the canonical review author before polling routes the event", async () => {
    const state = new Map<string, unknown>([["events:owner/repo:cursor", "0"]]);
    const emitted: Event[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/events?")) return ok([
        { id: "1", type: "PullRequestReviewEvent", actor: { id: 175728472, login: "Copilot" }, payload: {
          action: "submitted", pull_request: { number: 42 }, review: { ...review, user: { login: "Copilot" } },
        } },
        { id: "0", type: "IssuesEvent" },
      ]);
      if (url.endsWith("/pulls/42")) return ok(pullRequest);
      if (url.endsWith("/reviews/77")) return ok(review);
      if (url.endsWith("/user")) return ok({ login: "maintainer", id: 1 });
      throw new Error(`unexpected request ${url}`);
    }));
    const poller = await startPoller(state, async (item) => {
      emitted.push(item);
      return { version: 1, eventId: item.id, status: "accepted" };
    });
    try {
      await vi.waitFor(() => expect(state.get("events:owner/repo:cursor")).toBe("1"));
      expect(emitted).toHaveLength(1);
      expect(emitted[0]?.data).toMatchObject({ author: bot, reviewId: 77, reviewState: "COMMENTED" });
    } finally { poller.stop(); }
  });

  it("retains the verified author and review content during activation", async () => {
    stubReview();
    const source = (await setupSources()).get("github.pr.review")!;
    const activated = await source.activate!(event);
    expect(activated.data).toMatchObject({
      author: bot, body: review.body, authorAssociation: "NONE", reviewId: 77,
      reviewNodeId: "PRR_77", reviewState: "COMMENTED", reviewComments: [],
      review: { body: review.body, state: "COMMENTED", url: review.html_url },
    });
    expect(event.data).toMatchObject({ author: "Copilot", reviewState: "commented" });
  });

  it.each([
    { name: "missing author", value: { ...review, user: {} } },
    { name: "different review", value: { ...review, id: 88 } },
  ])("does not route using the unverified event author when GitHub returns a $name", async ({ value }) => {
    stubReview(value);
    const source = (await setupSources()).get("github.pr.review")!;
    await expect(source.match!(event, feedbackTrigger)).rejects.toThrow("GitHub triggering review identity");
  });
});

describe("GitHub approval and merge Safe Actions", () => {
  const prepared = {
    repository: "owner/repo", number: 42, author: "dependabot[bot]", headRepository: "owner/repo", headBranch: "feature/fix", headSha: revision,
  };
  const livePullRequest = (overrides: Record<string, unknown> = {}) => ({
    number: 42, state: "open", draft: false, merged: false, mergeable: true, mergeable_state: "clean", node_id: "PR_node",
    user: { id: 9, login: "dependabot[bot]" }, head: { sha: revision, ref: "feature/fix", repo: { full_name: "owner/repo" } },
    ...overrides,
  });
  const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

  it.each(["github.pr.approve", "github.pr.merge", "github.pr.review", "github.pr-comment.resolve", "github.issue.resolve"])("rejects forged manual activation for %s before contacting GitHub", async (name) => {
    const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
    const definition = setupAction(name);
    await expect(definition.prepare({ ...context, event: { ...context.event, type: "manual", source: "cli" } }, { version: 1, decision: "merge" })).rejects.toThrow("github_action_requires_activation");
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("rejects cross-repository action targets before contacting GitHub", async () => {
    const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
    const definition = setupAction("github.pr.merge");
    await expect(definition.prepare({ ...context, activation: { data: { ...data, baseRepository: "owner/other" } } }, { version: 1, decision: "merge" })).rejects.toThrow("github_action_repository_mismatch");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("binds approval to the activated PR author and unchanged live head", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response(livePullRequest())));
    const action = setupAction("github.pr.approve");
    const approved = await action.prepare!({
      ...context,
      activation: { data: { ...data, pullRequestAuthor: "dependabot[bot]" } },
      policy: { max: 1, allowedAuthors: ["dependabot[bot]"] },
    }, { version: 1, decision: "approve" });
    expect(approved).toEqual(prepared);
    await expect(action.prepare!({
      ...context,
      activation: { data: { ...data, pullRequestAuthor: "untrusted-user" } },
      policy: { max: 1, allowedAuthors: ["dependabot[bot]"] },
    }, { version: 1, decision: "approve" })).rejects.toThrow("pr_action_author_not_allowed");
  });

  it("approves and immediately merges only after all observed checks pass", async () => {
    const calls: Array<{ method: string; url: string; body?: unknown }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (url.endsWith("/user")) return response({ id: 1, login: "maintainer" });
      if (url.endsWith("/reviews?per_page=100") && method === "GET") return response([]);
      if (url.endsWith("/reviews") && method === "POST") return response({ id: 7 }, 201);
      if (url.includes("/check-runs")) return response({ total_count: 1, check_runs: [{ name: "test", status: "completed", conclusion: "success" }] });
      if (url.includes("/status?")) return response({ total_count: 0, statuses: [] });
      if (url.endsWith("/merge") && method === "PUT") return response({ merged: true, sha: "b".repeat(40) });
      if (url.endsWith("/pulls/42")) return response(livePullRequest());
      throw new Error(`unexpected request ${method} ${url}`);
    }));
    const action = setupAction("github.pr.merge");
    const result = await action.executePrepared!({
      ...context,
      policy: { max: 1, allowedAuthors: ["dependabot[bot]"], method: "squash", mode: "immediate", approve: true, minimumChecks: 1 },
    }, prepared);
    expect(result).toMatchObject({ merged: true, number: 42, headSha: revision });
    expect(calls).toEqual(expect.arrayContaining([
      expect.objectContaining({ method: "POST", url: expect.stringContaining("/pulls/42/reviews") }),
      expect.objectContaining({ method: "PUT", url: expect.stringContaining("/pulls/42/merge"), body: { sha: revision, merge_method: "squash" } }),
    ]));
  });

  it("rejects a changed head before approval or merge", async () => {
    const fetch = vi.fn(async () => response(livePullRequest({ head: { sha: "c".repeat(40), ref: "feature/fix", repo: { full_name: "owner/repo" } } })));
    vi.stubGlobal("fetch", fetch);
    const action = setupAction("github.pr.merge");
    await expect(action.executePrepared!({
      ...context,
      policy: { max: 1, allowedAuthors: ["dependabot[bot]"], method: "squash", mode: "immediate", approve: true, minimumChecks: 1 },
    }, prepared)).rejects.toThrow("pr_action_head_changed");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("approves and merges the exact head published by the same run", async () => {
    const stateDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "roboplane-pr-action-"));
    temporary.push(stateDirectory);
    const published = "b".repeat(40);
    writeRunCapability(stateDirectory, {
      version: 1, runId: run.id, repository: "owner/repo", mode: "allowed-pr", remote: "https://github.com/owner/repo.git",
      baseRevision: "d".repeat(40), baseBranch: "main", maxChangedFiles: 100, prNumber: 42, prAuthor: "dependabot[bot]",
      allowedBranch: "feature/fix", activatedRemoteSha: revision, expectedRemoteSha: published, confirmedAt: "now",
      published: { branch: "feature/fix", previousHead: revision, head: published, confirmedAt: "now" },
      publicationChain: [revision, published],
    });
    const calls: Array<{ method: string; url: string; body?: unknown }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (url.endsWith("/user")) return response({ id: 1, login: "maintainer" });
      if (url.endsWith("/reviews?per_page=100") && method === "GET") return response([]);
      if (url.endsWith("/reviews") && method === "POST") return response({ id: 7 }, 201);
      if (url.includes(`/commits/${published}/check-runs`)) return response({ total_count: 1, check_runs: [{ name: "test", status: "completed", conclusion: "success" }] });
      if (url.includes(`/commits/${published}/status?`)) return response({ total_count: 0, statuses: [] });
      if (url.endsWith("/merge") && method === "PUT") return response({ merged: true, sha: "e".repeat(40) });
      if (url.endsWith("/pulls/42")) return response(livePullRequest({ head: { sha: published, ref: "feature/fix", repo: { full_name: "owner/repo" } } }));
      throw new Error(`unexpected request ${method} ${url}`);
    }));
    const action = setupAction("github.pr.merge", stateDirectory);
    const currentContext = {
      ...context,
      activation: { data: { ...data, pullRequestAuthor: "dependabot[bot]" } },
      policy: { max: 1, allowedAuthors: ["dependabot[bot]"], method: "squash", mode: "immediate", approve: true, minimumChecks: 1 },
    };
    const publishedPrepared = await action.prepare!(currentContext, { version: 1, decision: "merge" });
    expect(publishedPrepared).toEqual({ ...prepared, headSha: published });
    await expect(action.executePrepared!(currentContext, publishedPrepared)).resolves.toMatchObject({ merged: true, headSha: published });
    expect(calls).toEqual(expect.arrayContaining([
      expect.objectContaining({ url: expect.stringContaining(`/commits/${published}/check-runs`) }),
      expect.objectContaining({ method: "POST", body: expect.objectContaining({ commit_id: published }) }),
      expect.objectContaining({ method: "PUT", body: { sha: published, merge_method: "squash" } }),
    ]));
  });

  it("rejects an externally advanced head after a confirmed same-run publication", async () => {
    const stateDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "roboplane-pr-action-stale-"));
    temporary.push(stateDirectory);
    const published = "b".repeat(40);
    writeRunCapability(stateDirectory, {
      version: 1, runId: run.id, repository: "owner/repo", mode: "allowed-pr", remote: "https://github.com/owner/repo.git",
      baseRevision: "d".repeat(40), baseBranch: "main", maxChangedFiles: 100, prNumber: 42, prAuthor: "dependabot[bot]",
      allowedBranch: "feature/fix", activatedRemoteSha: revision, expectedRemoteSha: published, confirmedAt: "now",
      published: { branch: "feature/fix", previousHead: revision, head: published, confirmedAt: "now" },
      publicationChain: [revision, published],
    });
    vi.stubGlobal("fetch", vi.fn(async () => response(livePullRequest({
      head: { sha: "c".repeat(40), ref: "feature/fix", repo: { full_name: "owner/repo" } },
    }))));
    const action = setupAction("github.pr.merge", stateDirectory);
    await expect(action.prepare!({
      ...context,
      activation: { data: { ...data, pullRequestAuthor: "dependabot[bot]" } },
      policy: { max: 1, allowedAuthors: ["dependabot[bot]"], method: "squash", mode: "immediate", approve: false, minimumChecks: 1 },
    }, { version: 1, decision: "merge" })).rejects.toThrow("pr_action_head_changed");
  });

  it("rejects a branch or head-repository change even when the SHA matches", async () => {
    const action = setupAction("github.pr.merge");
    for (const head of [
      { sha: revision, ref: "feature/other", repo: { full_name: "owner/repo" } },
      { sha: revision, ref: "feature/fix", repo: { full_name: "attacker/fork" } },
    ]) {
      vi.stubGlobal("fetch", vi.fn(async () => response(livePullRequest({ head }))));
      await expect(action.prepare!({
        ...context,
        activation: { data: { ...data, pullRequestAuthor: "dependabot[bot]" } },
        policy: { max: 1, allowedAuthors: ["dependabot[bot]"], method: "squash", mode: "immediate", approve: false, minimumChecks: 1 },
      }, { version: 1, decision: "merge" })).rejects.toThrow("pr_action_head_changed");
    }
  });

  it("revalidates a same-run published head immediately before auto-merge", async () => {
    const published = "b".repeat(40);
    const advanced = "c".repeat(40);
    let liveReads = 0;
    const mutations: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (method === "POST" || method === "PUT") mutations.push(`${method} ${url}`);
      if (url.includes("/check-runs")) return response({ total_count: 1, check_runs: [{ name: "test", status: "in_progress", conclusion: null }] });
      if (url.includes("/status?")) return response({ total_count: 0, statuses: [] });
      if (url.endsWith("/pulls/42")) {
        liveReads++;
        return response(livePullRequest({ head: { sha: liveReads === 1 ? published : advanced, ref: "feature/fix", repo: { full_name: "owner/repo" } } }));
      }
      throw new Error(`unexpected request ${method} ${url}`);
    }));
    const action = setupAction("github.pr.merge");
    await expect(action.executePrepared!({
      ...context,
      policy: { max: 1, allowedAuthors: ["dependabot[bot]"], method: "squash", mode: "auto", approve: false, minimumChecks: 1 },
    }, { ...prepared, headSha: published })).rejects.toThrow("pr_action_head_changed");
    expect(mutations).toEqual([]);
  });

  it("does not approve or merge in immediate mode while a check is pending", async () => {
    const mutations: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (method === "POST" || method === "PUT") mutations.push(`${method} ${url}`);
      if (url.includes("/check-runs")) return response({ total_count: 1, check_runs: [{ name: "test", status: "in_progress", conclusion: null }] });
      if (url.includes("/status?")) return response({ total_count: 0, statuses: [] });
      if (url.endsWith("/pulls/42")) return response(livePullRequest({ mergeable_state: "blocked" }));
      throw new Error(`unexpected request ${method} ${url}`);
    }));
    const action = setupAction("github.pr.merge");
    await expect(action.executePrepared!({
      ...context,
      policy: { max: 1, allowedAuthors: ["dependabot[bot]"], method: "squash", mode: "immediate", approve: true, minimumChecks: 1 },
    }, prepared)).rejects.toThrow("pr_merge_checks_not_passed");
    expect(mutations).toEqual([]);
  });

  it("enables auto-merge when checks are still pending", async () => {
    const calls: Array<{ method: string; url: string }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      calls.push({ method, url });
      if (url.includes("/check-runs")) return response({ total_count: 1, check_runs: [{ name: "test", status: "in_progress", conclusion: null }] });
      if (url.includes("/status?")) return response({ total_count: 0, statuses: [] });
      if (url.endsWith("/pulls/42")) return response(livePullRequest({ mergeable_state: "blocked" }));
      if (url.endsWith("/graphql") && method === "POST") return response({ data: { enablePullRequestAutoMerge: { pullRequest: { autoMergeRequest: { enabledAt: "now" } } } } });
      throw new Error(`unexpected request ${method} ${url}`);
    }));
    const action = setupAction("github.pr.merge");
    await expect(action.executePrepared!({
      ...context,
      policy: { max: 1, allowedAuthors: ["dependabot[bot]"], method: "squash", mode: "auto", approve: false, minimumChecks: 1 },
    }, prepared)).resolves.toMatchObject({ autoMerge: true, number: 42 });
    expect(calls).toContainEqual({ method: "POST", url: "https://api.github.com/graphql" });
  });
});

describe("GitHub PR comment resolution", () => {
  it("recovers historical review IDs from persisted review URLs", () => {
    expect(persistedReviewId({ review: { url: "https://github.com/owner/repo/pull/42#pullrequestreview-5074996283" } })).toBe(5074996283);
    expect(persistedReviewId({ reviewId: 77, review: { url: "https://github.com/owner/repo/pull/42#pullrequestreview-88" } })).toBe(77);
  });

  it("exposes only bound resolution actions", () => {
    expect([...setupActions().keys()]).toEqual(["github.pr-comment.resolve", "github.pr.resolve", "github.pr.review", "github.pr.approve", "github.pr.merge", "github.repository.resolve", "github.issue.open", "github.issue.resolve"]);
  });

  it("does not allow the agent to select a target and prepares a verified push", async () => {
    const definition = setupAction();
    expect(definition.schema.safeParse({ decision: "reply", body: "unvalidated prose", repository: "attacker/repo" }).success).toBe(false);
    const prepared = await definition.prepare!(context, { version: 1, decision: "fix", fix: { commitMessage: "Fix review feedback" } });
    expect(prepared).toMatchObject({ mode: "push", headRepository: "owner/repo", headRef: "feature/fix", expectedHead: revision, body: "Applied the focused fix and verified it." });
  });

  it("turns fork fixes and failed verification into reply-only resolutions", async () => {
    const definition = setupAction();
    const forked = await definition.prepare!({ ...context, activation: { data: { ...data, fork: true } } }, { version: 1, decision: "fix", fix: { commitMessage: "Do not push" } });
    expect(forked).toMatchObject({ mode: "reply", reason: "fork_push_denied" });
    const unverified = await definition.prepare!({ ...context, verification: [{ ...context.verification[0]!, passed: false }] }, { version: 1, decision: "fix", fix: { commitMessage: "No push" } });
    expect(unverified).toMatchObject({ mode: "reply", reason: "verification_failed_or_unavailable" });
  });

  it("posts review replies through the PR-scoped GitHub endpoint", async () => {
    const requests: Array<{ method: string; url: string }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      requests.push({ method, url });
      return new Response(method === "GET" ? "[]" : "{}", { status: method === "GET" ? 200 : 201 });
    }));
    const definition = setupAction();
    const reviewData = { ...data, commentId: 55, commentKind: "review" as const };
    const reviewContext = {
      ...context,
      event: { ...context.event, type: "github.pr.comment", data: reviewData },
      activation: { data: reviewData },
    };
    const prepared = await definition.prepare!(reviewContext, { version: 1, decision: "reply" });
    await definition.executePrepared!(reviewContext, prepared);
    expect(requests).toEqual([
      { method: "GET", url: "https://api.github.com/repos/owner/repo/pulls/42/comments?per_page=100" },
      { method: "POST", url: "https://api.github.com/repos/owner/repo/pulls/42/comments/55/replies" },
    ]);
  });

  it("prepares an issue fix against the activated default branch", async () => {
    const definition = setupAction("github.issue.resolve");
    const issueContext = {
      ...context,
      event: { ...context.event, type: "github.issue", data: { ...data, isPullRequest: false, defaultBranch: "main", defaultSha: revision, baseSha: revision } },
      activation: { data: { ...data, isPullRequest: false, defaultBranch: "main", defaultSha: revision, baseSha: revision } },
      policy: { ...context.policy, draft: true },
    };
    const prepared = await definition.prepare!(issueContext, {
      version: 1, decision: "fix", fix: { commitMessage: "Fix issue" },
    });
    expect(prepared).toMatchObject({ mode: "create-pr", baseRef: "main", expectedHead: revision, pullRequestTitle: "Fix review feedback" });
  });

  it("supports bounded issue triage without exposing a target", async () => {
    const definition = setupAction("github.issue.resolve");
    const issueContext = {
      ...context,
      event: { ...context.event, type: "github.issue", data: { ...data, isPullRequest: false, state: "open", number: 8 } },
      activation: { data: { ...data, isPullRequest: false, state: "open", number: 8 } },
      policy: { ...context.policy, draft: true, allowClose: false },
    };
    const prepared = await definition.prepare!(issueContext, {
      version: 1, decision: "triage",
      triage: { labels: ["bug", "needs-repro"] },
    });
    expect(prepared).toMatchObject({ mode: "triage", repository: "owner/repo", number: 8, labels: ["bug", "needs-repro"] });
  });

  it("prepares a real pull-request review and gates approvals", async () => {
    const definition = setupAction("github.pr.review");
    await expect(definition.prepare!(context, { version: 1, event: "APPROVE" })).rejects.toThrow("approval_not_allowed");
    const prepared = await definition.prepare!({ ...context, policy: { ...context.policy, allowApproval: true } }, {
      version: 1, event: "REQUEST_CHANGES",
    });
    expect(prepared).toMatchObject({ repository: "owner/repo", number: 42, event: "REQUEST_CHANGES", body: "Please add a regression test for the failing path." });
  });

  it("prepares a repository-bound deduplicated issue from the core report message", async () => {
    const definition = setupAction("github.issue.open");
    expect(definition.schema.safeParse({ version: 1, decision: "open", key: "dependency-health", title: "Agent title" }).success).toBe(false);
    const reportContext = {
      ...context,
      policy: { max: 1, maxTitleChars: 160, maxBodyChars: 12_000 },
      communication: { version: 1 as const, language: "English", messages: [{
        purpose: "report" as const,
        subject: "Dependency lockfile is stale",
        body: "The lockfile no longer matches the declared dependency range. Refreshing it would restore reproducible installs.",
        references: [],
      }] },
    };
    const first = await definition.prepare!(reportContext, { version: 1, decision: "open", key: "dependency-health" });
    const second = await definition.prepare!(reportContext, { version: 1, decision: "open", key: "dependency-health" });
    expect(first).toMatchObject({ repository: "owner/repo", title: "Dependency lockfile is stale", key: "dependency-health" });
    expect((first as { marker: string }).marker).toBe((second as { marker: string }).marker);
  });
});

describe("GitHub publication guard", () => {
  it("claims one new branch, rejects base and unrelated branches, and records successful publication", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "roboplane-publish-guard-"));
    temporary.push(root);
    const repository = path.join(root, "repo");
    const remote = path.join(root, "remote.git");
    const state = path.join(root, "state");
    fs.mkdirSync(repository);
    execFileSync("git", ["init", "--bare", remote]);
    execFileSync("git", ["init", "-b", "main", repository]);
    git(repository, "config", "user.name", "test");
    git(repository, "config", "user.email", "test@example.com");
    fs.writeFileSync(path.join(repository, "base.txt"), "base\n");
    git(repository, "add", ".");
    git(repository, "commit", "-m", "base");
    const baseRevision = git(repository, "rev-parse", "HEAD");
    git(repository, "remote", "add", "origin", remote);
    git(repository, "push", "origin", "main");
    git(repository, "switch", "-c", "company/ISSUE-8");
    const workspace: Workspace = { path: repository };
    installPublishGuard({
      workspace, stateDirectory: state, capability: {
        version: 1, runId: "rp_guard", repository: "owner/repo", mode: "new-branch", remote,
        baseRevision, baseBranch: "main", maxChangedFiles: 1,
      },
    });
    fs.writeFileSync(path.join(repository, "change.txt"), "uncommitted\n");
    const guardedGit = path.join(repository, ".git", "roboplane-guard", "bin", process.platform === "win32" ? "git.cmd" : "git");
    const dirty = spawnSync(guardedGit, ["push", "origin", "company/ISSUE-8"], { cwd: repository, env: { ...process.env, ...workspace.environment }, encoding: "utf8" });
    expect(dirty.status).toBe(73);
    expect(dirty.stderr).toContain("requires a clean checkout");
    git(repository, "add", "change.txt");
    git(repository, "commit", "-m", "focused change");
    const pushed = spawnSync(guardedGit, ["push", "-u", "origin", "company/ISSUE-8"], { cwd: repository, env: { ...process.env, ...workspace.environment }, encoding: "utf8" });
    expect(pushed.status, pushed.stderr).toBe(0);
    const head = git(repository, "rev-parse", "HEAD");
    expect(fs.existsSync(path.join(state, "github-published-heads", "owner--repo", `${head}.json`))).toBe(true);
    expect(hasPublishedHeadMarker(state, "owner/repo", head)).toBe(true);
    expect(hasPublishedHeadMarker(state, "owner/repo", head)).toBe(true);

    git(repository, "switch", "main");
    fs.writeFileSync(path.join(repository, "main-only.txt"), "unsafe\n");
    git(repository, "add", "main-only.txt");
    git(repository, "commit", "-m", "must not publish");
    const basePush = spawnSync(guardedGit, ["push", "origin", "main"], { cwd: repository, env: { ...process.env, ...workspace.environment }, encoding: "utf8" });
    expect(basePush.status).toBe(73);
    expect(basePush.stderr).toContain("protected base branch main");

    git(repository, "switch", "company/ISSUE-8");
    git(repository, "switch", "-c", "company/OTHER-9");
    const otherPush = spawnSync(guardedGit, ["push", "origin", "company/OTHER-9"], { cwd: repository, env: { ...process.env, ...workspace.environment }, encoding: "utf8" });
    expect(otherPush.status).toBe(73);
    expect(otherPush.stderr).toContain("permits only branch company/ISSUE-8");
  }, 15_000);

  it("allows any changed-file count when the publication limit is disabled", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "roboplane-publish-unlimited-"));
    temporary.push(root);
    const repository = path.join(root, "repo");
    const remote = path.join(root, "remote.git");
    const state = path.join(root, "state");
    fs.mkdirSync(repository);
    execFileSync("git", ["init", "--bare", remote]);
    execFileSync("git", ["init", "-b", "main", repository]);
    git(repository, "config", "user.name", "test");
    git(repository, "config", "user.email", "test@example.com");
    fs.writeFileSync(path.join(repository, "base.txt"), "base\n");
    git(repository, "add", ".");
    git(repository, "commit", "-m", "base");
    const baseRevision = git(repository, "rev-parse", "HEAD");
    git(repository, "remote", "add", "origin", remote);
    git(repository, "push", "origin", "main");
    git(repository, "switch", "-c", "company/ISSUE-9");
    for (let index = 0; index < 101; index++) {
      fs.writeFileSync(path.join(repository, `change-${index}.txt`), `${index}\n`);
    }
    git(repository, "add", ".");
    git(repository, "commit", "-m", "large focused change");
    const workspace: Workspace = { path: repository };
    installPublishGuard({
      workspace, stateDirectory: state, capability: {
        version: 1, runId: "rp_unlimited", repository: "owner/repo", mode: "new-branch", remote,
        baseRevision, baseBranch: "main", maxChangedFiles: null,
      },
    });
    const guardedGit = path.join(repository, ".git", "roboplane-guard", "bin", process.platform === "win32" ? "git.cmd" : "git");
    const pushed = spawnSync(guardedGit, ["push", "-u", "origin", "company/ISSUE-9"], {
      cwd: repository, env: { ...process.env, ...workspace.environment }, encoding: "utf8",
    });
    expect(pushed.status, pushed.stderr).toBe(0);
  }, 15_000);

  it("makes third-party PR runs commitless and always rejects merges", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "roboplane-review-guard-"));
    temporary.push(root);
    const repository = path.join(root, "repo");
    const remote = path.join(root, "remote.git");
    const state = path.join(root, "state");
    fs.mkdirSync(repository);
    execFileSync("git", ["init", "--bare", remote]);
    execFileSync("git", ["init", "-b", "review", repository]);
    git(repository, "config", "user.name", "test");
    git(repository, "config", "user.email", "test@example.com");
    fs.writeFileSync(path.join(repository, "base.txt"), "base\n");
    git(repository, "add", ".");
    git(repository, "commit", "-m", "base");
    const revision = git(repository, "rev-parse", "HEAD");
    git(repository, "remote", "add", "origin", remote);
    const workspace: Workspace = { path: repository };
    installPublishGuard({ workspace, stateDirectory: state, capability: {
      version: 1, runId: "rp_review", repository: "owner/repo", mode: "review-only", remote,
      baseRevision: revision, baseBranch: "main", maxChangedFiles: 10, case: { kind: "pr", number: 42 },
      prNumber: 42, prAuthor: "contributor",
    } });
    const env = { ...process.env, ...workspace.environment };
    const guardedGit = path.join(repository, ".git", "roboplane-guard", "bin", process.platform === "win32" ? "git.cmd" : "git");
    const guardedGh = path.join(repository, ".git", "roboplane-guard", "bin", process.platform === "win32" ? "gh.cmd" : "gh");
    const commit = spawnSync(guardedGit, ["commit", "--allow-empty", "-m", "unsafe"], { cwd: repository, env, encoding: "utf8" });
    expect(commit.status).toBe(73);
    expect(commit.stderr).toContain("workflow cannot update");
    const merge = spawnSync(guardedGh, ["pr", "merge", "42"], { cwd: repository, env, encoding: "utf8" });
    expect(merge.status).toBe(73);
    expect(merge.stderr).toContain("never permits autonomous pull-request merges");
  }, 15_000);

  it("allows only marker-bound replies to activated review comments", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "roboplane-review-replies-"));
    temporary.push(root);
    const repository = path.join(root, "repo");
    const remote = path.join(root, "remote.git");
    const state = path.join(root, "state");
    fs.mkdirSync(repository);
    execFileSync("git", ["init", "--bare", remote]);
    execFileSync("git", ["init", "-b", "main", repository]);
    git(repository, "config", "user.name", "test");
    git(repository, "config", "user.email", "test@example.com");
    fs.writeFileSync(path.join(repository, "base.txt"), "base\n");
    git(repository, "add", ".");
    git(repository, "commit", "-m", "base");
    const baseRevision = git(repository, "rev-parse", "HEAD");
    git(repository, "remote", "add", "origin", remote);
    const workspace: Workspace = { path: repository };
    installPublishGuard({ workspace, stateDirectory: state, capability: {
      version: 1, runId: "rp_review", repository: "owner/repo", mode: "owned-pr", remote,
      baseRevision, baseBranch: "main", maxChangedFiles: 10, case: { kind: "pr", number: 42 },
      prNumber: 42, prAuthor: "maintainer", allowedReviewCommentIds: [55],
    } });
    const realBin = path.join(root, "real-bin");
    fs.mkdirSync(realBin);
    fs.writeFileSync(path.join(realBin, "gh"), "#!/bin/sh\ncase \"$*\" in *comments?per_page=100*) printf '[]' ;; esac\n", { mode: 0o700 });
    workspace.environment!.MIXER_AUTOMATIONS_REAL_PATH = `${realBin}${path.delimiter}${process.env.PATH ?? ""}`;
    const guardedGh = path.join(repository, ".git", "roboplane-guard", "bin", process.platform === "win32" ? "gh.cmd" : "gh");
    const env = { ...process.env, ...workspace.environment };
    const allowed = spawnSync(guardedGh, ["api", "--method", "POST", "repos/owner/repo/pulls/42/comments/55/replies", "-f", "body=Applied. <!-- roboplane:rp_review:reply:55 -->"], {
      cwd: repository, env, encoding: "utf8",
    });
    expect(allowed.status, allowed.stderr).toBe(0);
    const wrongPullRequest = spawnSync(guardedGh, ["api", "--method", "POST", "repos/owner/repo/pulls/43/comments/55/replies", "-f", "body=Applied. <!-- roboplane:rp_review:reply:55 -->"], { cwd: repository, env, encoding: "utf8" });
    expect(wrongPullRequest.status).toBe(73);
    const legacyEndpoint = spawnSync(guardedGh, ["api", "--method", "POST", "repos/owner/repo/pulls/comments/55/replies", "-f", "body=Applied. <!-- roboplane:rp_review:reply:55 -->"], { cwd: repository, env, encoding: "utf8" });
    expect(legacyEndpoint.status).toBe(73);
    const wrongComment = spawnSync(guardedGh, ["api", "--method", "POST", "repos/owner/repo/pulls/42/comments/56/replies", "-f", "body=Applied. <!-- roboplane:rp_review:reply:56 -->"], { cwd: repository, env, encoding: "utf8" });
    expect(wrongComment.status).toBe(73);
    const missingMarker = spawnSync(guardedGh, ["api", "--method", "POST", "repos/owner/repo/pulls/42/comments/55/replies", "-f", "body=Applied."], { cwd: repository, env, encoding: "utf8" });
    expect(missingMarker.status).toBe(73);
  }, 15_000);

  it("updates only the exact PAT-authored PR branch with an observed-head lease", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "roboplane-owned-pr-"));
    temporary.push(root);
    const repository = path.join(root, "repo");
    const remote = path.join(root, "remote.git");
    const state = path.join(root, "state");
    fs.mkdirSync(repository);
    execFileSync("git", ["init", "--bare", remote]);
    execFileSync("git", ["init", "-b", "main", repository]);
    git(repository, "config", "user.name", "test");
    git(repository, "config", "user.email", "test@example.com");
    fs.writeFileSync(path.join(repository, "base.txt"), "base\n");
    git(repository, "add", ".");
    git(repository, "commit", "-m", "base");
    const baseRevision = git(repository, "rev-parse", "HEAD");
    git(repository, "remote", "add", "origin", remote);
    git(repository, "push", "origin", "main");
    git(repository, "switch", "-c", "company/PR-42");
    fs.writeFileSync(path.join(repository, "pr.txt"), "initial\n");
    git(repository, "add", "pr.txt");
    git(repository, "commit", "-m", "initial PR");
    git(repository, "push", "origin", "company/PR-42");
    const observed = git(repository, "rev-parse", "HEAD");
    const workspace: Workspace = { path: repository };
    installPublishGuard({ workspace, stateDirectory: state, capability: {
      version: 1, runId: "rp_owned", repository: "owner/repo", mode: "owned-pr", remote,
      baseRevision, baseBranch: "main", maxChangedFiles: 10, case: { kind: "pr", number: 42 },
      allowedBranch: "company/PR-42", expectedRemoteSha: observed, prNumber: 42, prAuthor: "maintainer",
    } });
    fs.writeFileSync(path.join(repository, "pr.txt"), "updated\n");
    git(repository, "add", "pr.txt");
    git(repository, "commit", "-m", "address review");
    const guardedGit = path.join(repository, ".git", "roboplane-guard", "bin", process.platform === "win32" ? "git.cmd" : "git");
    const env = { ...process.env, ...workspace.environment };
    const pushed = spawnSync(guardedGit, ["push", "origin", "company/PR-42"], { cwd: repository, env, encoding: "utf8" });
    expect(pushed.status, pushed.stderr).toBe(0);
    const published = git(repository, "rev-parse", "HEAD");
    expect(execFileSync("git", ["--git-dir", remote, "rev-parse", "refs/heads/company/PR-42"], { encoding: "utf8" }).trim()).toBe(published);
    expect(readRunCapability(state, "rp_owned")).toMatchObject({
      activatedRemoteSha: observed,
      expectedRemoteSha: published,
      published: { branch: "company/PR-42", previousHead: observed, head: published },
      publicationChain: [observed, published],
    });

    fs.writeFileSync(path.join(repository, "pr.txt"), "second update\n");
    git(repository, "add", "pr.txt");
    git(repository, "commit", "-m", "second review update");
    execFileSync("git", ["--git-dir", remote, "update-ref", "refs/heads/company/PR-42", baseRevision]);
    const stale = spawnSync(guardedGit, ["push", "origin", "company/PR-42"], { cwd: repository, env, encoding: "utf8" });
    expect(stale.status).toBe(73);
    expect(stale.stderr).toContain("stale or unrelated remote branch");
  }, 15_000);

  it("updates only the exact allowlisted author PR branch with an observed-head lease", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "roboplane-allowed-pr-"));
    temporary.push(root);
    const repository = path.join(root, "repo");
    const remote = path.join(root, "remote.git");
    const state = path.join(root, "state");
    fs.mkdirSync(repository);
    execFileSync("git", ["init", "--bare", remote]);
    execFileSync("git", ["init", "-b", "main", repository]);
    git(repository, "config", "user.name", "test");
    git(repository, "config", "user.email", "test@example.com");
    fs.writeFileSync(path.join(repository, "base.txt"), "base\n");
    git(repository, "add", ".");
    git(repository, "commit", "-m", "base");
    const baseRevision = git(repository, "rev-parse", "HEAD");
    git(repository, "remote", "add", "origin", remote);
    git(repository, "push", "origin", "main");
    git(repository, "switch", "-c", "dependabot/npm/example");
    fs.writeFileSync(path.join(repository, "package-lock.json"), "initial\n");
    git(repository, "add", "package-lock.json");
    git(repository, "commit", "-m", "dependency update");
    git(repository, "push", "origin", "dependabot/npm/example");
    const observed = git(repository, "rev-parse", "HEAD");
    const workspace: Workspace = { path: repository };
    installPublishGuard({ workspace, stateDirectory: state, capability: {
      version: 1, runId: "rp_allowed", repository: "owner/repo", mode: "allowed-pr", remote,
      baseRevision, baseBranch: "main", maxChangedFiles: 10, case: { kind: "pr", number: 42 },
      allowedBranch: "dependabot/npm/example", expectedRemoteSha: observed, prNumber: 42, prAuthor: "dependabot[bot]",
    } });
    fs.writeFileSync(path.join(repository, "package-lock.json"), "repaired\n");
    git(repository, "add", "package-lock.json");
    git(repository, "commit", "-m", "fix peer dependencies");
    const guardedGit = path.join(repository, ".git", "roboplane-guard", "bin", process.platform === "win32" ? "git.cmd" : "git");
    const pushed = spawnSync(guardedGit, ["push", "origin", "dependabot/npm/example"], {
      cwd: repository, env: { ...process.env, ...workspace.environment }, encoding: "utf8",
    });
    expect(pushed.status, pushed.stderr).toBe(0);
    const firstPublished = git(repository, "rev-parse", "HEAD");
    fs.writeFileSync(path.join(repository, "package-lock.json"), "second repair\n");
    git(repository, "add", "package-lock.json");
    git(repository, "commit", "-m", "finish peer dependency repair");
    const secondPush = spawnSync(guardedGit, ["push", "origin", "dependabot/npm/example"], {
      cwd: repository, env: { ...process.env, ...workspace.environment }, encoding: "utf8",
    });
    expect(secondPush.status, secondPush.stderr).toBe(0);
    const published = git(repository, "rev-parse", "HEAD");
    expect(execFileSync("git", ["--git-dir", remote, "rev-parse", "refs/heads/dependabot/npm/example"], { encoding: "utf8" }).trim()).toBe(published);
    expect(readRunCapability(state, "rp_allowed")).toMatchObject({
      activatedRemoteSha: observed,
      expectedRemoteSha: published,
      published: { branch: "dependabot/npm/example", previousHead: firstPublished, head: published },
      publicationChain: [observed, firstPublished, published],
    });
  }, 15_000);

  it("derives write authority only from a live same-repository PAT-authored PR", () => {
    const owned = { pullRequestAuthor: "Maintainer", headRepository: "owner/repo", state: "open", merged: false } as GitHubEventData;
    expect(pullRequestPublicationMode(owned, "maintainer", "owner/repo")).toBe("owned-pr");
    expect(pullRequestPublicationMode({ ...owned, pullRequestAuthor: "contributor" }, "maintainer", "owner/repo")).toBe("review-only");
    expect(pullRequestPublicationMode({ ...owned, headRepository: "maintainer/fork" }, "maintainer", "owner/repo")).toBe("review-only");
    expect(pullRequestPublicationMode({ ...owned, state: "closed" }, "maintainer", "owner/repo")).toBe("review-only");
    const policy = { branchUpdates: { allowedAuthors: ["dependabot[bot]", "vacationing-maintainer"] } };
    expect(pullRequestPublicationMode({ ...owned, pullRequestAuthor: "Dependabot[bot]" }, "maintainer", "owner/repo", policy)).toBe("allowed-pr");
    expect(pullRequestPublicationMode({ ...owned, pullRequestAuthor: "Vacationing-Maintainer" }, "maintainer", "owner/repo", policy)).toBe("allowed-pr");
    expect(pullRequestPublicationMode({ ...owned, pullRequestAuthor: "renovate[bot]" }, "maintainer", "owner/repo", policy)).toBe("review-only");
    expect(pullRequestPublicationMode({ ...owned, pullRequestAuthor: "dependabot[bot]", headRepository: "fork/repo" }, "maintainer", "owner/repo", policy)).toBe("review-only");
  });
});

describe("GitHub workflow failure issues", () => {
  it("builds a detailed report without exposing common credentials", () => {
    const issue = buildWorkflowFailureIssue({
      repository: "owner/repo", workflowName: "Issue intake", workflowId: "maintainer/issue-intake.md",
      runId: "rp_failure", event: { ...context.event, data: { number: 42 } }, attempt: 2,
      createdAt: "2026-08-29T08:00:00.000Z", updatedAt: "2026-08-29T08:01:00.000Z",
      error: "Request failed with Bearer github_pat_abcdefghijklmnopqrst and API_TOKEN=secret-value",
    });
    expect(issue.title).toBe("Mixer Automations workflow failed: Issue intake");
    expect(issue.body).toContain("Repository: `owner/repo`");
    expect(issue.body).toContain("Trigger: `github.issue.comment #42`");
    expect(issue.body).toContain("mixer-automations automations inspect rp_failure");
    expect(issue.body).toContain(issue.marker);
    expect(issue.body).not.toContain("abcdefghijklmnopqrst");
    expect(issue.body).not.toContain("secret-value");
  });

  it("creates the issue only in the failed run repository", async () => {
    const hooks = new Map<HookName, (context: HookContext) => void | Promise<void>>();
    const stored = new Map<string, unknown>();
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "GET") {
        expect(url).toContain("https://api.github.com/repos/owner/repo/issues?state=all");
        return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
      }
      expect(url).toBe("https://api.github.com/repos/owner/repo/issues");
      expect(init?.method).toBe("POST");
      const body = JSON.parse(String(init?.body)) as { title: string; body: string };
      expect(body.title).toContain("Issue intake");
      expect(body.body).toContain("Run: `rp_failed`");
      return new Response(JSON.stringify({ number: 77, html_url: "https://github.com/owner/repo/issues/77" }), {
        status: 201, headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const api = {
      config: { get: () => ({ token: "test-token" }) },
      state: { namespace: () => ({
        get: (key: string) => stored.get(key), set: (key: string, value: unknown) => { stored.set(key, value); }, delete: (key: string) => { stored.delete(key); },
      }) },
      inputs: { register() {} }, events: { registerSource() {} }, workflows: { registerField() {}, registerRunner() {} }, commands: { register() {} }, actions: { register() {} },
      hooks: { on(name: HookName, handler: (context: HookContext) => void | Promise<void>) { hooks.set(name, handler); } },
      paths: { home: "/tmp/roboplane-github-tests", state: "/tmp/roboplane-github-tests/state", cases: "/tmp/roboplane-github-tests/.roboplane/cases" },
      logger,
    } as unknown as MixerAutomationsAPI;
    github.setup!(api);
    const failedRun: Run = {
      ...run, id: "rp_failed", event: context.event, status: "failed",
      createdAt: "2026-08-29T08:00:00.000Z", updatedAt: "2026-08-29T08:01:00.000Z",
    };
    await hooks.get("run:finalized")!({
      run: failedRun, event: context.event, workflow: workflow(["owner/repo", "owner/other"]), instructions: [],
      metadata: { status: "failed", attempt: 1, error: "agent exited 1" },
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(stored.get("workflow-failure:rp_failed")).toBe("https://github.com/owner/repo/issues/77");
  });

  it("does not create failure issues for any configured repository when globally disabled", async () => {
    const hooks = new Map<HookName, (context: HookContext) => void | Promise<void>>();
    const fetchMock = vi.fn();
    const error = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const api = {
      config: { get: () => ({ token: "test-token", failureReports: { enabled: false } }) },
      state: { namespace: () => ({ get: () => undefined, set() {}, delete() {} }) },
      inputs: { register() {} }, events: { registerSource() {} }, workflows: { registerField() {}, registerRunner() {} }, commands: { register() {} }, actions: { register() {} },
      hooks: { on(name: HookName, handler: (context: HookContext) => void | Promise<void>) { hooks.set(name, handler); } },
      paths: { home: "/tmp/roboplane-github-tests", state: "/tmp/roboplane-github-tests/state", cases: "/tmp/roboplane-github-tests/.roboplane/cases" },
      logger: { ...logger, error },
    } as unknown as MixerAutomationsAPI;
    await github.setup!(api);
    const repositories = ["owner/one", "owner/two"];
    for (const [index, repository] of repositories.entries()) {
      await hooks.get("run:finalized")!({
        run: { ...run, id: `rp_disabled_${index}`, repository, status: "failed" },
        event: { ...context.event, repository }, workflow: workflow(repositories), instructions: [],
        metadata: { status: "failed", error: "workspace creation failed" },
      });
    }
    expect(fetchMock).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it("does not report retries or allow a repository mismatch", async () => {
    const hooks = new Map<HookName, (context: HookContext) => void | Promise<void>>();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const api = {
      config: { get: () => ({ token: "test-token" }) },
      state: { namespace: () => ({ get: () => undefined, set() {}, delete() {} }) },
      inputs: { register() {} }, events: { registerSource() {} }, workflows: { registerField() {}, registerRunner() {} }, commands: { register() {} }, actions: { register() {} },
      hooks: { on(name: HookName, handler: (context: HookContext) => void | Promise<void>) { hooks.set(name, handler); } },
      paths: { home: "/tmp/roboplane-github-tests", state: "/tmp/roboplane-github-tests/state", cases: "/tmp/roboplane-github-tests/.roboplane/cases" }, logger,
    } as unknown as MixerAutomationsAPI;
    github.setup!(api);
    await hooks.get("run:finalized")!({ run: { ...run, status: "queued" }, workflow: workflow(), instructions: [], metadata: {} });
    await hooks.get("run:finalized")!({ run: { ...run, status: "failed" }, workflow: workflow("other/repo"), instructions: [], metadata: {} });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
