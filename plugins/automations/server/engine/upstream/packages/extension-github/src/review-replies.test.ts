import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Event, EventSource, HookContext, HookName, HookRegistry, Logger, MixerAutomationsAPI, Workspace } from "@mixer/automations-sdk";
import github from "./index.js";

const temporary: string[] = [];
afterEach(() => {
  vi.unstubAllGlobals();
  for (const directory of temporary.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

const sha = "a".repeat(40);
const rootComment = { id: 55, body: "Remove the duplicate test.", user: { login: "reviewer" },
  pull_request_url: "https://api.github.com/repos/owner/repo/pulls/42" };
const replyComment = { ...rootComment, id: 56, body: "Can you explain the change?", in_reply_to_id: 55 };

async function fixture(options: {
  type?: string;
  commentId?: number;
  conversation?: boolean;
  thirdParty?: boolean;
  replay?: boolean;
  comments?: Array<typeof rootComment & { in_reply_to_id?: number }>;
  existingReplies?: Array<{ body: string }>;
  changedComment?: boolean;
  missingComment?: boolean;
  wrongParentPr?: boolean;
  mergeAction?: boolean;
} = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "roboplane-review-replies-"));
  temporary.push(home);
  const workspace: Workspace = { path: path.join(home, "workspace") };
  execFileSync("git", ["init", "--quiet", "-b", "main", workspace.path]);
  execFileSync("git", ["-C", workspace.path, "remote", "add", "origin", "https://github.com/owner/repo.git"]);
  const hooks = new Map<HookName, Parameters<HookRegistry["on"]>[1]>();
  const sources = new Map<string, EventSource>();
  const logger: Logger = { debug() {}, info() {}, warn() {}, error() {}, child() { return logger; } };
  const api: MixerAutomationsAPI = {
    inputs: { register() {}, validate() {}, async submit() { throw new Error("Not used"); } },
    config: { get: () => ({ token: "test-token" }), historyRetentionMs: () => 86_400_000 },
    state: { namespace: () => ({ get: () => undefined, set() {}, delete() {}, entries: () => [] }) },
    events: { registerSource: (name, source) => { sources.set(name, source); } },
    workflows: { registerField() {}, registerRunner() {}, registerDiscovery() {} }, actions: { register() {} }, agents: { register() {} },
    workspaces: { register() {} }, executions: { register() {} }, commands: { register() {} },
    hooks: { on: (name, handler) => { hooks.set(name, handler); } },
    process: { run: async ({ command, args }) => ({ exitCode: 0, stderr: "", stdout:
      command === "gh" ? "maintainer\n" : args?.includes("rev-parse") ? sha : "https://github.com/owner/repo.git" }) },
    paths: { home, config: path.join(home, ".roboplane", "config.json"), cases: path.join(home, ".roboplane", "cases"),
      state: path.join(home, "state"), workflows: path.join(home, "automations"),
      extensions: path.join(home, "extensions"), logs: path.join(home, "logs"), workspaces: path.join(home, "workspaces") },
    logger,
  };
  const type = options.type ?? "github.pr.comment";
  const comment = options.commentId === 56 ? replyComment : rootComment;
  const event: Event = {
    id: "feedback", type, source: "github", repository: "owner/repo", timestamp: "2026-10-02T07:00:00Z",
    ...(options.replay ? { provenance: { kind: "replay", sourceRunId: "rp_original", rootRunId: "rp_original", sourceEventId: "original" } } : {}),
    data: { isPullRequest: true, number: 42, author: "reviewer", body: comment.body,
      ...(type === "github.pr.review" ? { reviewId: 77 } : {
        commentId: comment.id, commentKind: options.conversation ? "conversation" : "review",
      }) },
  };
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
    if (url.endsWith("/user")) return response({ id: 1, login: "maintainer" });
    if (url.endsWith("/pulls/42")) return response({ number: 42, state: "open", merged: false, draft: false,
      user: { login: options.thirdParty ? "contributor" : "maintainer" },
      head: { sha, ref: "feature/fix", repo: { full_name: "owner/repo" } },
      base: { sha, ref: "main", repo: { full_name: "owner/repo" } } });
    if (url.endsWith("/reviews/77")) return response({ id: 77, body: "", user: { login: "reviewer" }, state: "COMMENTED" });
    if (url.includes("/reviews/77/comments?")) {
      const page = Number(new URL(url).searchParams.get("page") ?? 1);
      return response((options.comments ?? [rootComment]).slice((page - 1) * 100, page * 100));
    }
    if (url.endsWith(`/pulls/comments/${comment.id}`) || url.endsWith(`/issues/comments/${comment.id}`)) {
      return response(options.missingComment ? {} : { ...comment, ...(options.changedComment ? { body: "Edited feedback" } : {}) }, options.missingComment ? 404 : 200);
    }
    if (url.endsWith("/pulls/comments/55")) return response({ ...rootComment,
      ...(options.wrongParentPr ? { pull_request_url: "https://api.github.com/repos/owner/repo/pulls/43" } : {}) });
    throw new Error(`Unexpected request: ${url}`);
  }));
  await github.setup(api);
  const source = sources.get(type)!;
  const activate = async () => {
    const activated = await source.activate!(event);
    const hook: HookContext = {
      event: { ...event, data: activated.data }, workspace, instructions: [], metadata: {},
      ...(options.mergeAction === undefined ? {} : { workflow: {
        id: "feedback.md", path: "/feedback.md", name: "Feedback", repository: "owner/repo", on: {},
        agent: "opencode", execution: "host", prompt: "Review the activated PR.",
        safeActions: options.mergeAction ? { "github.pr.merge": {
          max: 1, allowedAuthors: [options.thirdParty ? "contributor" : "maintainer"],
          method: "squash", mode: "immediate", approve: false, minimumChecks: 1,
        } } : {},
      } }),
      run: { id: "rp_feedback", workflowId: "feedback.md", repository: "owner/repo", event,
        status: "running", createdAt: event.timestamp, updatedAt: event.timestamp },
    };
    await hooks.get("agent:before")!(hook);
    return hook;
  };
  const realBin = path.join(home, "real-bin");
  fs.mkdirSync(realBin);
  const captured = path.join(home, "requests.jsonl");
  fs.writeFileSync(path.join(realBin, "gh"), `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args.includes('--method') && args[args.indexOf('--method') + 1] === 'POST') {
  fs.appendFileSync(${JSON.stringify(captured)}, JSON.stringify(args) + '\\n');
  console.log(JSON.stringify({id: 101, in_reply_to_id: 55}));
} else console.log(${JSON.stringify(JSON.stringify(options.existingReplies ?? []))});
`, { mode: 0o700 });
  const invoke = (args: string[], tool = "gh") => spawnSync(path.join(workspace.path, ".git", "roboplane-guard", "bin", tool), args, {
    cwd: workspace.path, encoding: "utf8", env: { ...process.env, ...workspace.environment,
      MIXER_AUTOMATIONS_REAL_PATH: `${realBin}${path.delimiter}${process.env.PATH ?? ""}` },
  });
  const requests = () => fs.existsSync(captured) ? fs.readFileSync(captured, "utf8").trim().split("\n").map(line => JSON.parse(line)) : [];
  return { activate, invoke, requests };
}

function replyArgs(commentId = 55, publicationKey = "rp_feedback") {
  return ["api", "--method", "POST", `repos/owner/repo/pulls/42/comments/${commentId}/replies`,
    "-f", `body=The duplicate test is removed.\n\n<!-- roboplane:${publicationKey}:reply:${commentId} -->`];
}

describe("activated review replies", () => {
  it.each([true, false])("explains ancestry and separate merge authority when mergeAction is %s", async mergeAction => {
    const check = await fixture({ mergeAction });
    const hook = await check.activate();
    const instructions = hook.instructions.join("\n");
    expect(instructions).toContain("The activated base revision is an ancestry constraint, not the live target-branch tip.");
    expect(instructions).toContain("Read the live target-branch SHA independently of the PR-reported base SHA.");
    expect(instructions).toContain("You may merge newer target-branch commits into this existing PR branch without rewriting history, subject to the workflow's branch-write scope.");
    expect(instructions).toContain("Never merge a PR into its target branch through git, gh, or an API call, and never change the PR's target branch.");
    expect(instructions).toContain(mergeAction
      ? "The declared github.pr.merge Safe Action may be requested only after the workflow's merge gates pass; it executes after you exit and is independently validated."
      : "This workflow declares no github.pr.merge Safe Action; do not request a merge.");
    expect(instructions).not.toContain("Pull-request merges and base-branch changes are always prohibited.");
    expect(check.invoke(["pr", "merge", "42", "--squash"]).status).toBe(73);
    expect(check.requests()).toEqual([]);
  });

  it("keeps review-only branch restrictions separate from a declared merge Safe Action", async () => {
    const check = await fixture({ thirdParty: true, mergeAction: true });
    const hook = await check.activate();
    const instructions = hook.instructions.join("\n");
    expect(instructions).toContain("This is a review-only run for normal git and gh commands");
    expect(instructions).toContain("The declared github.pr.merge Safe Action may be requested only after the workflow's merge gates pass");
    expect(instructions).not.toContain("You may merge newer target-branch commits into this existing PR branch");
    expect(check.invoke(["commit", "--allow-empty", "-m", "unsafe"], "git").status).toBe(73);
    expect(check.invoke(["pr", "merge", "42", "--squash"]).status).toBe(73);
    expect(check.requests()).toEqual([]);
  });

  it("publishes a standalone inline-comment reply through the capability created by the extension", async () => {
    const check = await fixture();
    const hook = await check.activate();
    const result = check.invoke(replyArgs());
    expect(result.status, result.stderr).toBe(0);
    expect(check.requests()).toEqual([replyArgs()]);
    expect(hook.instructions.join("\n")).toContain("/repos/owner/repo/pulls/42/comments/55/replies");
    expect(hook.instructions.join("\n")).toContain("<!-- roboplane:rp_feedback:reply:55 -->");
  });

  it("allows scoped replies on review-only PRs without granting commit or push permission", async () => {
    const check = await fixture({ thirdParty: true });
    await check.activate();
    expect(check.invoke(replyArgs()).status).toBe(0);
    expect(check.requests()).toEqual([replyArgs()]);
    for (const args of [["commit", "--allow-empty", "-m", "unsafe"], ["push", "origin", "feature/fix"]]) {
      const result = check.invoke(args, "git");
      expect(result.status).toBe(73);
      expect(result.stderr).toContain("workflow cannot update the pull request");
    }
  });

  it.each(["github.pr.comment", "github.pr.review"])("replies to the verified thread root for a triggering reply in %s", async type => {
    const check = await fixture({ type, commentId: 56, comments: [replyComment] });
    const hook = await check.activate();
    expect(check.invoke(replyArgs()).status).toBe(0);
    expect(check.requests()).toEqual([replyArgs()]);
    expect(hook.instructions.join("\n")).toContain("verified thread root 55, not triggering reply 56");
    expect(check.invoke(replyArgs(56)).status).toBe(73);
    expect(check.requests()).toEqual([replyArgs()]);
  });

  it("authorizes all pages of the exact submitted review without authorizing unrelated comments", async () => {
    const comments = Array.from({ length: 101 }, (_, index) => ({ ...rootComment, id: index + 100 }));
    const check = await fixture({ type: "github.pr.review", comments });
    await check.activate();
    expect(check.invoke(replyArgs(100)).status).toBe(0);
    expect(check.invoke(replyArgs(200)).status).toBe(0);
    expect(check.invoke(replyArgs(55)).status).toBe(73);
    expect(check.requests()).toEqual([replyArgs(100), replyArgs(200)]);
  });

  it.each([
    { name: "wrong repository", endpoint: "repos/other/repo/pulls/42/comments/55/replies", message: "different repository" },
    { name: "wrong PR", endpoint: "repos/owner/repo/pulls/43/comments/55/replies", message: "different pull request" },
    { name: "unrelated comment", endpoint: "repos/owner/repo/pulls/42/comments/99/replies", message: "not authorized" },
    { name: "missing marker", body: "body=The duplicate is removed.", message: "required publication marker" },
    { name: "wrong marker", body: "body=Fixed. <!-- roboplane:other-run:reply:55 -->", message: "required publication marker" },
  ])("rejects $name before forwarding the mutation", async ({ endpoint, body, message }) => {
    const check = await fixture();
    await check.activate();
    const args = replyArgs();
    if (endpoint) args[3] = endpoint;
    if (body) args[5] = body;
    const result = check.invoke(args);
    expect(result.status).toBe(73);
    expect(result.stderr).toContain(message);
    expect(check.requests()).toEqual([]);
    expect(check.invoke(replyArgs()).status).toBe(0);
    expect(check.requests()).toEqual([replyArgs()]);
  });

  it("does not give conversation comments permission to publish inline replies", async () => {
    const check = await fixture({ type: "github.issue.comment", conversation: true });
    const hook = await check.activate();
    expect(check.invoke(replyArgs()).status).toBe(73);
    expect(check.requests()).toEqual([]);
    expect(hook.instructions.join("\n")).not.toContain("/comments/55/replies");
  });

  it("keeps replay reply markers bound to the original run", async () => {
    const check = await fixture({ replay: true });
    const hook = await check.activate();
    expect(check.invoke(replyArgs(55, "rp_original")).status).toBe(0);
    expect(check.invoke(replyArgs()).status).toBe(73);
    expect(check.requests()).toEqual([replyArgs(55, "rp_original")]);
    expect(hook.instructions.join("\n")).toContain("<!-- roboplane:rp_original:reply:55 -->");
  });

  it("does not publish another reply when the replay lineage already answered the thread", async () => {
    const marker = "<!-- roboplane:rp_original:reply:55 -->";
    const existing = await fixture({ replay: true, existingReplies: [{ body: `Already fixed.\n\n${marker}` }] });
    await existing.activate();
    expect(existing.invoke(replyArgs(55, "rp_original")).status).toBe(0);
    expect(existing.requests()).toEqual([]);
    const unanswered = await fixture({ replay: true });
    await unanswered.activate();
    expect(unanswered.invoke(replyArgs(55, "rp_original")).status).toBe(0);
    expect(unanswered.requests()).toEqual([replyArgs(55, "rp_original")]);
  });

  it.each([
    { name: "changed trigger", changedComment: true, message: "triggering comment changed" },
    { name: "deleted trigger", missingComment: true, message: "failed (404)" },
    { name: "parent from another PR", commentId: 56, wrongParentPr: true, message: "belongs to another pull request" },
  ])("stops activation for a $name", async ({ name: _name, message, ...options }) => {
    const check = await fixture(options);
    await expect(check.activate()).rejects.toThrow(message);
    expect(check.requests()).toEqual([]);
  });
});
