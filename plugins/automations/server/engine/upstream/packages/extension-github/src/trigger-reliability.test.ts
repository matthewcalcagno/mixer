import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Runtime } from "@roboplane/core";
import type { Event, Extension, Run, Workflow } from "@mixer/automations-sdk";
import github from "./index.js";
import { workReceiptKey } from "./execution-policy.js";

const homes: string[] = [];
const runtimes: Runtime[] = [];
const sha = "a".repeat(40);
const pr = { number: 42, title: "A different PR title", state: "open", draft: false, merged: false,
  user: { login: "human" }, labels: [], head: { sha, ref: "feature/fix", repo: { full_name: "owner/repo" } },
  base: { sha: "b".repeat(40), ref: "main", repo: { full_name: "owner/repo" } } };

afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.stop();
  for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true });
  vi.unstubAllGlobals(); vi.unstubAllEnvs();
});

async function fixture(configuration: Record<string, unknown> = {}, extras: Extension[] = []) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "rp-trigger-")); homes.push(home);
  fs.mkdirSync(path.join(home, ".roboplane"));
  fs.writeFileSync(path.join(home, ".roboplane", "config.json"), JSON.stringify({ extensions: { github: { token: "test", polling: false, ...configuration } } }));
  const runtime = new Runtime({ home, builtins: [{ extension: github }, ...extras.map(extension => ({ extension }))] }); runtimes.push(runtime);
  await runtime.initialize();
  vi.stubEnv("RP_TRIGGER_SECRET", "secret");
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith("/user")) return Response.json({ id: 1, login: "maintainer" });
    if (url.endsWith("/pulls/42")) return Response.json(pr);
    throw new Error(`Unexpected request: ${url}`);
  }));
  return runtime;
}

async function deliver(runtime: Runtime, eventName: string, payload: unknown, id = "delivery") {
  await runtime.registry.eventSources.get("github.issue")?.updateSubscriptions?.("github.issue", [
    { type: "github.issue", repository: "owner/repo", workflowId: "fixture", config: {} },
  ]);
  const body = Buffer.from(JSON.stringify(payload));
  return runtime.submitInput("github.events", { endpoint: "github", local: false, body, headers: {
    "x-github-event": eventName, "x-github-delivery": id,
    "x-hub-signature-256": `sha256=${createHmac("sha256", "secret").update(body).digest("hex")}`,
  } }, { secretEnv: "RP_TRIGGER_SECRET" });
}

describe("GitHub trigger reliability", () => {
  it("retains a named check's meaning through activation and re-matching", async () => {
    const runtime = await fixture();
    const source = runtime.registry.eventSources.get("github.check");
    const event: Event = { id: "check", type: "github.check", source: "github", timestamp: new Date().toISOString(), repository: "owner/repo",
      data: { action: "completed", title: "CI", number: 42, isPullRequest: true, headSha: sha, checkConclusion: "failure" } };
    const trigger = { events: ["completed"], where: { all: [{ title: "CI" }, { "check-conclusion": "failure" }, { state: "open" }] } };
    expect(await source?.match?.(event, trigger)).toBe(true);
    const activation = await source?.activate?.(event);
    expect(activation?.data).toMatchObject({ title: "CI", headSha: sha, checkConclusion: "failure" });
    expect(await source?.match?.({ ...event, data: activation?.data }, trigger)).toBe(true);
  });

  it("does not consume a human label event using a legacy broad self marker", async () => {
    const runtime = await fixture();
    runtime.database.state("github").set("self:owner/repo:42:labeled", new Date(Date.now() + 300_000).toISOString());
    const result = await deliver(runtime, "issues", { action: "labeled", repository: { full_name: "owner/repo" }, sender: { login: "human" },
      label: { name: "start-work" }, issue: { number: 42, state: "open", labels: [{ name: "start-work" }] } });
    expect(result).toMatchObject({ kind: "event", result: { status: "accepted" } });
  });

  it("does not infer publication ownership from a human's branch prefix", async () => {
    const runtime = await fixture();
    expect(await deliver(runtime, "pull_request", { action: "opened", repository: { full_name: "owner/repo" }, sender: { login: "human" },
      pull_request: { ...pr, head: { ...pr.head, ref: "roboplane/human-fix" } } })).toMatchObject({ kind: "event" });
  });

  it("keeps an exact published-head receipt effective on redelivery", async () => {
    const runtime = await fixture();
    const directory = path.join(runtime.paths.state, "github-published-heads", "owner--repo"); fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, `${sha}.json`), JSON.stringify({ repository: "owner/repo", head: sha, expiresAt: Date.now() + 300_000 }));
    const payload = { action: "opened", repository: { full_name: "owner/repo" }, sender: { login: "maintainer" }, pull_request: pr };
    expect(await deliver(runtime, "pull_request", payload)).toEqual({ kind: "ignored", reason: "self_mutation" });
    expect(await deliver(runtime, "pull_request", payload)).toEqual({ kind: "ignored", reason: "self_mutation" });
  });

  it("validates polling durations during setup instead of failing its background loop", async () => {
    const runtime = await fixture({ pollInterval: "nonsense" });
    expect(runtime.extensions[0]?.error?.message).toContain("pollInterval");
    expect(runtime.registry.eventSources.has("github.issue")).toBe(false);
  });

  it("propagates activation cancellation into the GitHub request", async () => {
    const runtime = await fixture();
    vi.stubGlobal("fetch", vi.fn((_input: unknown, options: RequestInit) => new Promise<Response>((_resolve, reject) => {
      options.signal?.addEventListener("abort", () => reject(options.signal?.reason), { once: true });
    })));
    const controller = new AbortController();
    const source = runtime.registry.eventSources.get("github.pull-request");
    const activation = source?.activate?.({ id: "pr", type: "github.pull-request", source: "github", timestamp: new Date().toISOString(), repository: "owner/repo",
      data: { number: 42, isPullRequest: true } }, { signal: controller.signal });
    controller.abort(new Error("Stop activation"));
    await expect(activation).rejects.toThrow("Stop activation");
  }, 1500);

  it("rejects ambiguous simultaneous webhook and polling collection", async () => {
    const runtime = await fixture({ polling: true });
    await expect(deliver(runtime, "issues", { action: "opened", repository: { full_name: "owner/repo" }, issue: { number: 42 } }))
      .rejects.toThrow("polling: false");
  });

  it("skips a retracted issue comment before starting a workspace", async () => {
    const runtime = await fixture();
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ id: 9, body: "Request withdrawn" })));
    const result = await runtime.registry.eventSources.get("github.issue.comment")?.activate?.({
      id: "comment", type: "github.issue.comment", source: "github", timestamp: new Date().toISOString(), repository: "owner/repo",
      data: { number: 42, commentId: 9, body: "Please investigate", isPullRequest: false },
    });
    expect(result).toEqual({ decision: { kind: "skip", reason: "triggering_comment_changed" } });
  });

  it("preserves continuity on an unavailable branch lookup instead of replacing it", async () => {
    const runtime = await fixture();
    const key = "branch-capability:owner/repo:issue:42";
    const capability = { version: 1, runId: "previous", mode: "new-branch", repository: "owner/repo", remote: "https://github.com/owner/repo.git",
      baseBranch: "main", baseRevision: sha, allowedBranch: "feature/existing", prNumber: 7 };
    runtime.database.state("github").set(key, capability);
    vi.stubGlobal("fetch", vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url.endsWith("/issues/42")) return Response.json({ number: 42, state: "open" });
      if (url.endsWith("/repos/owner/repo")) return Response.json({ default_branch: "main" });
      return new Response("Access unavailable", { status: 403 });
    }));
    await expect(runtime.registry.eventSources.get("github.issue")?.activate?.({ id: "issue", type: "github.issue", source: "github", timestamp: new Date().toISOString(),
      repository: "owner/repo", data: { number: 42 } })).rejects.toThrow("403");
    expect(runtime.database.state("github").get(key)).toEqual(capability);
  });

  it("ignores obsolete checks by default and permits an explicit historical-check policy", async () => {
    const runtime = await fixture();
    const source = runtime.registry.eventSources.get("github.check");
    const event: Event = { id: "old-check", type: "github.check", source: "github", timestamp: new Date().toISOString(), repository: "owner/repo",
      data: { title: "CI", number: 42, isPullRequest: true, headSha: "c".repeat(40), checkConclusion: "failure" } };
    expect(await source?.activate?.(event)).toEqual({ decision: { kind: "skip", reason: "check_revision_superseded" } });
    const workflow: Workflow = { id: "checks.md", path: "/checks.md", name: "Checks", agent: "fake", execution: "host", prompt: "Inspect", on: {}, safeActions: {},
      extensions: { "github.execution": { currentHeadChecks: false } } };
    expect(await source?.activate?.(event, { signal: new AbortController().signal, workflow })).toMatchObject({ data: { headSha: sha, title: "CI" } });
  });

  it("suppresses only successful equivalent snapshot work, preserving new feedback and definition changes", async () => {
    const runtime = await fixture({ publishGuard: { enabled: false }, failureReports: { enabled: false } });
    const source = runtime.registry.eventSources.get("github.pull-request");
    const workflow: Workflow = { id: "qa.md", path: "/qa.md", name: "QA", repository: "owner/repo", agent: "fake", execution: "host", prompt: "Inspect", on: {}, safeActions: {},
      extensions: { "github.execution": { oncePerHead: true } } };
    const event: Event = { id: "qa", type: "github.pull-request", source: "github", timestamp: new Date().toISOString(), repository: "owner/repo", data: { number: 42, isPullRequest: true } };
    const operation = { signal: new AbortController().signal, workflow };
    const activation = await source?.activate?.(event, operation);
    const run: Run = { id: "qa-run", workflowId: workflow.id, repository: "owner/repo", event, activation, status: "running", createdAt: event.timestamp, updatedAt: event.timestamp };
    await runtime.registry.runHooks("agent:before", { event: { ...event, data: activation?.data }, run, workflow, instructions: [], metadata: {} });
    run.status = "completed";
    await runtime.registry.runHooks("run:finalized", { event, run, workflow, instructions: [], metadata: { outcome: { outcome: "no-op" } } });
    expect(await source?.activate?.(event, operation)).toMatchObject({ decision: { kind: "skip", reason: "work_already_handled" } });
    expect(await source?.activate?.(event, { ...operation, workflow: { ...workflow, prompt: "Revised inspection" } })).not.toHaveProperty("decision");
    expect(workReceiptKey(workflow, { ...event, type: "github.pr.review", data: activation?.data })).toBeUndefined();
    expect(workReceiptKey(workflow, { ...event, type: "github.issue.comment", data: activation?.data })).toBeUndefined();
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ...pr, head: { ...pr.head, sha: "c".repeat(40) } })));
    expect(await source?.activate?.(event, operation)).not.toHaveProperty("decision");
  });

  it("keeps merge-readiness work pending without starting a model when checks or approval are absent", async () => {
    const runtime = await fixture();
    vi.stubGlobal("fetch", vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url.endsWith("/user")) return Response.json({ id: 1, login: "maintainer" });
      if (url.endsWith("/pulls/42")) return Response.json({ ...pr, mergeable: true, mergeable_state: "clean" });
      if (url.includes("check-runs")) return Response.json({ total_count: 0, check_runs: [] });
      if (url.endsWith("/protection")) return new Response("Not protected", { status: 404 });
      return Response.json([]);
    }));
    const workflow: Workflow = { id: "merge.md", path: "/merge.md", name: "Merge", agent: "fake", execution: "host", prompt: "Merge", on: {}, safeActions: {},
      extensions: { "github.execution": { readyWhen: "merge-eligible" } } };
    expect(await runtime.registry.eventSources.get("github.pull-request")?.match?.({ id: "ready", type: "github.pull-request", source: "github", repository: "owner/repo",
      timestamp: new Date().toISOString(), data: { number: 42, isPullRequest: true } }, {}, { signal: new AbortController().signal, workflow }))
      .toMatchObject({ kind: "defer", reason: "merge_readiness_ineligible" });
  });

  it("attributes every newly added label and leaves unrelated human and PAT labels actionable", async () => {
    const runtime = await fixture();
    vi.stubGlobal("fetch", vi.fn(async (input: unknown, options: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/user")) return Response.json({ id: 1, login: "maintainer" });
      if (url.endsWith("/issues/42")) return Response.json({ number: 42, labels: [{ name: "existing" }] });
      if (options.method === "GET" && url.includes("/comments")) return Response.json([]);
      return Response.json({ id: 9 });
    }));
    const event: Event = { id: "triage", type: "github.issue", source: "github", timestamp: new Date().toISOString(), repository: "owner/repo", data: { number: 42 } };
    const run: Run = { id: "triage-run", workflowId: "triage.md", repository: "owner/repo", event, status: "running", createdAt: event.timestamp, updatedAt: event.timestamp };
    await runtime.registry.actionDefinitions.get("github.issue.resolve")?.executePrepared({ run, event, repository: "owner/repo", policy: { max: 1 }, logger: runtime.logger },
      { mode: "triage", repository: "owner/repo", number: 42, labels: ["existing", "one", "two"], body: "Triaged.", marker: "<!-- roboplane:triage-run:issue-resolution -->" });
    const payload = (label: string, actor: string) => ({ action: "labeled", repository: { full_name: "owner/repo" }, sender: { login: actor },
      label: { name: label }, issue: { number: 42, state: "open", labels: [{ name: label }] } });
    expect(await deliver(runtime, "issues", payload("one", "maintainer"), "one")).toEqual({ kind: "ignored", reason: "self_mutation" });
    expect(await deliver(runtime, "issues", payload("two", "maintainer"), "two")).toEqual({ kind: "ignored", reason: "self_mutation" });
    expect(await deliver(runtime, "issues", payload("existing", "maintainer"), "existing")).toMatchObject({ kind: "event" });
    expect(await deliver(runtime, "issues", payload("one", "human"), "human")).toMatchObject({ kind: "event" });
    expect(await deliver(runtime, "issues", payload("different", "maintainer"), "different")).toMatchObject({ kind: "event" });
  });

  it("reports unsupported transport actions without contacting GitHub", async () => {
    const runtime = await fixture({ polling: true });
    await runtime.registry.eventSources.get("github.check")?.updateSubscriptions?.("github.check", [
      { type: "github.check", workflowId: "checks.md", repository: "owner/repo", config: { events: ["completed"] } },
    ]);
    const output = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await runtime.registry.extensionCommands.get("github")?.run(["triggers", "--json"]);
      expect(JSON.parse(String(output.mock.calls[0]?.[0]))).toMatchObject({ transport: "polling", subscriptions: [{ workflowId: "checks.md",
        warnings: ["github.check.completed is not delivered by the selected polling transport"] }] });
      expect(globalThis.fetch).not.toHaveBeenCalled();
    } finally { output.mockRestore(); }
  });

  it("coalesces equivalent queued work through the real runtime before a second workspace or agent starts", async () => {
    let release: () => void = () => {};
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const agent = vi.fn(async () => { await blocked; return { version: 1 as const, outcome: "no-op" as const }; });
    const create = vi.fn((home: string) => ({ path: home }));
    const fake: Extension = { name: "fake", setup(api) {
      fs.writeFileSync(path.join(api.paths.workflows, "qa.md"), "---\nrepository: owner/repo\nworkspace: fake\nagent: fake\non:\n  github.pull-request: {}\ngithub.execution:\n  oncePerHead: true\n---\nInspect this snapshot.\n");
      api.agents.register("fake", { run: agent });
      api.executions.register("host", { isolation: "none", open: () => ({ process: api.process, close() {} }) });
      api.workspaces.register("fake", { create: () => create(api.paths.home), attest: () => ({ version: 1, kind: "directory", path: api.paths.home,
        revision: "scratch", clean: true, verifiedAt: new Date().toISOString() }) });
    } };
    const runtime = await fixture({ publishGuard: { enabled: false }, failureReports: { enabled: false } }, [fake]);
    expect(runtime.workflowErrors).toEqual([]);
    const event: Event = { id: "first-snapshot", type: "github.pull-request", source: "github", timestamp: new Date().toISOString(), repository: "owner/repo",
      actor: { name: "human" }, data: { action: "opened", number: 42, isPullRequest: true } };
    await runtime.receive(event);
    await vi.waitFor(() => expect(agent).toHaveBeenCalledTimes(1));
    const second = await runtime.receive({ ...event, id: "second-snapshot", data: { action: "labeled", number: 42, isPullRequest: true } });
    expect(second.runIds).toHaveLength(1);
    release(); await runtime.idle();
    expect(agent).toHaveBeenCalledTimes(1); expect(create).toHaveBeenCalledTimes(1);
    expect(runtime.database.getRun(second.runIds?.[0] ?? "")?.outcome).toMatchObject({ outcome: "no-op", reason: "work_already_handled" });
  });
});
