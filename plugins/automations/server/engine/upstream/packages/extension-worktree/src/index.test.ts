import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import type { MixerAutomationsAPI, Run, WorkspaceProvider } from "@mixer/automations-sdk";
import worktree from "./index.js";

const temporary: string[] = [];
afterEach(() => { for (const item of temporary.splice(0)) fs.rmSync(item, { recursive: true, force: true }); });

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

const logger = { debug() {}, info() {}, warn() {}, error() {}, child() { return this; } };

function processRunner(after?: (options: { command: string; args?: readonly string[] }, result: { exitCode: number; stdout: string; stderr: string }) => void) {
  return { run: async (options: { command: string; args?: readonly string[]; env?: Record<string, string> }) => {
    try {
      const result = {
        exitCode: 0,
        stdout: execFileSync(options.command, [...(options.args ?? [])], { encoding: "utf8", env: { ...process.env, ...options.env } }),
        stderr: "",
      };
      after?.(options, result);
      return result;
    } catch (error) {
      const failure = error as { status?: number; stdout?: Buffer | string; stderr?: Buffer | string };
      return { exitCode: failure.status ?? 1, stdout: String(failure.stdout ?? ""), stderr: String(failure.stderr ?? "") };
    }
  } };
}

async function fixture(after?: Parameters<typeof processRunner>[0]) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "roboplane-worktree-"));
  temporary.push(root);
  const source = path.join(root, "source");
  const remote = path.join(root, "owner", "repo.git");
  const workspaces = path.join(root, "workspaces");
  fs.mkdirSync(source, { recursive: true });
  fs.mkdirSync(path.dirname(remote), { recursive: true });
  fs.mkdirSync(workspaces, { recursive: true });
  execFileSync("git", ["init", "--bare", remote]);
  execFileSync("git", ["init", source]);
  git(source, "config", "user.name", "test");
  git(source, "config", "user.email", "test@example.com");
  fs.writeFileSync(path.join(source, "file.txt"), "before\n");
  git(source, "add", ".");
  git(source, "commit", "-m", "initial");
  const revision = git(source, "rev-parse", "HEAD");
  git(source, "remote", "add", "origin", remote);
  git(source, "push", "origin", "HEAD:refs/heads/main");
  let provider: WorkspaceProvider | undefined;
  const api = {
    config: { get: () => ({ cloneBaseUrl: new URL(`file://${root}`).toString() }) },
    paths: { workspaces },
    process: processRunner(after),
    workspaces: { register(_name: string, value: WorkspaceProvider) { provider = value; } },
  } as unknown as MixerAutomationsAPI;
  await worktree.setup!(api);
  const run = (id: string): Run => ({ id, workflowId: "task.md", repository: "owner/repo", event: {} as Run["event"], status: "running", createdAt: "now", updatedAt: "now" });
  const context = (id: string) => ({ run: run(id), repository: "owner/repo", source: { repository: "owner/repo", revision }, signal: new AbortController().signal, logger });
  return { root, remote, workspaces, revision, provider: provider!, context };
}

describe("worktree workspace", () => {
  it("checks out the exact source SHA and collects changed files", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "roboplane-worktree-"));
    temporary.push(root);
    const source = path.join(root, "source");
    const remote = path.join(root, "owner", "repo.git");
    const workspaces = path.join(root, "workspaces");
    fs.mkdirSync(source, { recursive: true });
    fs.mkdirSync(path.dirname(remote), { recursive: true });
    fs.mkdirSync(workspaces, { recursive: true });
    execFileSync("git", ["init", "--bare", remote]);
    execFileSync("git", ["init", source]);
    git(source, "config", "user.name", "test");
    git(source, "config", "user.email", "test@example.com");
    fs.writeFileSync(path.join(source, "file.txt"), "before\n");
    fs.mkdirSync(path.join(source, "code", "apps", "storybook", ".storybook"), { recursive: true });
    fs.writeFileSync(path.join(source, "code", "apps", "storybook", ".storybook", "main.js"), "export default {};\n");
    fs.symlinkSync("apps/storybook/.storybook", path.join(source, "code", ".storybook"));
    git(source, "add", ".");
    git(source, "commit", "-m", "initial");
    const revision = git(source, "rev-parse", "HEAD");
    git(source, "remote", "add", "origin", remote);
    git(source, "push", "origin", "HEAD:refs/heads/main");
    const process = { run: async (options: { command: string; args?: readonly string[] }) => {
      try {
        return { exitCode: 0, stdout: execFileSync(options.command, [...(options.args ?? [])], { encoding: "utf8" }), stderr: "" };
      } catch (error) {
        const failure = error as { status?: number; stdout?: Buffer | string; stderr?: Buffer | string };
        return { exitCode: failure.status ?? 1, stdout: String(failure.stdout ?? ""), stderr: String(failure.stderr ?? "") };
      }
    } };
    let provider: WorkspaceProvider | undefined;
    const api = {
      config: { get: () => ({ cloneBaseUrl: new URL(`file://${root}`).toString() }) },
      paths: { workspaces },
      process,
      workspaces: { register(_name: string, value: WorkspaceProvider) { provider = value; } },
    } as unknown as MixerAutomationsAPI;
    await worktree.setup!(api);
    const run: Run = { id: "run-exact", workflowId: "task.md", repository: "owner/repo", event: {} as Run["event"], status: "running", createdAt: "now", updatedAt: "now" };
    expect(provider).toBeDefined();
    const workspace = await provider!.create({ run, repository: "owner/repo", source: { repository: "owner/repo", revision }, signal: new AbortController().signal, logger: { debug() {}, info() {}, warn() {}, error() {}, child() { return this; } } });
    expect(git(workspace.path, "rev-parse", "HEAD")).toBe(revision);
    expect(git(workspace.path, "remote", "get-url", "origin")).toBe(new URL(`file://${root}/owner/repo.git`).toString());
    expect(fs.statSync(path.join(workspace.path, ".git")).isDirectory()).toBe(true);
    expect(fs.lstatSync(path.join(workspace.path, "code", ".storybook")).isSymbolicLink()).toBe(true);
    await expect(provider!.attest(
      { run, repository: "owner/repo", source: { repository: "owner/repo", revision }, signal: new AbortController().signal, logger: { debug() {}, info() {}, warn() {}, error() {}, child() { return this; } } },
      workspace,
    )).resolves.toMatchObject({ path: fs.realpathSync(workspace.path), repository: "owner/repo", revision, clean: true });
    fs.writeFileSync(path.join(workspace.path, "file.txt"), "after\n");
    const artifact = await provider!.collect!(
      { run, repository: "owner/repo", source: { repository: "owner/repo", revision }, signal: new AbortController().signal, logger: { debug() {}, info() {}, warn() {}, error() {}, child() { return this; } } },
      workspace,
    );
    expect(artifact.baseRevision).toBe(revision);
    expect(artifact.files).toMatchObject([{ path: "file.txt", operation: "update" }]);
    fs.unlinkSync(path.join(workspace.path, "code", ".storybook"));
    await expect(provider!.collect!(
      { run, repository: "owner/repo", source: { repository: "owner/repo", revision }, signal: new AbortController().signal, logger: { debug() {}, info() {}, warn() {}, error() {}, child() { return this; } } },
      workspace,
    )).rejects.toThrow("Workspace artifact rejects changed symlink: code/.storybook");
    await provider!.cleanup?.({ run, repository: "owner/repo", source: { repository: "owner/repo", revision }, signal: new AbortController().signal, logger: { debug() {}, info() {}, warn() {}, error() {}, child() { return this; } } }, workspace);
    expect(fs.existsSync(workspace.path)).toBe(false);
  });

  it("rebuilds an unusable mirror once and checks out the exact revision", async () => {
    let corruptAfterFetch = false;
    let cache = "";
    let mirrorClones = 0;
    const setup = await fixture((options) => {
      if (options.args?.[0] === "clone" && options.args[1] === "--mirror") mirrorClones++;
      if (!corruptAfterFetch || !options.args?.includes("fetch")) return;
      corruptAfterFetch = false;
      const pack = fs.readdirSync(path.join(cache, "objects", "pack")).find((name) => name.endsWith(".pack"));
      expect(pack).toBeDefined();
      const packPath = path.join(cache, "objects", "pack", pack!);
      fs.chmodSync(packPath, 0o600);
      fs.truncateSync(packPath, 32);
    });
    const first = await setup.provider.create(setup.context("run-first"));
    await setup.provider.cleanup?.(setup.context("run-first"), first);
    cache = path.join(setup.workspaces, ".cache", "owner--repo.git");
    corruptAfterFetch = true;

    const recovered = await setup.provider.create(setup.context("run-recovered"));

    expect(git(recovered.path, "rev-parse", "HEAD")).toBe(setup.revision);
    expect(git(recovered.path, "status", "--porcelain")).toBe("");
    expect(git(recovered.path, "show", "HEAD:file.txt")).toBe("before");
    expect(mirrorClones).toBe(2);
  });

  it("does not let an invalid cached ref poison later runs", async () => {
    const setup = await fixture();
    const first = await setup.provider.create(setup.context("run-first"));
    await setup.provider.cleanup?.(setup.context("run-first"), first);
    const cache = path.join(setup.workspaces, ".cache", "owner--repo.git");
    fs.writeFileSync(path.join(cache, "refs", "heads", "broken"), `${"f".repeat(40)}\n`);

    const recovered = await setup.provider.create(setup.context("run-ref-recovered"));

    expect(git(recovered.path, "rev-parse", "HEAD")).toBe(setup.revision);
    expect(fs.existsSync(path.join(cache, "refs", "heads", "broken"))).toBe(false);
  });

  it("serializes concurrent preparation using the same mirror", async () => {
    const setup = await fixture();

    const [first, second] = await Promise.all([
      setup.provider.create(setup.context("run-concurrent-a")),
      setup.provider.create(setup.context("run-concurrent-b")),
    ]);

    expect(git(first.path, "rev-parse", "HEAD")).toBe(setup.revision);
    expect(git(second.path, "rev-parse", "HEAD")).toBe(setup.revision);
  });

  it("reports both failures and removes a partial target when rebuilding fails", async () => {
    const setup = await fixture();
    const first = await setup.provider.create(setup.context("run-first"));
    await setup.provider.cleanup?.(setup.context("run-first"), first);
    const cache = path.join(setup.workspaces, ".cache", "owner--repo.git");
    fs.writeFileSync(path.join(cache, "refs", "heads", "broken"), `${"f".repeat(40)}\n`);
    fs.renameSync(setup.remote, `${setup.remote}.unavailable`);

    await expect(setup.provider.create(setup.context("run-failed"))).rejects.toThrow(
      /Git workspace preparation failed using cached mirror:[\s\S]*mirror rebuild failed:/,
    );
    expect(fs.existsSync(path.join(setup.workspaces, "run-failed"))).toBe(false);
    expect(fs.existsSync(cache)).toBe(true);
  });
});
