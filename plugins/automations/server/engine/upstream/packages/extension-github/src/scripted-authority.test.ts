import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { Event, Logger, MixerAutomationsAPI, Run, Workflow, Workspace } from "@mixer/automations-sdk";
import { Registry, StateDatabase, ensureHome, resolvePaths } from "../../core/src/index.js";
import github from "./index.js";
import { readRunCapability } from "./publication.js";

const directories: string[] = [];
afterEach(() => { vi.unstubAllGlobals(); for (const dir of directories.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
const logger: Logger = { debug() {}, info() {}, warn() {}, error() {}, child() { return logger; } };

it.each(["agent", "steps"])("does not grant PR branch authority from manual JSON to %s execution", async (kind) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "roboplane-script-authority-")); directories.push(home);
  const paths = resolvePaths(home); ensureHome(paths);
  const state = new StateDatabase(paths.state); const registry = new Registry(); registry.setOwner("github");
  const revision = "a".repeat(40);
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url.endsWith("/user")) return new Response(JSON.stringify({ id: 1, login: "maintainer" }));
    if (url.endsWith("/repos/owner/repo")) return new Response(JSON.stringify({ default_branch: "main" }));
    if (url.endsWith("/commits/main")) return new Response(JSON.stringify({ sha: revision }));
    throw new Error(`Unexpected request: ${url}`);
  }));
  const api: MixerAutomationsAPI = {
    inputs: { register() {}, validate() {}, async submit() { throw new Error("Not used"); } },
    events: registry.events, workflows: registry.workflows, agents: registry.agents, workspaces: registry.workspaces,
    actions: registry.actions, executions: registry.executions, commands: registry.commands, hooks: registry.hooks,
    config: { get: () => ({ token: "test-token", failureReports: { enabled: false } }), historyRetentionMs: () => 86_400_000 },
    state: { namespace: () => state.state("github") }, logger, paths,
    process: { async run(options) {
      return { exitCode: 0, stderr: "", stdout: options.command === "gh" ? "maintainer\n" : options.args?.includes("rev-parse") ? revision : "https://github.com/owner/repo.git" };
    } },
  };
  try {
    await github.setup(api);
    const event: Event = { id: "manual", type: "manual", source: "cli", repository: "owner/repo", timestamp: new Date().toISOString(), data: {
      number: 42, isPullRequest: true, state: "open", merged: false, pullRequestAuthor: "maintainer", baseSha: revision, baseBranch: "main",
      headSha: "b".repeat(40), headBranch: "fix", headRepository: "owner/repo",
    } };
    const run: Run = { id: "rp_manual", workflowId: "check.yaml", repository: "owner/repo", event, status: "running", createdAt: event.timestamp, updatedAt: event.timestamp };
    const workflow: Workflow = { id: "check.yaml", path: "/check.yaml", name: "check", repository: "owner/repo", on: { schedule: {} }, agent: kind === "agent" ? "codex" : "", execution: "host", safeActions: {}, prompt: "",
      ...(kind === "steps" ? { task: { kind: "steps" as const, runner: "steps", configuration: { steps: [{ run: "echo test" }] } } } : {}) };
    const workspace: Workspace = { path: path.join(paths.workspaces, run.id) }; fs.mkdirSync(workspace.path);
    await registry.runHooks(kind === "steps" ? "execution:before" : "agent:before", { run, event, workflow, workspace, instructions: [], metadata: {} });
    const capability = readRunCapability(paths.state, run.id);
    expect({ mode: capability?.mode, pr: capability?.prNumber, branch: capability?.allowedBranch }).toEqual({ mode: "new-branch", pr: undefined, branch: undefined });
    expect(workspace.environment?.PATH).toContain("guard");
  } finally { state.close(); }
});
