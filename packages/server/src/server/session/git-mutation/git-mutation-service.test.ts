import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pino } from "pino";
import { afterEach, describe, expect, test } from "vitest";
import type {
  WorkspaceGitBranchValidationResult,
  WorkspaceGitRuntimeSnapshot,
  WorkspaceGitService,
} from "../../workspace-git-service.js";
import { createGitMutationService } from "./git-mutation-service.js";

// The production module reads only WorkspaceGitService.{validateBranchRef,getSnapshot,
// hasLocalBranch,invalidateForge}. The fake below implements exactly that slice as an
// in-memory adapter; the happy-path tests cross the real git boundary against a temp repo,
// since that is where checkoutResolvedBranch / `git checkout -b` actually run.

type GitSource = Pick<
  WorkspaceGitService,
  "validateBranchRef" | "getSnapshot" | "hasLocalBranch" | "invalidateForge"
>;

const logger = pino({ level: "silent" });

interface FakeGitOptions {
  resolution?: WorkspaceGitBranchValidationResult;
  isDirty?: boolean | null;
  branchExists?: boolean;
  getSnapshotThrows?: boolean;
}

function createFakeGit(opts: FakeGitOptions = {}) {
  const resolution = opts.resolution ?? { kind: "local", name: "main" };
  const isDirty = opts.isDirty ?? false;
  const branchExists = opts.branchExists ?? false;
  const snapshotCalls: Array<{ cwd: string; force: boolean; reason?: string }> = [];
  const invalidateCalls: Array<{ cwd: string }> = [];
  const git: GitSource = {
    async validateBranchRef() {
      return resolution;
    },
    async getSnapshot(cwd, options) {
      snapshotCalls.push({ cwd, force: options?.force === true, reason: options?.reason });
      if (opts.getSnapshotThrows) {
        throw new Error("snapshot boom");
      }
      return { git: { isDirty } } as unknown as WorkspaceGitRuntimeSnapshot;
    },
    async hasLocalBranch() {
      return branchExists;
    },
    invalidateForge(cwd) {
      invalidateCalls.push({ cwd });
    },
  };
  return { git, snapshotCalls, invalidateCalls };
}

function buildService(gitOptions: FakeGitOptions = {}) {
  const { git, snapshotCalls, invalidateCalls } = createFakeGit(gitOptions);
  const service = createGitMutationService({ workspaceGitService: git, logger });
  return { service, snapshotCalls, invalidateCalls };
}

const tempRepos: string[] = [];

function initRepo(extraBranch?: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "git-mutation-")));
  tempRepos.push(dir);
  const run = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
  run("init", "-b", "main");
  run("config", "user.email", "test@example.com");
  run("config", "user.name", "Mixer Test");
  writeFileSync(join(dir, "README.md"), "hello\n");
  run("add", "-A");
  run("commit", "-m", "init");
  if (extraBranch) {
    run("branch", extraBranch);
  }
  return dir;
}

function headBranch(dir: string): string {
  return execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: dir }).toString().trim();
}

// A clone whose local branch tracks origin/main. Upstream inheritance only shows up
// against a real remote, so these fixtures cross the git boundary like the happy paths above.
function initClonedRepo(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "git-mutation-clone-")));
  tempRepos.push(root);
  const remote = join(root, "remote.git");
  const seed = join(root, "seed");
  const work = join(root, "work");
  function run(cwd: string, ...args: string[]): void {
    execFileSync("git", args, { cwd, stdio: "pipe" });
  }
  execFileSync("git", ["init", "--bare", "-b", "main", remote], { cwd: root, stdio: "pipe" });
  execFileSync("git", ["clone", "--quiet", remote, seed], { cwd: root, stdio: "pipe" });
  run(seed, "config", "user.email", "test@example.com");
  run(seed, "config", "user.name", "Mixer Test");
  writeFileSync(join(seed, "README.md"), "hello\n");
  run(seed, "add", "-A");
  run(seed, "commit", "-m", "init");
  run(seed, "push", "--quiet", "-u", "origin", "main");
  execFileSync("git", ["clone", "--quiet", remote, work], { cwd: root, stdio: "pipe" });
  run(work, "config", "user.email", "test@example.com");
  run(work, "config", "user.name", "Mixer Test");
  return work;
}

// Always exits 0 and prints an empty line when the branch has no upstream, so a git or
// process failure surfaces as a throw instead of being read as "no upstream".
function upstreamOf(dir: string, branch: string): string {
  return execFileSync(
    "git",
    ["for-each-ref", "--format=%(upstream:short)", `refs/heads/${branch}`],
    { cwd: dir, stdio: ["pipe", "pipe", "pipe"] },
  )
    .toString()
    .trim();
}

afterEach(() => {
  while (tempRepos.length > 0) {
    const dir = tempRepos.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("checkoutExistingBranch", () => {
  test("rejects an unsafe branch ref before touching git", async () => {
    const { service } = buildService();
    await expect(service.checkoutExistingBranch("/tmp/nope", "bad branch")).rejects.toThrow(
      /Invalid branch/,
    );
  });

  test("rejects when the branch does not resolve", async () => {
    const { service } = buildService({ resolution: { kind: "not-found" } });
    await expect(service.checkoutExistingBranch("/tmp/nope", "missing")).rejects.toThrow(
      /Branch not found: missing/,
    );
  });

  test.each([false, true])(
    "carries compatible local changes across branches (staged: %s)",
    async (staged) => {
      const dir = initRepo("feature");
      execFileSync("git", ["checkout", "feature"], { cwd: dir });
      writeFileSync(join(dir, "feature.txt"), "target branch file\n");
      execFileSync("git", ["add", "feature.txt"], { cwd: dir });
      execFileSync("git", ["commit", "-m", "feature"], { cwd: dir });
      execFileSync("git", ["checkout", "main"], { cwd: dir });
      writeFileSync(join(dir, "README.md"), "local edit\n");
      writeFileSync(join(dir, "untracked.txt"), "local untracked\n");
      if (staged) execFileSync("git", ["add", "README.md"], { cwd: dir });
      const { service } = buildService({
        resolution: { kind: "local", name: "feature" },
        isDirty: true,
      });
      await service.checkoutExistingBranch(dir, "feature");
      expect(headBranch(dir)).toBe("feature");
      expect(readFileSync(join(dir, "README.md"), "utf8")).toBe("local edit\n");
      expect(readFileSync(join(dir, "untracked.txt"), "utf8")).toBe("local untracked\n");
      expect(readFileSync(join(dir, "feature.txt"), "utf8")).toBe("target branch file\n");
      const cached = execFileSync("git", ["diff", "--cached", "--name-only"], { cwd: dir })
        .toString()
        .trim();
      expect(cached).toBe(staged ? "README.md" : "");
      expect(execFileSync("git", ["stash", "list"], { cwd: dir }).toString()).toBe("");
    },
  );

  test.each(["unstaged", "staged", "untracked"])(
    "preserves %s changes when checkout would overwrite them",
    async (state) => {
      const dir = initRepo("feature");
      const filename = state === "untracked" ? "collision.txt" : "README.md";
      execFileSync("git", ["checkout", "feature"], { cwd: dir });
      writeFileSync(join(dir, filename), "target edit\n");
      execFileSync("git", ["add", "-A"], { cwd: dir });
      execFileSync("git", ["commit", "-m", "feature"], { cwd: dir });
      execFileSync("git", ["checkout", "main"], { cwd: dir });
      writeFileSync(join(dir, filename), "local edit\n");
      if (state === "staged") execFileSync("git", ["add", filename], { cwd: dir });
      const { service, invalidateCalls } = buildService({
        resolution: { kind: "local", name: "feature" },
        isDirty: true,
      });
      await expect(service.checkoutExistingBranch(dir, "feature")).rejects.toThrow(
        "would be overwritten by checkout",
      );
      expect(headBranch(dir)).toBe("main");
      expect(readFileSync(join(dir, filename), "utf8")).toBe("local edit\n");
      expect(execFileSync("git", ["stash", "list"], { cwd: dir }).toString()).toBe("");
      expect(invalidateCalls).toEqual([]);
    },
  );

  test("creates a remote tracking branch while preserving compatible local changes", async () => {
    const dir = initClonedRepo();
    writeFileSync(join(dir, "README.md"), "local edit\n");
    const { service } = buildService({
      resolution: { kind: "remote-only", name: "feature", remoteRef: "origin/main" },
      isDirty: true,
    });
    await service.checkoutExistingBranch(dir, "feature");
    expect(headBranch(dir)).toBe("feature");
    expect(readFileSync(join(dir, "README.md"), "utf8")).toBe("local edit\n");
    expect(upstreamOf(dir, "feature")).toBe("origin/main");
  });

  test("a snapshot refresh failure does not prevent a valid checkout", async () => {
    const dir = initRepo("feature");
    const { service } = buildService({
      resolution: { kind: "local", name: "feature" },
      getSnapshotThrows: true,
    });
    await service.checkoutExistingBranch(dir, "feature");
    expect(headBranch(dir)).toBe("feature");
  });

  test("checks out the branch and invalidates github (real repo)", async () => {
    const dir = initRepo("feature");
    const { service, snapshotCalls, invalidateCalls } = buildService({
      resolution: { kind: "local", name: "feature" },
    });
    const result = await service.checkoutExistingBranch(dir, "feature");
    expect(result.source).toBe("local");
    expect(headBranch(dir)).toBe("feature");
    expect(invalidateCalls).toEqual([{ cwd: dir }]);
    expect(snapshotCalls).toContainEqual({ cwd: dir, force: true, reason: "switch-branch" });
  });
});

describe("createBranchFromBase", () => {
  test("rejects an unsafe new-branch ref before touching git", async () => {
    const { service } = buildService({ resolution: { kind: "local", name: "main" } });
    await expect(
      service.createBranchFromBase({
        cwd: "/tmp/nope",
        baseBranch: "main",
        newBranchName: "bad x",
      }),
    ).rejects.toThrow(/Invalid new/);
  });

  test("rejects when the base branch does not resolve", async () => {
    const { service } = buildService({ resolution: { kind: "not-found" } });
    await expect(
      service.createBranchFromBase({ cwd: "/tmp/nope", baseBranch: "main", newBranchName: "feat" }),
    ).rejects.toThrow(/Base branch not found: main/);
  });

  test("rejects when the new branch already exists", async () => {
    const { service } = buildService({
      resolution: { kind: "local", name: "main" },
      branchExists: true,
    });
    await expect(
      service.createBranchFromBase({ cwd: "/tmp/nope", baseBranch: "main", newBranchName: "feat" }),
    ).rejects.toThrow(/Branch already exists: feat/);
  });

  test("creates a new branch while preserving staged and untracked changes", async () => {
    const dir = initRepo();
    writeFileSync(join(dir, "README.md"), "local edit\n");
    execFileSync("git", ["add", "README.md"], { cwd: dir });
    writeFileSync(join(dir, "untracked.txt"), "local untracked\n");
    const { service } = buildService({
      resolution: { kind: "local", name: "main" },
      isDirty: true,
    });
    await service.createBranchFromBase({ cwd: dir, baseBranch: "main", newBranchName: "feature" });
    expect(headBranch(dir)).toBe("feature");
    expect(readFileSync(join(dir, "README.md"), "utf8")).toBe("local edit\n");
    expect(readFileSync(join(dir, "untracked.txt"), "utf8")).toBe("local untracked\n");
    expect(
      execFileSync("git", ["diff", "--cached", "--name-only"], { cwd: dir }).toString().trim(),
    ).toBe("README.md");
    expect(upstreamOf(dir, "feature")).toBe("");
  });

  test("creates the branch from base and refreshes without github invalidation (real repo)", async () => {
    const dir = initRepo();
    const { service, snapshotCalls, invalidateCalls } = buildService({
      resolution: { kind: "local", name: "main" },
    });
    await service.createBranchFromBase({ cwd: dir, baseBranch: "main", newBranchName: "feature2" });
    expect(headBranch(dir)).toBe("feature2");
    expect(invalidateCalls).toEqual([]);
    expect(snapshotCalls).toContainEqual({ cwd: dir, force: true, reason: "create-branch" });
  });

  // https://github.com/matthewcalcagno/mixer/issues/5213 — a branch that tracks origin/main sends the
  // next push to main: `git push` under push.default=tracking and Mixer's own push both read
  // branch.<name>.merge. A branch Mixer creates must carry no upstream, exactly as the worktree
  // path already guarantees with `git worktree add -b <branch> --no-track <base>`.
  test("leaves no upstream when the base is a remote-tracking ref (real repo)", async () => {
    const dir = initClonedRepo();
    const { service } = buildService({
      resolution: { kind: "remote-only", name: "main", remoteRef: "origin/main" },
    });
    await service.createBranchFromBase({
      cwd: dir,
      baseBranch: "origin/main",
      newBranchName: "feature-from-remote",
    });
    expect(headBranch(dir)).toBe("feature-from-remote");
    expect(upstreamOf(dir, "feature-from-remote")).toBe("");
  });

  test("leaves no upstream when git is configured to inherit tracking (real repo)", async () => {
    const dir = initClonedRepo();
    execFileSync("git", ["config", "branch.autoSetupMerge", "inherit"], {
      cwd: dir,
      stdio: "pipe",
    });
    const { service } = buildService({ resolution: { kind: "local", name: "main" } });
    await service.createBranchFromBase({
      cwd: dir,
      baseBranch: "main",
      newBranchName: "feature-inherited",
    });
    expect(headBranch(dir)).toBe("feature-inherited");
    expect(upstreamOf(dir, "feature-inherited")).toBe("");
  });
});

describe("notifyGitMutation", () => {
  test("invalidates github and force-refreshes when invalidateForge is set", async () => {
    const { service, snapshotCalls, invalidateCalls } = buildService();
    await service.notifyGitMutation("/tmp/repo", "commit-changes", { invalidateForge: true });
    expect(invalidateCalls).toEqual([{ cwd: "/tmp/repo" }]);
    expect(snapshotCalls).toEqual([{ cwd: "/tmp/repo", force: true, reason: "commit-changes" }]);
  });

  test("force-refreshes without invalidating github by default", async () => {
    const { service, snapshotCalls, invalidateCalls } = buildService();
    await service.notifyGitMutation("/tmp/repo", "pull");
    expect(invalidateCalls).toEqual([]);
    expect(snapshotCalls).toEqual([{ cwd: "/tmp/repo", force: true, reason: "pull" }]);
  });

  test("swallows a snapshot-refresh failure", async () => {
    const { service } = buildService({ getSnapshotThrows: true });
    await expect(service.notifyGitMutation("/tmp/repo", "pull")).resolves.toBeUndefined();
  });
});
