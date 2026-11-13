import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import type { Workspace } from "@mixer/automations-sdk";
import { afterEach, describe, expect, it } from "vitest";
import { installPublishGuard, readRunCapability } from "./publication.js";

const temporary: string[] = [];
afterEach(() => { for (const root of temporary.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "roboplane-pr-promotion-"));
  temporary.push(root);
  const repository = path.join(root, "repo");
  const remote = path.join(root, "remote.git");
  const state = path.join(root, "state");
  const git = (...args: string[]) => execFileSync("git", ["-C", repository, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  execFileSync("git", ["init", "--bare", remote], { stdio: "ignore" });
  execFileSync("git", ["init", "-b", "main", repository], { stdio: "ignore" });
  git("config", "user.name", "test");
  git("config", "user.email", "test@example.com");
  git("commit", "--allow-empty", "-m", "base");
  const baseRevision = git("rev-parse", "HEAD");
  git("remote", "add", "origin", remote);
  git("push", "origin", "main");
  git("switch", "-c", "bugfix/ISSUE-8");
  git("commit", "--allow-empty", "-m", "draft bootstrap");
  const head = git("rev-parse", "HEAD");
  const workspace: Workspace = { path: repository };
  installPublishGuard({ workspace, stateDirectory: state, capability: {
    version: 1, runId: "rp_promotion", repository: "owner/repo", mode: "new-branch", remote,
    baseRevision, baseBranch: "main", maxChangedFiles: 10,
    // The extension attests this identity against the configured PAT before execution.
    authenticatedLogin: "maintainer",
    case: { kind: "issue", number: 8 },
  } });
  const bin = path.join(root, "real-bin");
  fs.mkdirSync(bin);
  const responseFile = path.join(root, "response.json");
  const callsFile = path.join(root, "calls.jsonl");
  fs.writeFileSync(path.join(bin, "gh"), `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(callsFile)}, JSON.stringify(args) + "\\n");
const response = JSON.parse(fs.readFileSync(${JSON.stringify(responseFile)}, "utf8"));
if (args[0] === "api") {
  if (response.readFailure) process.exit(1);
  process.stdout.write(JSON.stringify(response.prs));
} else if (args[0] === "pr" && args[1] === "create") {
  process.stdout.write("https://github.com/owner/repo/pull/42\\n");
  process.exit(response.createFailure ? 1 : 0);
} else if (args[0] !== "pr" || !["edit", "ready"].includes(args[1])) process.exit(2);
`, { mode: 0o700 });
  const env = { ...process.env, ...workspace.environment, MIXER_AUTOMATIONS_REAL_PATH: `${bin}${path.delimiter}${process.env.PATH}` };
  const invoke = (tool: string, args: string[]) => spawnSync(path.join(repository, ".git/roboplane-guard/bin", tool), args, {
    cwd: repository, env, encoding: "utf8",
  });
  const push = invoke("git", ["push", "-u", "origin", "bugfix/ISSUE-8"]);
  expect(push.status, push.stderr).toBe(0);
  const pr = { number: 42, state: "open", user: { login: "maintainer" },
    head: { ref: "bugfix/ISSUE-8", sha: head, repo: { full_name: "owner/repo" } },
    base: { ref: "main", repo: { full_name: "owner/repo" } } };
  const respond = (response: object) => fs.writeFileSync(responseFile, JSON.stringify(response));
  respond({ prs: [pr] });
  return { invoke, git, head, state, pr, respond, callsFile, capability: () => readRunCapability(state, "rp_promotion") };
}

describe("same-run PR capability promotion", () => {
  it("creates a draft, edits it, pushes a fix and marks only that PR ready in one run", () => {
    const f = fixture();
    const created = f.invoke("gh", ["pr", "create", "--draft", "--title", "Fix", "--body", "Pending"]);
    expect(created.status, created.stderr).toBe(0);
    const edited = f.invoke("gh", ["pr", "edit", "42", "--body", "Implemented"]);
    expect(edited.status, edited.stderr).toBe(0);
    f.git("commit", "--allow-empty", "-m", "fix");
    const pushed = f.invoke("git", ["push"]);
    expect(pushed.status, pushed.stderr).toBe(0);
    const ready = f.invoke("gh", ["pr", "ready", "42"]);
    expect(ready.status, ready.stderr).toBe(0);
    expect(f.capability()).toMatchObject({ mode: "owned-pr", prNumber: 42, prAuthor: "maintainer",
      allowedBranch: "bugfix/ISSUE-8", activatedRemoteSha: f.head,
      expectedRemoteSha: f.git("rev-parse", "HEAD"), publicationChain: [f.head, f.git("rev-parse", "HEAD")],
      case: { kind: "issue", number: 8 } });
    for (const command of ["edit", "ready"]) {
      expect(f.invoke("gh", ["pr", command, "43"]).status).toBe(73);
      expect(f.invoke("gh", ["pr", command, "42", "--repo", "other/repo"]).status).toBe(73);
    }
    expect(f.invoke("gh", ["pr", "create", "--title", "Another", "--body", "No"]).status).toBe(73);
    expect(f.invoke("gh", ["pr", "merge", "42"]).status).toBe(73);
    expect(f.invoke("gh", ["pr", "edit", "42", "--base", "other"]).status).toBe(73);
  }, 15_000);

  const invalidResponses: Array<{ name: string; response: (pr: ReturnType<typeof fixture>["pr"]) => object }> = [
    { name: "another author", response: pr => ({ prs: [{ ...pr, user: { login: "someone-else" } }] }) },
    { name: "a fork head", response: pr => ({ prs: [{ ...pr, head: { ...pr.head, repo: { full_name: "other/repo" } } }] }) },
    { name: "another base repository", response: pr => ({ prs: [{ ...pr, base: { ...pr.base, repo: { full_name: "other/repo" } } }] }) },
    { name: "another head branch", response: pr => ({ prs: [{ ...pr, head: { ...pr.head, ref: "unrelated" } }] }) },
    { name: "a moved head", response: pr => ({ prs: [{ ...pr, head: { ...pr.head, sha: "f".repeat(40) } }] }) },
    { name: "another base branch", response: pr => ({ prs: [{ ...pr, base: { ...pr.base, ref: "other" } }] }) },
    { name: "a closed PR", response: pr => ({ prs: [{ ...pr, state: "closed" }] }) },
    { name: "no PR", response: () => ({ prs: [] }) },
    { name: "ambiguous PRs", response: pr => ({ prs: [pr, { ...pr, number: 43 }] }) },
    { name: "failed read-back", response: () => ({ readFailure: true }) },
    { name: "failed creation", response: pr => ({ prs: [pr], createFailure: true }) },
  ];
  it.each(invalidResponses)("does not promote for $name or permit a duplicate create", ({ response }) => {
    const f = fixture();
    f.respond(response(f.pr));
    const created = f.invoke("gh", ["pr", "create", "--draft", "--title", "Fix", "--body", "Pending"]);
    expect(created.status).not.toBe(0);
    expect(f.capability()).toMatchObject({ mode: "new-branch", pending: { operation: "pr-create", head: f.head } });
    expect(f.capability()?.prNumber).toBeUndefined();
    expect(f.invoke("gh", ["pr", "edit", "42", "--body", "Must not publish"]).status).toBe(73);
    expect(f.invoke("gh", ["pr", "ready", "42"]).status).toBe(73);
    expect(f.invoke("gh", ["pr", "create", "--title", "Duplicate", "--body", "No"]).status).toBe(73);
    const calls: string[][] = fs.readFileSync(f.callsFile, "utf8").trim().split("\n").map(line => JSON.parse(line));
    expect(calls.filter(args => args[0] === "pr").map(args => args[1])).toEqual(["create"]);
  }, 15_000);
});
