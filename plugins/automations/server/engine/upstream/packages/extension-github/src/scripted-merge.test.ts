import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Event, Logger, MixerAutomationsAPI, Run, SafeActionPrepareContext, Workflow } from "@mixer/automations-sdk";
import { Registry, StateDatabase, ensureHome, resolvePaths } from "../../core/src/index.js";
import github from "./index.js";

const directories: string[] = [];
afterEach(() => { vi.unstubAllGlobals(); for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });
const logger: Logger = { debug() {}, info() {}, warn() {}, error() {}, child() { return logger; } };
const head = "a".repeat(40); const base = "b".repeat(40);

async function fixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "roboplane-scripted-merge-")); directories.push(home);
  const paths = resolvePaths(home); ensureHome(paths); const database = new StateDatabase(paths.state);
  const registry = new Registry(); registry.setOwner("github");
  const state = { head, base, labels: [] as Array<{ name: string }>, approved: true, quality: "success", behind: 0, rules: [] as unknown[], merged: false };
  const mutations: Array<{ method: string; body: unknown }> = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, options: RequestInit) => {
    const endpoint = new URL(url).pathname;
    if (options.method === "PUT" && endpoint.endsWith("/merge")) {
      mutations.push({ method: "PUT", body: JSON.parse(String(options.body)) }); state.merged = true;
      return Response.json({ merged: true, sha: "c".repeat(40) });
    }
    if (options.method !== "GET") throw new Error(`Unexpected mutation: ${options.method} ${url}`);
    if (endpoint.endsWith("/pulls/42")) return Response.json({ number: 42, state: state.merged ? "closed" : "open", merged: state.merged, draft: false, user: { login: "dependabot[bot]" }, labels: state.labels,
      head: { sha: state.head, ref: "dependabot/update", repo: { full_name: "owner/repo" } }, base: { sha: state.base, ref: "develop", repo: { full_name: "owner/repo" } }, mergeable: true, mergeable_state: "clean" });
    if (endpoint.endsWith("/check-runs")) return Response.json({ total_count: 1, check_runs: [{ id: 1, name: "SonarCloud Code Analysis", head_sha: state.head, status: "completed", conclusion: state.quality }] });
    if (endpoint.endsWith("/statuses")) return Response.json([]);
    if (endpoint.endsWith("/status")) return Response.json({ total_count: 0, statuses: [] });
    if (endpoint.endsWith("/reviews")) return Response.json(state.approved ? [{ id: 1, state: "APPROVED", commit_id: state.head, user: { login: "reviewer" } }] : []);
    if (endpoint.includes("/rules/branches/")) return Response.json(state.rules);
    if (endpoint.endsWith("/branches/develop")) return Response.json({ protected: false });
    if (endpoint.includes("/compare/")) return Response.json({ ahead_by: state.behind });
    throw new Error(`Unexpected request: ${url}`);
  }));
  const api: MixerAutomationsAPI = { events: registry.events, workflows: registry.workflows, actions: registry.actions, agents: registry.agents,
    inputs: { register() {}, validate() {}, async submit() { throw new Error("Not used"); } },
    workspaces: registry.workspaces, executions: registry.executions, commands: registry.commands, hooks: registry.hooks,
    config: { get: () => ({ token: "test-token", failureReports: { enabled: false } }), historyRetentionMs: () => 86_400_000 }, state: { namespace: () => database.state("github") },
    logger, paths, process: { async run() { throw new Error("Unexpected process execution"); } } };
  await github.setup(api);
  const event = { id: "pr", type: "github.pull-request", source: "github", repository: "owner/repo", timestamp: new Date().toISOString(), data: {
    number: 42, isPullRequest: true, state: "open", merged: false, draft: false, pullRequestAuthor: "dependabot[bot]", baseRepository: "owner/repo",
    headSha: head, headRepository: "owner/repo", headBranch: "dependabot/update", baseSha: base, baseBranch: "develop",
  } } satisfies Event;
  const run: Run = { id: "run", workflowId: "merge.yaml", repository: "owner/repo", event, status: "running", createdAt: event.timestamp, updatedAt: event.timestamp };
  const workflow: Workflow = { id: "merge.yaml", path: "/merge.yaml", name: "merge", repository: "owner/repo", on: {}, agent: "", execution: "host", safeActions: {}, prompt: "", task: { kind: "steps", runner: "steps", configuration: {} } };
  const context: SafeActionPrepareContext = { run, event, activation: { data: event.data }, repository: "owner/repo", logger, workflow, policy: {
    max: 1, allowedAuthors: ["dependabot[bot]"], method: "squash", mode: "immediate", approve: false, minimumChecks: 1, mergeCheck: {},
  } };
  const action = registry.actionDefinitions.get("github.pr.merge"); if (!action) throw new Error("Missing merge action");
  return { state, mutations, context, action, close: () => database.close() };
}

describe("scripted GitHub merge authorization", () => {
  it("merges an approved passing PR using the exact prepared SHA without an agent", async () => {
    const f = await fixture();
    try {
      const prepared = await f.action.prepare(f.context, { version: 1, decision: "merge" });
      expect(f.mutations).toEqual([]);
      expect(await f.action.executePrepared(f.context, prepared)).toMatchObject({ merged: true, headSha: head });
      expect(f.mutations).toEqual([{ method: "PUT", body: { sha: head, merge_method: "squash" } }]);
    } finally { f.close(); }
  });
  it.each(["approval", "quality", "ignore", "base", "head", "behind", "rules", "method", "cancelled", "deadline"])("rejects changed %s evidence before merging", async kind => {
    const f = await fixture();
    try {
      const prepared = await f.action.prepare(f.context, { version: 1, decision: "merge" });
      if (kind === "approval") f.state.approved = false;
      if (kind === "quality") f.state.quality = "failure";
      if (kind === "ignore") f.state.labels = [{ name: "roboplane-ignore" }];
      if (kind === "base") f.state.base = "d".repeat(40);
      if (kind === "head") f.state.head = "d".repeat(40);
      if (kind === "behind") f.state.behind = 1;
      if (kind === "rules") f.state.rules = [{ type: "merge_queue" }];
      if (kind === "method") f.state.rules = [{ type: "pull_request", parameters: { required_approving_review_count: 1, require_code_owner_review: false, require_last_push_approval: false, allowed_merge_methods: ["merge"] } }];
      if (kind === "cancelled") f.context.signal = AbortSignal.abort(new Error("cancelled"));
      if (kind === "deadline") f.context.deadline = new Date(Date.now() - 1000).toISOString();
      await expect(f.action.executePrepared(f.context, prepared)).rejects.toThrow();
      expect(f.mutations).toEqual([]);
    } finally { f.close(); }
  });
  it("reconciles a completed merge without another mutation even after the deadline", async () => {
    const f = await fixture();
    try {
      const prepared = await f.action.prepare(f.context, { version: 1, decision: "merge" });
      f.state.merged = true; f.context.deadline = new Date(Date.now() - 1000).toISOString();
      expect(await f.action.executePrepared(f.context, prepared)).toMatchObject({ merged: true, deduplicated: true });
      expect(f.mutations).toEqual([]);
    } finally { f.close(); }
  });
  it("requires an explicit eligibility policy for scripted merges", async () => {
    const f = await fixture();
    try {
      delete f.context.policy.mergeCheck;
      await expect(f.action.prepare(f.context, { version: 1, decision: "merge" })).rejects.toThrow("scripted_merge_requires_merge_check");
      expect(f.mutations).toEqual([]);
    } finally { f.close(); }
  });
});
