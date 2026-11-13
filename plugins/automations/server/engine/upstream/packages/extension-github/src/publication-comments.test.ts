import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHmac } from "node:crypto";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { Runtime } from "@roboplane/core";
import webhooks from "@roboplane/extension-webhooks";
import type { Event, EventSource, Logger, MixerAutomationsAPI, Workspace } from "@mixer/automations-sdk";
import github from "./index.js";
import { publishedIssueComment } from "./comments.js";
import { installPublishGuard } from "./publication.js";

const temporary: string[] = [];
const sourcesToStop: Array<() => void> = [];
const runtimes: Runtime[] = [];
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.stop();
  for (const stop of sourcesToStop.splice(0)) stop();
  vi.unstubAllGlobals();
  delete process.env.MIXER_AUTOMATIONS_PUBLICATION_WEBHOOK_SECRET;
  for (const directory of temporary.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function guardedComment() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "roboplane-issue-comment-"));
  temporary.push(root);
  const workspace: Workspace = { path: path.join(root, "workspace") };
  const stateDirectory = path.join(root, ".roboplane", "state");
  installPublishGuard({ workspace, stateDirectory, capability: {
    version: 1, runId: "rp_comment", repository: "owner/repo", mode: "new-branch", reconciliation: "confirmed",
    baseRevision: "a".repeat(40), baseBranch: "main", remote: "https://github.com/owner/repo.git",
    maxChangedFiles: 10, case: { kind: "issue", number: 42 },
  } });
  const realBin = path.join(root, "real-bin");
  fs.mkdirSync(realBin);
  const captured = path.join(root, "request.json");
  fs.writeFileSync(path.join(realBin, "gh"), `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const index = args.indexOf('--body');
const file = args.indexOf('--body-file');
const body = index >= 0 ? args[index + 1] : fs.readFileSync(file >= 0 ? args[file + 1] : 0, 'utf8');
const receipts = path.join(${JSON.stringify(stateDirectory)}, 'github-published-comments');
fs.writeFileSync(${JSON.stringify(captured)}, JSON.stringify({body, args, receipts: fs.existsSync(receipts) ? fs.readdirSync(receipts).map(name => JSON.parse(fs.readFileSync(path.join(receipts, name), 'utf8'))) : []}));
console.log('https://github.com/owner/repo/issues/42#issuecomment-101');
process.exit(Number(process.env.COMMENT_TEST_EXIT || 0));
`, { mode: 0o700 });
  const command = path.join(workspace.path, ".git", "roboplane-guard", "bin", process.platform === "win32" ? "gh.cmd" : "gh");
  const env = { ...process.env, ...workspace.environment, MIXER_AUTOMATIONS_REAL_PATH: `${realBin}${path.delimiter}${process.env.PATH ?? ""}` };
  return { root, workspace, stateDirectory, command, env, captured };
}

function publish(fixture: ReturnType<typeof guardedComment>, args = ["--body", "The hook is included."]) {
  const result = spawnSync(fixture.command, ["issue", "comment", "42", ...args], {
    cwd: fixture.workspace.path, env: fixture.env, encoding: "utf8",
  });
  expect(result.status, result.stderr).toBe(0);
  return z.object({ body: z.string() }).parse(JSON.parse(fs.readFileSync(fixture.captured, "utf8"))).body;
}

function commentEvent(id: string, body: string, author = "maintainer") {
  return { id, type: "IssueCommentEvent", created_at: "2026-09-30T15:29:31Z", actor: { login: author }, payload: {
    action: "created", issue: { number: 42, state: "open", title: "Fallback", labels: ["auto-issue"] },
    comment: { id: Number(id), body, user: { login: author } },
  } };
}

async function startSource(fixture: ReturnType<typeof guardedComment>, state: Map<string, unknown>, options: {
  publishGuardEnabled?: boolean;
} = {}) {
  const sources = new Map<string, EventSource>();
  const info = vi.fn();
  const logger: Logger = { debug() {}, info, warn() {}, error() {}, child() { return logger; } };
  const api = {
    config: { get: () => ({ token: "test-token", pollInterval: "5m", publishGuard: { enabled: options.publishGuardEnabled ?? true } }) },
    state: { namespace: () => ({ get: (key: string) => state.get(key), set: (key: string, value: unknown) => { state.set(key, value); },
      delete: (key: string) => { state.delete(key); }, entries: () => [] }) },
    events: { registerSource(name: string, source: EventSource) { sources.set(name, source); } },
    inputs: { register() {} }, workflows: { registerField() {}, registerRunner() {} }, commands: { register() {} }, hooks: { on() {} }, actions: { register() {} },
    paths: { home: fixture.root, state: fixture.stateDirectory, cases: path.join(fixture.root, ".roboplane", "cases") }, logger,
  } as unknown as MixerAutomationsAPI;
  await github.setup!(api);
  const source = sources.get("github.issue.comment")!;
  const emitted: Event[] = [];
  const controller = new AbortController();
  const stop = () => { controller.abort(); void source.stop?.(); };
  sourcesToStop.push(stop);
  await source.start!({ type: "github.issue.comment", signal: controller.signal,
    subscriptions: [{ type: "github.issue.comment", repository: "owner/repo", workflowId: "follow-up.md", config: {} }],
    emit: async (event) => { emitted.push(event); return { version: 1, eventId: event.id, status: "accepted" }; },
  });
  return { source, emitted, info, stop };
}

describe("guarded issue comments", () => {
  it("marks automated comments before publication without changing their visible text", () => {
    const fixture = guardedComment();
    const result = spawnSync(fixture.command, ["issue", "comment", "42", "--body", "The hook is included."], {
      cwd: fixture.workspace.path, env: fixture.env, encoding: "utf8",
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("https://github.com/owner/repo/issues/42#issuecomment-101\n");
    const request = JSON.parse(fs.readFileSync(fixture.captured, "utf8"));
    expect(request.body).toMatch(/^The hook is included\.\n\n<!-- roboplane:rp_comment:issue-comment:[a-f0-9-]+ -->$/);
    expect(request.receipts).toEqual([expect.objectContaining({
      runId: "rp_comment", repository: "owner/repo", number: 42, status: "pending",
    })]);
    expect(publishedIssueComment({ stateDirectory: fixture.stateDirectory, repository: "owner/repo", number: 42,
      body: request.body, commentId: 101 })).toMatchObject({ status: "confirmed", commentId: 101 });
  });

  it.each(["--body-file", "-F", "--body-file=", "-F="])("marks a %s input without modifying its source file", (flag) => {
    const fixture = guardedComment();
    const file = path.join(fixture.root, "body.md");
    fs.writeFileSync(file, "First paragraph.\n\nSecond paragraph.\n");
    const body = publish(fixture, flag.endsWith("=") ? [flag + file] : [flag, file]);
    expect(body.split("<!--")[0]).toBe("First paragraph.\n\nSecond paragraph.\n\n\n");
    expect(fs.readFileSync(file, "utf8")).toBe("First paragraph.\n\nSecond paragraph.\n");
  });

  it.each(["-b", "--body=", "-b="])("marks a %s inline body", (flag) => {
    const fixture = guardedComment();
    const body = publish(fixture, flag.endsWith("=") ? [flag + "An answer."] : [flag, "An answer."]);
    expect(body).toMatch(/^An answer\.\n\n<!-- roboplane:rp_comment:issue-comment:[a-f0-9-]+ -->$/);
  });

  it("marks stdin bodies without requesting terminal input", () => {
    const fixture = guardedComment();
    const result = spawnSync(fixture.command, ["issue", "comment", "42", "--body-file", "-"], {
      cwd: fixture.workspace.path, env: fixture.env, encoding: "utf8", input: "Answer from stdin.",
    });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(fs.readFileSync(fixture.captured, "utf8")).body).toMatch(/^Answer from stdin\.\n\n<!-- roboplane:/);
  });

  it.each([
    ["--editor"], ["--edit-last", "--body", "Edited."], ["--delete-last"], [], ["--body", ""],
    ["--body", "Inline.", "--body-file", "-"], ["--body", "Wrong repo.", "-R", "another/repo"],
  ])("rejects unsafe or ambiguous publication arguments %j before making a request", (...args) => {
    const fixture = guardedComment();
    const result = spawnSync(fixture.command, ["issue", "comment", "42", ...args], {
      cwd: fixture.workspace.path, env: fixture.env, encoding: "utf8",
    });
    expect(result.status).toBe(73);
    expect(fs.existsSync(fixture.captured)).toBe(false);
  });

  it("retains the publication intent when the response is lost or the request fails", () => {
    const fixture = guardedComment();
    const result = spawnSync(fixture.command, ["issue", "comment", "42", "--body", "Sent before a connection failure."], {
      cwd: fixture.workspace.path, env: { ...fixture.env, COMMENT_TEST_EXIT: "1" }, encoding: "utf8",
    });
    expect(result.status).toBe(1);
    const body = JSON.parse(fs.readFileSync(fixture.captured, "utf8")).body;
    expect(publishedIssueComment({ stateDirectory: fixture.stateDirectory, repository: "owner/repo", number: 42,
      body, commentId: 101 })).toMatchObject({ status: "pending", runId: "rp_comment" });
  });

  it("requires the original body, case, and confirmed comment ID", () => {
    const fixture = guardedComment();
    const body = publish(fixture);
    const input = { stateDirectory: fixture.stateDirectory, repository: "owner/repo", number: 42, body, commentId: 101 };
    expect(publishedIssueComment(input)).toMatchObject({ status: "confirmed", commentId: 101 });
    expect(publishedIssueComment({ ...input, body: `Quoted:\n${body}` })).toBeUndefined();
    expect(publishedIssueComment({ ...input, number: 43 })).toBeUndefined();
    expect(publishedIssueComment({ ...input, repository: "another/repo" })).toBeUndefined();
    expect(publishedIssueComment({ ...input, commentId: 102 })).toBeUndefined();
  });

  it.each(["pending", "confirmed"])("delivers manual replies interleaved with %s automated comments, including after restart", async (status) => {
    const fixture = guardedComment();
    const body = publish(fixture);
    if (status === "pending") {
      const directory = path.join(fixture.stateDirectory, "github-published-comments");
      const file = path.join(directory, fs.readdirSync(directory)[0]!);
      const { commentId: _commentId, ...receipt } = JSON.parse(fs.readFileSync(file, "utf8"));
      fs.writeFileSync(file, JSON.stringify({ ...receipt, status: "pending" }));
    }
    const state = new Map<string, unknown>([
      ["events:owner/repo:cursor", "0"],
      ["self:active-run:owner/repo:issue:42", new Date(Date.now() + 2 * 60 * 60_000).toISOString()],
    ]);
    const events = [commentEvent("104", 'issue-reply: I tested sendEvent("goBack").'),
      commentEvent("103", body, "contributor"), commentEvent("102", "issue-reply: Include the hook."),
      commentEvent("101", body), { id: "0", type: "IssuesEvent" }];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/user")) return new Response('{"login":"maintainer","id":1}');
      if (url.includes("/events?")) return new Response(JSON.stringify(events));
      throw new Error(`unexpected request ${url}`);
    }));
    const first = await startSource(fixture, state);
    await vi.waitFor(() => expect(state.get("events:owner/repo:cursor")).toBe("104"));
    expect(first.emitted.map(event => event.id)).toEqual(["github:owner/repo:102", "github:owner/repo:103", "github:owner/repo:104"]);
    expect(first.info).toHaveBeenCalledWith({ eventId: "github:owner/repo:101", commentId: 101, runId: "rp_comment",
      reason: "published_issue_comment" }, "GitHub event suppressed");
    first.stop();
    state.set("events:owner/repo:cursor", "0");
    const restarted = await startSource(fixture, state);
    await vi.waitFor(() => expect(state.get("events:owner/repo:cursor")).toBe("104"));
    expect(restarted.emitted.map(event => event.id)).toEqual(["github:owner/repo:102", "github:owner/repo:103", "github:owner/repo:104"]);
  });

  it("delivers comments quoting legacy markers but suppresses extension-owned resolution replies", async () => {
    const fixture = guardedComment();
    const state = new Map<string, unknown>([["events:owner/repo:cursor", "0"]]);
    const events = [commentEvent("3", "Another answer. <!-- roboplane:rp_resolution:issue-resolution -->", "contributor"),
      commentEvent("2", "issue-reply: The earlier reply included <!-- roboplane:rp_resolution:issue-resolution --> in its source."),
      commentEvent("1", "Need more evidence.\n\n<!-- roboplane:rp_resolution:issue-resolution -->"),
      { id: "0", type: "IssuesEvent" }];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      if (String(input).endsWith("/user")) return new Response('{"login":"maintainer","id":1}');
      if (String(input).includes("/events?")) return new Response(JSON.stringify(events));
      throw new Error(`unexpected request ${String(input)}`);
    }));
    const started = await startSource(fixture, state);
    await vi.waitFor(() => expect(state.get("events:owner/repo:cursor")).toBe("3"));
    expect(started.emitted.map(event => event.id)).toEqual(["github:owner/repo:2", "github:owner/repo:3"]);
  });

  it("retains the legacy cooldown when publication guarding is explicitly disabled", async () => {
    const fixture = guardedComment();
    const state = new Map<string, unknown>([["events:owner/repo:cursor", "0"],
      ["self:active-run:owner/repo:issue:42", new Date(Date.now() + 5 * 60_000).toISOString()]]);
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      if (String(input).endsWith("/user")) return new Response('{"login":"maintainer","id":1}');
      if (String(input).includes("/events?")) return new Response(JSON.stringify([
        commentEvent("1", "An unguarded automated comment."), { id: "0", type: "IssuesEvent" },
      ]));
      throw new Error(`unexpected request ${String(input)}`);
    }));
    const started = await startSource(fixture, state, { publishGuardEnabled: false });
    await vi.waitFor(() => expect(state.get("events:owner/repo:cursor")).toBe("1"));
    expect(started.emitted).toEqual([]);
    expect(started.info).toHaveBeenCalledWith({ eventId: "github:owner/repo:1", commentId: 1,
      reason: "active_run_self_guard" }, "GitHub event suppressed");
  });

  it("does not advance the cursor when a publication receipt cannot be read safely", async () => {
    const fixture = guardedComment();
    const body = publish(fixture);
    const file = path.join(fixture.stateDirectory, "github-published-comments",
      fs.readdirSync(path.join(fixture.stateDirectory, "github-published-comments"))[0]!);
    fs.writeFileSync(file, "not JSON");
    const state = new Map<string, unknown>([["events:owner/repo:cursor", "0"]]);
    const fetched = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/user")) return new Response('{"login":"maintainer","id":1}');
      if (url.includes("/events?")) return new Response(JSON.stringify([commentEvent("101", body), { id: "0", type: "IssuesEvent" }]));
      throw new Error(`unexpected request ${url}`);
    });
    vi.stubGlobal("fetch", fetched);
    const started = await startSource(fixture, state);
    await vi.waitFor(() => expect(fetched).toHaveBeenCalledWith("https://api.github.com/user", expect.anything()));
    expect(state.get("events:owner/repo:cursor")).toBe("0");
    expect(started.emitted).toEqual([]);
  });

  it("applies the same manual-versus-agent decision to signed webhooks", async () => {
    const fixture = guardedComment();
    const body = publish(fixture);
    const realFetch = globalThis.fetch;
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).startsWith("http://127.0.0.1:")) return realFetch(input, init);
      if (String(input).endsWith("/user")) return new Response('{"login":"maintainer","id":1}');
      throw new Error(`unexpected request ${String(input)}`);
    }));
    fs.writeFileSync(path.join(fixture.root, ".roboplane", "config.json"), JSON.stringify({ extensions: {
      github: { token: "test-token", polling: false }, webhooks: { listener: { port: 0 } },
    } }));
    fs.mkdirSync(path.join(fixture.root, "webhooks"));
    fs.writeFileSync(path.join(fixture.root, "webhooks", "github.yaml"), "handler: github.events\npath: /github/webhook\nsecretEnv: MIXER_AUTOMATIONS_PUBLICATION_WEBHOOK_SECRET\n");
    process.env.MIXER_AUTOMATIONS_PUBLICATION_WEBHOOK_SECRET = "test-secret";
    const runtime = new Runtime({ home: fixture.root, builtins: [{ extension: webhooks }, { extension: github }] });
    runtimes.push(runtime);
    await runtime.initialize();
    runtime.database.state("github").set("self:active-run:owner/repo:issue:42", new Date(Date.now() + 5 * 60_000).toISOString());
    await runtime.start();
    await runtime.registry.eventSources.get("github.issue.comment")?.updateSubscriptions?.("github.issue.comment", [
      { type: "github.issue.comment", repository: "owner/repo", workflowId: "follow-up.md", config: {} },
    ]);
    const listing = await runtime.submitInput("webhooks.control", { command: "list" });
    if (listing.kind !== "response") throw new Error("Expected webhook listing");
    const { listener } = z.object({ listener: z.object({ port: z.number() }) }).parse(JSON.parse(listing.body));
    for (const event of [commentEvent("101", body), commentEvent("102", "issue-reply: Include the hook.")]) {
      const payload = JSON.stringify({ ...event.payload, sender: event.actor, repository: { full_name: "owner/repo" } });
      const response = await fetch(`http://127.0.0.1:${listener.port}/github/webhook`, { method: "POST", body: payload, headers: {
        "x-github-event": "issue_comment", "x-github-delivery": event.id,
        "x-hub-signature-256": `sha256=${createHmac("sha256", "test-secret").update(payload).digest("hex")}`,
      } });
      expect(response.status).toBe(202);
      await response.text();
    }
    expect(runtime.database.getEvent("github:owner/repo:101")).toBeUndefined();
    expect(runtime.database.getEvent("github:owner/repo:102")).toMatchObject({ source: "github", type: "github.issue.comment" });
  });
});
