// POSIX-only: git worktree and teardown shell fixtures
/* eslint-disable max-nested-callbacks */
import { validateWorktreePath } from "./worktree-path.js";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  createWorktree as createWorktreePrimitive,
  deriveWorktreeProjectHash,
  deleteMixerWorktree,
  InvalidGitBranchNameError,
  getScriptConfigs,
  getWorktreeSetupCommands,
  getWorktreeTerminalSpecs,
  getWorktreeTeardownCommands,
  isServiceScript,
  isMixerOwnedWorktreeCwd,
  listMixerWorktrees,
  readMixerConfig,
  resolveWorktreeRuntimeEnv,
  type WorktreeSetupCommandProgressEvent,
  runWorktreeSetupCommands,
  type CreateWorktreeOptions,
  type WorktreeConfig,
} from "./worktree";
import type { MixerConfig } from "@mixer/protocol/mixer-config-schema";
import {
  getMixerWorktreeMetadataPath,
  readMixerWorktreeMetadata,
  writeMixerWorktreeMetadata,
  writeMixerWorktreeRuntimeMetadata,
  writeMixerWorktreeFirstAgentBranchAutoNameMetadata,
} from "./worktree-metadata.js";
import {
  getCheckoutDiff,
  getCheckoutStatus,
  listCheckoutCommits,
  mergeFromBase,
  mergeToBase,
} from "./checkout-git.js";
import { execFileSync } from "child_process";
import { isPlatform } from "../test-utils/platform.js";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  existsSync,
  realpathSync,
  writeFileSync,
  readFileSync,
  chmodSync,
  lstatSync,
  readlinkSync,
  symlinkSync,
} from "fs";
import { delimiter, dirname, join } from "path";
import { tmpdir } from "os";
import net from "node:net";

async function loadConfigForTest(repoRoot: string): Promise<MixerConfig | null> {
  const result = await readMixerConfig(repoRoot);
  return result.ok ? result.config : null;
}

interface LegacyCreateWorktreeTestOptions {
  branchName: string;
  cwd: string;
  baseBranch: string;
  worktreeSlug: string;

  mixerHome?: string;
  worktreesRoot?: string;
}

function createLegacyWorktreeForTest(
  options: CreateWorktreeOptions | LegacyCreateWorktreeTestOptions,
): Promise<WorktreeConfig> {
  if ("source" in options) {
    return createWorktreePrimitive(options);
  }

  return createWorktreePrimitive({
    cwd: options.cwd,
    worktreeSlug: options.worktreeSlug,
    source: {
      kind: "branch-off",
      baseBranch: options.baseBranch,
      branchName: options.branchName,
    },

    mixerHome: options.mixerHome,
    worktreesRoot: options.worktreesRoot,
  });
}

describe.skipIf(isPlatform("win32"))("worktree POSIX-only", () => {
  describe("createWorktree", () => {
    let tempDir: string;
    let repoDir: string;
    let mixerHome: string;

    beforeEach(() => {
      // Use realpathSync to resolve symlinks (e.g., /var -> /private/var on macOS)
      tempDir = realpathSync(mkdtempSync(join(tmpdir(), "worktree-test-")));
      repoDir = join(tempDir, "test-repo");
      mixerHome = join(tempDir, "mixer-home");

      // Create a git repo with an initial commit
      mkdirSync(repoDir, { recursive: true });
      execFileSync("git", ["init", "-b", "main"], { cwd: repoDir });
      execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: repoDir });
      execFileSync("git", ["config", "user.name", "Test"], { cwd: repoDir });
      writeFileSync(join(repoDir, "file.txt"), "hello\n");
      execFileSync("git", ["add", "."], { cwd: repoDir });
      execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-m", "initial"], {
        cwd: repoDir,
      });
    });

    afterEach(() => {
      rmSync(tempDir, { recursive: true, force: true });
    });

    it("creates a worktree for the current branch (main)", async () => {
      const projectHash = await deriveWorktreeProjectHash(repoDir);
      const result = await createLegacyWorktreeForTest({
        branchName: "main",
        cwd: repoDir,
        baseBranch: "main",
        worktreeSlug: "hello-world",
        mixerHome,
      });

      expect(result.worktreePath).toBe(join(mixerHome, "worktrees", projectHash, "hello-world"));
      expect(existsSync(result.worktreePath)).toBe(true);
      expect(existsSync(join(result.worktreePath, "file.txt"))).toBe(true);
      const metadataPath = await getMixerWorktreeMetadataPath(result.worktreePath);
      expect(existsSync(metadataPath)).toBe(true);
      const metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
      expect(metadata).toMatchObject({
        version: 1,
        baseRefName: "main",
        changeRequestLookupTarget: { headRef: "hello-world", localBranchName: "hello-world" },
      });
    });

    it("creates and owns worktrees under a configured root", async () => {
      const worktreesRoot = join(tempDir, "custom-worktrees");
      const projectHash = await deriveWorktreeProjectHash(repoDir);
      const result = await createLegacyWorktreeForTest({
        branchName: "custom-root",
        cwd: repoDir,
        baseBranch: "main",
        worktreeSlug: "custom-root",
        mixerHome,
        worktreesRoot,
      });

      expect(result.worktreePath).toBe(join(worktreesRoot, projectHash, "custom-root"));
      await expect(
        isMixerOwnedWorktreeCwd(result.worktreePath, { mixerHome, worktreesRoot }),
      ).resolves.toMatchObject({ allowed: true, worktreeRoot: join(worktreesRoot, projectHash) });
      await expect(
        isMixerOwnedWorktreeCwd(result.worktreePath, { mixerHome }),
      ).resolves.toMatchObject({ allowed: true, worktreePath: result.worktreePath });

      const worktrees = await listMixerWorktrees({ cwd: repoDir, mixerHome, worktreesRoot });
      expect(worktrees.map((entry) => entry.path)).toContain(result.worktreePath);

      await deleteMixerWorktree({
        cwd: repoDir,
        worktreePath: result.worktreePath,
        mixerHome,
        worktreesBaseRoot: worktreesRoot,
      });
      expect(existsSync(result.worktreePath)).toBe(false);
    });

    it.skip("detects mixer-owned worktrees across realpath differences (macOS /var vs /private/var)", async () => {
      // Intentionally create repo using the non-realpath tmpdir() variant (often /var/... on macOS).
      const varTempDir = mkdtempSync(join(tmpdir(), "worktree-realpath-test-"));
      const privateTempDir = realpathSync(varTempDir);
      const varRepoDir = join(varTempDir, "test-repo");
      const varMixerHome = join(varTempDir, "mixer-home");
      mkdirSync(varRepoDir, { recursive: true });
      execFileSync("git", ["init", "-b", "main"], { cwd: varRepoDir });
      execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: varRepoDir });
      execFileSync("git", ["config", "user.name", "Test"], { cwd: varRepoDir });
      writeFileSync(join(varRepoDir, "file.txt"), "hello\n");
      execFileSync("git", ["add", "."], { cwd: varRepoDir });
      execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-m", "initial"], {
        cwd: varRepoDir,
      });

      await createLegacyWorktreeForTest({
        branchName: "main",
        cwd: varRepoDir,
        baseBranch: "main",
        worktreeSlug: "realpath-test",
        mixerHome: varMixerHome,
      });

      const projectHash = await deriveWorktreeProjectHash(varRepoDir);
      const privateWorktreePath = join(
        privateTempDir,
        "mixer-home",
        "worktrees",
        projectHash,
        "realpath-test",
      );
      expect(existsSync(privateWorktreePath)).toBe(true);

      const ownership = await isMixerOwnedWorktreeCwd(privateWorktreePath, {
        mixerHome: varMixerHome,
      });
      expect(ownership.allowed).toBe(true);

      rmSync(varTempDir, { recursive: true, force: true });
    });

    it("reports repoRoot as the repository root for mixer-owned worktrees", async () => {
      const result = await createLegacyWorktreeForTest({
        branchName: "main",
        cwd: repoDir,
        baseBranch: "main",
        worktreeSlug: "repo-root-check",
        mixerHome,
      });

      const ownership = await isMixerOwnedWorktreeCwd(result.worktreePath, { mixerHome });
      expect(ownership.allowed).toBe(true);
      expect(ownership.repoRoot).toBe(repoDir);
    });

    it("treats non-git directories as non-worktrees without throwing", async () => {
      const nonGitDir = join(tempDir, "not-a-repo");
      mkdirSync(nonGitDir, { recursive: true });

      const ownership = await isMixerOwnedWorktreeCwd(nonGitDir, { mixerHome });

      expect(ownership.allowed).toBe(false);
      expect(ownership.worktreePath).toBe(realpathSync(nonGitDir));
    });

    it("creates a worktree with a new branch", async () => {
      const projectHash = await deriveWorktreeProjectHash(repoDir);
      const result = await createLegacyWorktreeForTest({
        cwd: repoDir,
        worktreeSlug: "my-feature",
        source: { kind: "branch-off", baseBranch: "main", branchName: "feature/x" },

        mixerHome,
      });

      expect(result.worktreePath).toBe(join(mixerHome, "worktrees", projectHash, "my-feature"));
      expect(existsSync(result.worktreePath)).toBe(true);

      const currentBranch = execFileSync("git", ["branch", "--show-current"], {
        cwd: result.worktreePath,
      })
        .toString()
        .trim();
      expect(currentBranch).toBe("feature/x");
      execFileSync("git", ["merge-base", "--is-ancestor", "main", "HEAD"], {
        cwd: result.worktreePath,
      });

      const metadataPath = await getMixerWorktreeMetadataPath(result.worktreePath);
      const metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
      expect(metadata).toMatchObject({
        version: 1,
        baseRefName: "main",
        changeRequestLookupTarget: { headRef: "feature/x", localBranchName: "feature/x" },
      });
    });

    it("shows committed changes when checking out an available existing branch", async () => {
      execFileSync("git", ["checkout", "-b", "feature/existing"], { cwd: repoDir });
      writeFileSync(join(repoDir, "file.txt"), "feature change\n");
      execFileSync("git", ["add", "file.txt"], { cwd: repoDir });
      execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-m", "feature change"], {
        cwd: repoDir,
      });
      execFileSync("git", ["checkout", "main"], { cwd: repoDir });

      const result = await createWorktreePrimitive({
        cwd: repoDir,
        worktreeSlug: "existing-feature",
        source: { kind: "checkout-branch", branchName: "feature/existing" },

        mixerHome,
      });
      const status = await getCheckoutStatus(result.worktreePath, { mixerHome });
      const diff = await getCheckoutDiff(result.worktreePath, { mode: "base" }, { mixerHome });
      expect(diff.diff).toContain("+feature change");
      expect(status).toMatchObject({
        isGit: true,
        baseRef: "main",
        aheadBehind: { ahead: 1, behind: 0 },
      });
      expect(result.comparisonBaseRef).toBe("main");
    });

    it("checks out an existing local branch that is not checked out elsewhere", async () => {
      execFileSync("git", ["branch", "dev"], { cwd: repoDir });

      const result = await createLegacyWorktreeForTest({
        cwd: repoDir,
        worktreeSlug: "dev-worktree",
        source: { kind: "checkout-branch", branchName: "dev" },

        mixerHome,
      });

      expect(existsSync(result.worktreePath)).toBe(true);
      const currentBranch = execFileSync("git", ["branch", "--show-current"], {
        cwd: result.worktreePath,
      })
        .toString()
        .trim();
      expect(currentBranch).toBe("dev");

      // baseRefName must be the repo's default branch, not the checked-out branch
      // itself — otherwise the diff panel compares the branch against itself and
      // always shows no changes.
      const metadataPath = await getMixerWorktreeMetadataPath(result.worktreePath);
      const metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
      expect(metadata).toMatchObject({
        version: 1,
        baseRefName: "main",
        changeRequestLookupTarget: { headRef: "dev", localBranchName: "dev" },
      });
    });

    it("shows committed changes when origin HEAD points to a deleted default branch", async () => {
      execFileSync("git", ["branch", "-m", "main", "master"], { cwd: repoDir });
      execFileSync(
        "git",
        ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"],
        { cwd: repoDir },
      );
      execFileSync("git", ["checkout", "-b", "feature/stale-default"], { cwd: repoDir });
      writeFileSync(join(repoDir, "file.txt"), "feature change\n");
      execFileSync("git", ["add", "file.txt"], { cwd: repoDir });
      execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-m", "feature change"], {
        cwd: repoDir,
      });
      execFileSync("git", ["checkout", "master"], { cwd: repoDir });
      const created = await createWorktreePrimitive({
        cwd: repoDir,
        worktreeSlug: "stale-default",
        source: { kind: "checkout-branch", branchName: "feature/stale-default" },

        mixerHome,
      });
      const diff = await getCheckoutDiff(created.worktreePath, { mode: "base" }, { mixerHome });
      expect(diff.diff).toContain("+feature change");
      expect(created.comparisonBaseRef).toBe("master");
    });

    it("falls back to the currently checked out branch when no default branch can be resolved", async () => {
      // No origin remote and no local main/master — resolveRepositoryDefaultBranch
      // can't find a default branch, so the fix must fall back to whatever is
      // currently checked out in the main repo (here: "develop").
      execFileSync("git", ["branch", "-m", "main", "develop"], { cwd: repoDir });
      execFileSync("git", ["branch", "feature-x"], { cwd: repoDir });

      const result = await createLegacyWorktreeForTest({
        cwd: repoDir,
        worktreeSlug: "feature-x-worktree",
        source: { kind: "checkout-branch", branchName: "feature-x" },

        mixerHome,
      });

      expect(existsSync(result.worktreePath)).toBe(true);
      const metadataPath = await getMixerWorktreeMetadataPath(result.worktreePath);
      const metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
      expect(metadata).toMatchObject({ version: 1, baseRefName: "develop" });
    });

    it("checks out an existing local branch whose name contains uppercase letters and dots", async () => {
      execFileSync("git", ["branch", "release/1.1.15"], { cwd: repoDir });

      const result = await createLegacyWorktreeForTest({
        cwd: repoDir,
        worktreeSlug: "release-worktree",
        source: { kind: "checkout-branch", branchName: "release/1.1.15" },

        mixerHome,
      });

      expect(existsSync(result.worktreePath)).toBe(true);
      const currentBranch = execFileSync("git", ["branch", "--show-current"], {
        cwd: result.worktreePath,
      })
        .toString()
        .trim();
      expect(currentBranch).toBe("release/1.1.15");
    });

    it("rejects checkout of a branch already checked out without creating a suffixed branch", async () => {
      await expect(
        createLegacyWorktreeForTest({
          cwd: repoDir,
          worktreeSlug: "dev-worktree",
          source: { kind: "checkout-branch", branchName: "main" },

          mixerHome,
        }),
      ).rejects.toMatchObject({ name: "BranchAlreadyCheckedOutError" });
      expect(
        execFileSync("git", ["branch", "--list", "main-*"], {
          cwd: repoDir,
          encoding: "utf8",
        }).trim(),
      ).toBe("");
    });

    it("preserves an explicit new branch name and refuses a conflicting name", async () => {
      const branchName = "internal/GLCX-106";
      const source = {
        kind: "branch-off",
        branchName,
        baseBranch: "main",
        requireNewBranch: true,
      } as const;
      const result = await createWorktreePrimitive({
        cwd: repoDir,
        worktreeSlug: "different-directory-name",
        source,
        mixerHome,
      });
      expect(result.branchName).toBe(branchName);
      await expect(
        createWorktreePrimitive({
          cwd: repoDir,
          worktreeSlug: "second-directory",
          source,
          mixerHome,
        }),
      ).rejects.toMatchObject({ name: "BranchAlreadyExistsError", branchName });
      expect(
        execFileSync(
          "git",
          ["for-each-ref", "--format=%(refname:short)", `refs/heads/${branchName}*`],
          { cwd: repoDir, encoding: "utf8" },
        ).trim(),
      ).toBe(branchName);
    });

    it("fetches a GitHub PR branch and writes metadata without executing setup", async () => {
      const remoteDir = join(tempDir, "remote.git");
      const remoteCloneDir = join(tempDir, "remote-clone");
      execFileSync("git", ["clone", "--bare", repoDir, remoteDir]);
      execFileSync("git", ["remote", "add", "origin", remoteDir], { cwd: repoDir });

      execFileSync("git", ["clone", remoteDir, remoteCloneDir]);
      execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: remoteCloneDir });
      execFileSync("git", ["config", "user.name", "Test"], { cwd: remoteCloneDir });
      execFileSync("git", ["checkout", "-b", "contributor/feature"], { cwd: remoteCloneDir });
      writeFileSync(join(remoteCloneDir, "file.txt"), "from-pr\n");
      writeFileSync(
        join(remoteCloneDir, "mixer.json"),
        JSON.stringify({ worktree: { setup: ['echo "setup ran" > setup.log'] } }),
      );
      execFileSync("git", ["add", "."], { cwd: remoteCloneDir });
      execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-m", "pr branch"], {
        cwd: remoteCloneDir,
      });
      const prHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: remoteCloneDir })
        .toString()
        .trim();
      execFileSync("git", ["push", "origin", "contributor/feature"], { cwd: remoteCloneDir });
      execFileSync("git", [`--git-dir=${remoteDir}`, "update-ref", "refs/pull/42/head", prHead]);

      const result = await createLegacyWorktreeForTest({
        cwd: repoDir,
        worktreeSlug: "pr-42",
        source: {
          kind: "checkout-github-pr",
          githubPrNumber: 42,
          headRef: "user/feature",
          baseRefName: "main",
        },

        mixerHome,
      });

      expect(readFileSync(join(result.worktreePath, "file.txt"), "utf8")).toBe("from-pr\n");
      expect(existsSync(join(result.worktreePath, "setup.log"))).toBe(false);
      const currentBranch = execFileSync("git", ["branch", "--show-current"], {
        cwd: result.worktreePath,
      })
        .toString()
        .trim();
      expect(currentBranch).toBe("user/feature");

      const metadataPath = await getMixerWorktreeMetadataPath(result.worktreePath);
      const metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
      expect(metadata).toMatchObject({ baseRefName: "main" });
    });

    it("fetches a GitHub PR branch when the head ref contains uppercase letters and dots", async () => {
      const remoteDir = join(tempDir, "remote.git");
      const remoteCloneDir = join(tempDir, "remote-clone");
      execFileSync("git", ["clone", "--bare", repoDir, remoteDir]);
      execFileSync("git", ["remote", "add", "origin", remoteDir], { cwd: repoDir });

      execFileSync("git", ["clone", remoteDir, remoteCloneDir]);
      execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: remoteCloneDir });
      execFileSync("git", ["config", "user.name", "Test"], { cwd: remoteCloneDir });
      execFileSync("git", ["checkout", "-b", "Feature.X"], { cwd: remoteCloneDir });
      writeFileSync(join(remoteCloneDir, "file.txt"), "from-uppercase-pr\n");
      execFileSync("git", ["add", "file.txt"], { cwd: remoteCloneDir });
      execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-m", "uppercase pr branch"], {
        cwd: remoteCloneDir,
      });
      const prHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: remoteCloneDir })
        .toString()
        .trim();
      execFileSync("git", ["push", "origin", "Feature.X"], { cwd: remoteCloneDir });
      execFileSync("git", [`--git-dir=${remoteDir}`, "update-ref", "refs/pull/43/head", prHead]);

      const result = await createLegacyWorktreeForTest({
        cwd: repoDir,
        worktreeSlug: "pr-43",
        source: {
          kind: "checkout-github-pr",
          githubPrNumber: 43,
          headRef: "Feature.X",
          baseRefName: "main",
        },

        mixerHome,
      });

      expect(readFileSync(join(result.worktreePath, "file.txt"), "utf8")).toBe(
        "from-uppercase-pr\n",
      );
      const currentBranch = execFileSync("git", ["branch", "--show-current"], {
        cwd: result.worktreePath,
      })
        .toString()
        .trim();
      expect(currentBranch).toBe("Feature.X");
    });

    it("uses the selected local or origin ref when both exist", async () => {
      const remoteDir = join(tempDir, "remote.git");
      const remoteCloneDir = join(tempDir, "remote-clone");
      execFileSync("git", ["init", "--bare", remoteDir]);
      execFileSync("git", ["remote", "add", "origin", remoteDir], { cwd: repoDir });
      execFileSync("git", ["push", "-u", "origin", "main"], { cwd: repoDir });

      execFileSync("git", ["clone", remoteDir, remoteCloneDir]);
      execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: remoteCloneDir });
      execFileSync("git", ["config", "user.name", "Test"], { cwd: remoteCloneDir });
      execFileSync("git", ["checkout", "-B", "main", "origin/main"], { cwd: remoteCloneDir });
      writeFileSync(join(remoteCloneDir, "file.txt"), "from-origin\n");
      execFileSync("git", ["add", "file.txt"], { cwd: remoteCloneDir });
      execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-m", "advance origin main"], {
        cwd: remoteCloneDir,
      });
      execFileSync("git", ["push", "origin", "main"], { cwd: remoteCloneDir });

      writeFileSync(join(repoDir, "file.txt"), "from-local\n");
      execFileSync("git", ["add", "file.txt"], { cwd: repoDir });
      execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-m", "advance local main"], {
        cwd: repoDir,
      });

      execFileSync("git", ["fetch", "origin"], { cwd: repoDir });

      const localResult = await createLegacyWorktreeForTest({
        branchName: "prefer-local-feature",
        cwd: repoDir,
        baseBranch: "refs/heads/main",
        worktreeSlug: "prefer-local-feature",

        mixerHome,
      });
      const originResult = await createLegacyWorktreeForTest({
        branchName: "prefer-origin-feature",
        cwd: repoDir,
        baseBranch: "refs/remotes/origin/main",
        worktreeSlug: "prefer-origin-feature",

        mixerHome,
      });

      expect(readFileSync(join(localResult.worktreePath, "file.txt"), "utf8")).toBe("from-local\n");
      const localStatus = await getCheckoutStatus(localResult.worktreePath, { mixerHome });
      expect(localStatus.isGit).toBe(true);
      if (!localStatus.isGit) {
        return;
      }
      expect(localStatus.aheadBehind).toEqual({ ahead: 0, behind: 0 });
      await expect(
        getCheckoutDiff(localResult.worktreePath, { mode: "base", baseRef: "main" }, { mixerHome }),
      ).resolves.toMatchObject({ diff: "" });
      expect(readFileSync(join(originResult.worktreePath, "file.txt"), "utf8")).toBe(
        "from-origin\n",
      );
      expect(
        JSON.parse(
          readFileSync(await getMixerWorktreeMetadataPath(originResult.worktreePath), "utf8"),
        ),
      ).toMatchObject({ baseRefName: "main" });
    });

    it("records the branch name when the base is on a remote other than origin", async () => {
      const forkDir = join(tempDir, "fork.git");
      const forkCloneDir = join(tempDir, "fork-clone");
      execFileSync("git", ["init", "--bare", forkDir]);
      execFileSync("git", ["remote", "add", "upstream", forkDir], { cwd: repoDir });
      execFileSync("git", ["push", "-u", "upstream", "main"], { cwd: repoDir });

      execFileSync("git", ["clone", "--branch", "main", forkDir, forkCloneDir]);
      execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: forkCloneDir });
      execFileSync("git", ["config", "user.name", "Test"], { cwd: forkCloneDir });
      writeFileSync(join(forkCloneDir, "file.txt"), "from-upstream\n");
      execFileSync("git", ["add", "file.txt"], { cwd: forkCloneDir });
      execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-m", "advance upstream main"], {
        cwd: forkCloneDir,
      });
      execFileSync("git", ["push", "origin", "main"], { cwd: forkCloneDir });
      execFileSync("git", ["fetch", "upstream"], { cwd: repoDir });
      const localMainHead = execFileSync("git", ["rev-parse", "refs/heads/main"], {
        cwd: repoDir,
      })
        .toString()
        .trim();

      const result = await createLegacyWorktreeForTest({
        branchName: "fork-base-feature",
        cwd: repoDir,
        baseBranch: "refs/remotes/upstream/main",
        worktreeSlug: "fork-base-feature",

        mixerHome,
      });

      expect(readFileSync(join(result.worktreePath, "file.txt"), "utf8")).toBe("from-upstream\n");
      // The display name and the exact ref are both recorded. Only the ref can resolve back
      // to the commit the worktree was cut from: "main" resolves local-first, which here is
      // a different commit than the fork's upstream.
      expect(
        JSON.parse(readFileSync(await getMixerWorktreeMetadataPath(result.worktreePath), "utf8")),
      ).toMatchObject({ baseRefName: "main", baseRef: "refs/remotes/upstream/main" });

      // An untouched child must report no work of its own. Comparing against the wrong base
      // shows the upstream-only commit as if the workspace had written it.
      const status = await getCheckoutStatus(result.worktreePath, { mixerHome });
      expect(status.isGit).toBe(true);
      if (!status.isGit) {
        return;
      }
      // The wire keeps the display name; the exact ref above is what the comparison used,
      // which is why an untouched child reports no work of its own.
      expect(status.baseRef).toBe("main");
      expect(status.aheadBehind).toEqual({ ahead: 0, behind: 0 });
      await expect(
        getCheckoutDiff(
          result.worktreePath,
          { mode: "base", baseRef: "refs/remotes/origin/main" },
          { mixerHome },
        ),
      ).rejects.toThrow(
        "Base ref mismatch: stored refs/remotes/upstream/main, requested refs/remotes/origin/main",
      );
      expect(
        await getCheckoutDiff(
          result.worktreePath,
          { mode: "base", baseRef: "main" },
          { mixerHome },
        ),
      ).toMatchObject({ diff: "" });
      const history = await listCheckoutCommits({
        cwd: result.worktreePath,
        context: { mixerHome },
      });
      expect(history.commits.every((commit) => commit.isOnBase)).toBe(true);
      await expect(
        mergeToBase(result.worktreePath, { baseRef: "main" }, { mixerHome }),
      ).rejects.toThrow(
        "No local merge target is recorded for base ref refs/remotes/upstream/main",
      );
      expect(
        execFileSync("git", ["rev-parse", "refs/heads/main"], { cwd: repoDir }).toString().trim(),
      ).toBe(localMainHead);

      writeFileSync(join(forkCloneDir, "later.txt"), "later\n");
      execFileSync("git", ["add", "later.txt"], { cwd: forkCloneDir });
      execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-m", "advance again"], {
        cwd: forkCloneDir,
      });
      execFileSync("git", ["push", "origin", "main"], { cwd: forkCloneDir });
      execFileSync("git", ["fetch", "upstream"], { cwd: result.worktreePath });
      await mergeFromBase(result.worktreePath, { baseRef: "main" }, { mixerHome });
      expect(readFileSync(join(result.worktreePath, "later.txt"), "utf8")).toBe("later\n");

      execFileSync("git", ["update-ref", "-d", "refs/remotes/upstream/main"], {
        cwd: result.worktreePath,
      });
      await expect(
        getCheckoutDiff(result.worktreePath, { mode: "base", baseRef: "main" }, { mixerHome }),
      ).rejects.toThrow("Base ref not found: refs/remotes/upstream/main");
      await expect(
        mergeFromBase(result.worktreePath, { baseRef: "main" }, { mixerHome }),
      ).rejects.toThrow("Base ref not found: refs/remotes/upstream/main");
      await expect(
        listCheckoutCommits({ cwd: result.worktreePath, context: { mixerHome } }),
      ).rejects.toThrow("Base ref not found: refs/remotes/upstream/main");
    });

    it("records Git-valid characters in a remote base branch", async () => {
      const upstreamDir = join(tempDir, "upstream.git");
      execFileSync("git", ["init", "--bare", upstreamDir]);
      execFileSync("git", ["remote", "add", "upstream", upstreamDir], { cwd: repoDir });
      execFileSync("git", ["push", "upstream", "refs/heads/main:refs/heads/release+hotfix"], {
        cwd: repoDir,
      });
      execFileSync("git", ["fetch", "upstream"], { cwd: repoDir });

      const result = await createLegacyWorktreeForTest({
        branchName: "release-hotfix-feature",
        cwd: repoDir,
        baseBranch: "refs/remotes/upstream/release+hotfix",
        worktreeSlug: "release-hotfix-feature",

        mixerHome,
      });

      expect(
        JSON.parse(readFileSync(await getMixerWorktreeMetadataPath(result.worktreePath), "utf8")),
      ).toMatchObject({
        baseRefName: "release+hotfix",
        baseRef: "refs/remotes/upstream/release+hotfix",
      });
    });

    it("uses a local branch when origin/{branch} does not exist", async () => {
      writeFileSync(join(repoDir, "file.txt"), "from-local-only\n");
      execFileSync("git", ["add", "file.txt"], { cwd: repoDir });
      execFileSync(
        "git",
        ["-c", "commit.gpgsign=false", "commit", "-m", "advance local main only"],
        {
          cwd: repoDir,
        },
      );

      const result = await createLegacyWorktreeForTest({
        branchName: "prefer-local-fallback-feature",
        cwd: repoDir,
        baseBranch: "main",
        worktreeSlug: "prefer-local-fallback-feature",

        mixerHome,
      });

      expect(readFileSync(join(result.worktreePath, "file.txt"), "utf8")).toBe("from-local-only\n");
    });

    it("throws when neither origin/{branch} nor local {branch} exists", async () => {
      await expect(
        createLegacyWorktreeForTest({
          branchName: "missing-base-feature",
          cwd: repoDir,
          baseBranch: "does-not-exist",
          worktreeSlug: "missing-base-feature",

          mixerHome,
        }),
      ).rejects.toThrow("Base branch not found: does-not-exist");
    });

    it("fails with a Git-invalid branch name", async () => {
      await expect(
        createLegacyWorktreeForTest({
          branchName: "bad..name",
          cwd: repoDir,
          baseBranch: "main",
          worktreeSlug: "test",
        }),
      ).rejects.toThrow("Git rejected ref name 'bad..name'");
    });

    it("throws a typed error when checking out an invalid existing branch name", async () => {
      let caughtError: unknown;
      try {
        await createLegacyWorktreeForTest({
          cwd: repoDir,
          worktreeSlug: "invalid-existing-branch",
          source: { kind: "checkout-branch", branchName: "bad..name" },

          mixerHome,
        });
      } catch (error) {
        caughtError = error;
      }

      expect(caughtError).toBeInstanceOf(InvalidGitBranchNameError);
      expect((caughtError as InvalidGitBranchNameError).branchName).toBe("bad..name");
    });

    it("throws a typed error when checking out a ref that is valid but not a branch name", async () => {
      let caughtError: unknown;
      try {
        await createLegacyWorktreeForTest({
          cwd: repoDir,
          worktreeSlug: "invalid-option-like-branch",
          source: { kind: "checkout-branch", branchName: "-bad" },

          mixerHome,
        });
      } catch (error) {
        caughtError = error;
      }

      expect(caughtError).toBeInstanceOf(InvalidGitBranchNameError);
      expect((caughtError as InvalidGitBranchNameError).branchName).toBe("-bad");
    });

    it("handles branch name collision by adding suffix", async () => {
      const projectHash = await deriveWorktreeProjectHash(repoDir);
      // Create a branch named "hello" first
      execFileSync("git", ["branch", "hello"], { cwd: repoDir });

      const result = await createLegacyWorktreeForTest({
        branchName: "main",
        cwd: repoDir,
        baseBranch: "main",
        worktreeSlug: "hello",
        mixerHome,
      });

      // Should create branch "hello-1" since "hello" exists
      expect(result.worktreePath).toBe(join(mixerHome, "worktrees", projectHash, "hello"));
      expect(existsSync(result.worktreePath)).toBe(true);

      const branches = execFileSync("git", ["branch"], { cwd: repoDir }).toString();
      expect(branches).toContain("hello-1");
    });

    it("handles multiple collisions", async () => {
      // Create branches "hello" and "hello-1"
      execFileSync("git", ["branch", "hello"], { cwd: repoDir });
      execFileSync("git", ["branch", "hello-1"], { cwd: repoDir });

      const result = await createLegacyWorktreeForTest({
        branchName: "main",
        cwd: repoDir,
        baseBranch: "main",
        worktreeSlug: "hello",
        mixerHome,
      });

      expect(existsSync(result.worktreePath)).toBe(true);

      const branches = execFileSync("git", ["branch"], { cwd: repoDir }).toString();
      expect(branches).toContain("hello-2");
    });

    it("runs setup commands from mixer.json", async () => {
      // Create mixer.json with setup commands
      const mixerConfig = {
        worktree: {
          setup: [
            'echo "source=$MIXER_SOURCE_CHECKOUT_PATH" > setup.log',
            'echo "root_alias=$MIXER_ROOT_PATH" >> setup.log',
            'echo "worktree=$MIXER_WORKTREE_PATH" >> setup.log',
            'echo "branch=$MIXER_BRANCH_NAME" >> setup.log',
            'echo "port=$MIXER_WORKTREE_PORT" >> setup.log',
          ],
        },
      };
      writeFileSync(join(repoDir, "mixer.json"), JSON.stringify(mixerConfig));
      execFileSync("git", ["add", "mixer.json"], { cwd: repoDir });
      execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-m", "add mixer.json"], {
        cwd: repoDir,
      });

      const result = await createLegacyWorktreeForTest({
        branchName: "main",
        cwd: repoDir,
        baseBranch: "main",
        worktreeSlug: "setup-test",
        mixerHome,
      });

      expect(existsSync(result.worktreePath)).toBe(true);

      await runWorktreeSetupCommands({
        worktreePath: result.worktreePath,
        branchName: result.branchName,
      });
      // Verify setup ran and env vars were available
      const setupLog = readFileSync(join(result.worktreePath, "setup.log"), "utf8");
      expect(setupLog).toContain(`source=${repoDir}`);
      expect(setupLog).toContain(`root_alias=${repoDir}`);
      expect(setupLog).toContain(`worktree=${result.worktreePath}`);
      expect(setupLog).toContain("branch=setup-test");
      const portLine = setupLog.split("\n").find((line) => line.startsWith("port="));
      expect(portLine).toBeDefined();
      const portValue = Number(portLine?.slice("port=".length));
      expect(Number.isInteger(portValue)).toBe(true);
      expect(portValue).toBeGreaterThan(0);
    });

    it("runs string setup scripts from mixer.json as a single shell command", async () => {
      const mixerConfig = {
        worktree: {
          setup: 'greeting="hello from string setup"\necho "$greeting" > setup.log',
        },
      };
      writeFileSync(join(repoDir, "mixer.json"), JSON.stringify(mixerConfig));
      execFileSync("git", ["add", "mixer.json"], { cwd: repoDir });
      execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-m", "add string setup"], {
        cwd: repoDir,
      });

      const result = await createLegacyWorktreeForTest({
        branchName: "main",
        cwd: repoDir,
        baseBranch: "main",
        worktreeSlug: "string-setup-test",
        mixerHome,
      });

      await runWorktreeSetupCommands({
        worktreePath: result.worktreePath,
        branchName: result.branchName,
      });
      expect(await getWorktreeSetupCommands(result.worktreePath)).toEqual([
        'greeting="hello from string setup"\necho "$greeting" > setup.log',
      ]);
      expect(readFileSync(join(result.worktreePath, "setup.log"), "utf8").trim()).toBe(
        "hello from string setup",
      );
    });

    it("runs setup commands with the daemon PATH instead of login profile PATH", async () => {
      const home = join(tempDir, "host-home");
      const binDir = join(tempDir, "daemon-bin");
      mkdirSync(home);
      mkdirSync(binDir);

      const shimPath = join(binDir, "mixer-shim");
      writeFileSync(shimPath, "#!/bin/sh\nprintf 'shim:%s\\n' \"$1\"\n");
      chmodSync(shimPath, 0o755);
      writeFileSync(join(home, ".bash_profile"), "export PATH=/usr/bin:/bin\n");
      const bashEnvPath = join(home, "bash-env");
      writeFileSync(bashEnvPath, "export PATH=/usr/bin:/bin\n");
      writeFileSync(
        join(repoDir, "mixer.json"),
        JSON.stringify({
          worktree: {
            setup: "command -v mixer-shim >/dev/null && mixer-shim ok > setup-path.log",
          },
        }),
      );

      const originalHome = process.env.HOME;
      const originalPath = process.env.PATH;
      const originalBashEnv = process.env.BASH_ENV;
      process.env.HOME = home;
      process.env.PATH = `${binDir}${delimiter}${originalPath ?? "/usr/bin:/bin"}`;
      process.env.BASH_ENV = bashEnvPath;

      try {
        await runWorktreeSetupCommands({
          worktreePath: repoDir,
          branchName: "main",
          runtimeEnv: {
            MIXER_SOURCE_CHECKOUT_PATH: repoDir,
            MIXER_ROOT_PATH: repoDir,
            MIXER_WORKTREE_PATH: repoDir,
            MIXER_BRANCH_NAME: "main",
            MIXER_WORKTREE_PORT: "12345",
          },
        });
      } finally {
        if (originalHome === undefined) {
          delete process.env.HOME;
        } else {
          process.env.HOME = originalHome;
        }
        if (originalPath === undefined) {
          delete process.env.PATH;
        } else {
          process.env.PATH = originalPath;
        }
        if (originalBashEnv === undefined) {
          delete process.env.BASH_ENV;
        } else {
          process.env.BASH_ENV = originalBashEnv;
        }
      }

      expect(readFileSync(join(repoDir, "setup-path.log"), "utf8").trim()).toBe("shim:ok");
    });

    it("treats blank lifecycle strings as empty", async () => {
      writeFileSync(
        join(repoDir, "mixer.json"),
        JSON.stringify({
          worktree: {
            setup: " \n\t ",
            teardown: " \n ",
          },
        }),
      );

      expect(await getWorktreeSetupCommands(repoDir)).toEqual([]);
      expect(await getWorktreeTeardownCommands(repoDir)).toEqual([]);
    });

    it("filters non-string and blank entries from lifecycle arrays", async () => {
      writeFileSync(
        join(repoDir, "mixer.json"),
        JSON.stringify({
          worktree: {
            setup: [
              'echo "first" > setup-array.log',
              null,
              "   ",
              'echo "second" >> setup-array.log',
            ],
            teardown: [
              'echo "first" > "$MIXER_SOURCE_CHECKOUT_PATH/teardown-array.log"',
              null,
              "",
              'echo "second" >> "$MIXER_SOURCE_CHECKOUT_PATH/teardown-array.log"',
            ],
          },
        }),
      );

      expect(await getWorktreeSetupCommands(repoDir)).toEqual([
        'echo "first" > setup-array.log',
        'echo "second" >> setup-array.log',
      ]);
      expect(await getWorktreeTeardownCommands(repoDir)).toEqual([
        'echo "first" > "$MIXER_SOURCE_CHECKOUT_PATH/teardown-array.log"',
        'echo "second" >> "$MIXER_SOURCE_CHECKOUT_PATH/teardown-array.log"',
      ]);
    });

    it("only provisions the worktree without executing setup", async () => {
      const mixerConfig = {
        worktree: {
          setup: ['echo "setup ran" > setup.log'],
        },
      };
      writeFileSync(join(repoDir, "mixer.json"), JSON.stringify(mixerConfig));
      execFileSync("git", ["add", "mixer.json"], { cwd: repoDir });
      execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-m", "add mixer.json"], {
        cwd: repoDir,
      });

      const result = await createLegacyWorktreeForTest({
        branchName: "main",
        cwd: repoDir,
        baseBranch: "main",
        worktreeSlug: "no-setup-test",

        mixerHome,
      });

      expect(existsSync(result.worktreePath)).toBe(true);
      expect(existsSync(join(result.worktreePath, "setup.log"))).toBe(false);
    });

    it("streams setup command progress events while commands are executing", async () => {
      const mixerConfig = {
        worktree: {
          setup: ['echo "first line"; echo "second line" 1>&2'],
        },
      };
      writeFileSync(join(repoDir, "mixer.json"), JSON.stringify(mixerConfig));
      execFileSync("git", ["add", "mixer.json"], { cwd: repoDir });
      execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-m", "add streaming setup"], {
        cwd: repoDir,
      });

      const progressEvents: WorktreeSetupCommandProgressEvent[] = [];
      const results = await runWorktreeSetupCommands({
        worktreePath: repoDir,
        branchName: "main",
        onEvent: (event) => {
          progressEvents.push(event);
        },
      });

      expect(results).toHaveLength(1);
      expect(progressEvents.some((event) => event.type === "command_started")).toBe(true);
      expect(progressEvents.some((event) => event.type === "output")).toBe(true);
      expect(progressEvents.some((event) => event.type === "command_completed")).toBe(true);
    });

    it("reuses persisted worktree runtime port across resolutions", async () => {
      const result = await createLegacyWorktreeForTest({
        branchName: "main",
        cwd: repoDir,
        baseBranch: "main",
        worktreeSlug: "runtime-env-port-reuse",

        mixerHome,
      });

      const first = await resolveWorktreeRuntimeEnv({
        worktreePath: result.worktreePath,
        branchName: result.branchName,
      });
      const second = await resolveWorktreeRuntimeEnv({
        worktreePath: result.worktreePath,
        branchName: result.branchName,
      });

      expect(second.MIXER_WORKTREE_PORT).toBe(first.MIXER_WORKTREE_PORT);
    });

    it("fails runtime env resolution when persisted port is in use", async () => {
      const result = await createLegacyWorktreeForTest({
        branchName: "main",
        cwd: repoDir,
        baseBranch: "main",
        worktreeSlug: "runtime-env-port-conflict",

        mixerHome,
      });

      const env = await resolveWorktreeRuntimeEnv({
        worktreePath: result.worktreePath,
        branchName: result.branchName,
      });
      const port = Number(env.MIXER_WORKTREE_PORT);

      const server = net.createServer();
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, () => resolve());
      });

      await expect(
        resolveWorktreeRuntimeEnv({
          worktreePath: result.worktreePath,
          branchName: result.branchName,
        }),
      ).rejects.toThrow(`Persisted worktree port ${port} is already in use`);

      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    });

    it("reads worktree terminal specs from mixer.json with optional name", async () => {
      const mixerConfig = {
        worktree: {
          terminals: [
            { name: "Dev Server", command: "npm run dev" },
            { command: "cd packages/app && npm run dev" },
          ],
        },
      };
      writeFileSync(join(repoDir, "mixer.json"), JSON.stringify(mixerConfig));

      expect(await getWorktreeTerminalSpecs(repoDir)).toEqual([
        { name: "Dev Server", command: "npm run dev" },
        { command: "cd packages/app && npm run dev" },
      ]);
    });

    it("filters invalid worktree terminal specs", async () => {
      const mixerConfig = {
        worktree: {
          terminals: [
            null,
            {},
            { name: "   ", command: "   " },
            { name: " Watch ", command: "npm run watch", cwd: "packages/app" },
            { name: 123, command: "npm run test" },
          ],
        },
      };
      writeFileSync(join(repoDir, "mixer.json"), JSON.stringify(mixerConfig));

      expect(await getWorktreeTerminalSpecs(repoDir)).toEqual([
        { name: "Watch", command: "npm run watch" },
        { command: "npm run test" },
      ]);
    });

    it("parses omitted script type as a plain script", async () => {
      writeFileSync(
        join(repoDir, "mixer.json"),
        JSON.stringify({
          scripts: {
            typecheck: {
              command: " npm run typecheck ",
            },
          },
        }),
      );

      const scriptConfigs = getScriptConfigs(await loadConfigForTest(repoDir));
      const typecheck = scriptConfigs.get("typecheck");

      expect(typecheck).toEqual({
        command: "npm run typecheck",
      });
      expect(typecheck).toBeDefined();
      expect(isServiceScript(typecheck!)).toBe(false);
    });

    it("parses service scripts and preserves optional port", async () => {
      writeFileSync(
        join(repoDir, "mixer.json"),
        JSON.stringify({
          scripts: {
            server: {
              type: "service",
              command: "npm run dev",
              port: 4321,
            },
          },
        }),
      );

      const scriptConfigs = getScriptConfigs(await loadConfigForTest(repoDir));
      const server = scriptConfigs.get("server");

      expect(server).toEqual({
        type: "service",
        command: "npm run dev",
        port: 4321,
      });
      expect(server).toBeDefined();
      expect(isServiceScript(server!)).toBe(true);
    });

    it("ignores invalid script entries gracefully", async () => {
      writeFileSync(
        join(repoDir, "mixer.json"),
        JSON.stringify({
          scripts: {
            valid: {
              command: "npm run valid",
            },
            invalidType: {
              type: "worker",
              command: "npm run worker",
            },
            missingCommand: {
              type: "service",
            },
            blankCommand: {
              command: "   ",
            },
            nonObject: "npm run nope",
            invalidPort: {
              type: "service",
              command: "npm run dev",
              port: "3000",
            },
          },
        }),
      );

      expect(getScriptConfigs(await loadConfigForTest(repoDir))).toEqual(
        new Map([
          ["valid", { command: "npm run valid" }],
          ["invalidType", { command: "npm run worker" }],
          ["invalidPort", { type: "service", command: "npm run dev" }],
        ]),
      );
    });

    it("seeds an uncommitted mixer.json from the main repo into a new worktree", async () => {
      writeFileSync(
        join(repoDir, "mixer.json"),
        JSON.stringify({ scripts: { dev: { command: "echo hi" } } }),
      );

      const result = await createLegacyWorktreeForTest({
        cwd: repoDir,
        worktreeSlug: "seed-uncommitted",
        source: { kind: "branch-off", baseBranch: "main", branchName: "feature/seed" },

        mixerHome,
      });

      const worktreeConfigPath = join(result.worktreePath, "mixer.json");
      expect(existsSync(worktreeConfigPath)).toBe(true);
      expect(JSON.parse(readFileSync(worktreeConfigPath, "utf8"))).toEqual({
        scripts: { dev: { command: "echo hi" } },
      });
    });

    it("keeps a new worktree clean when its upstream ref has a newer mixer.json", async () => {
      const remoteDir = join(tempDir, "remote.git");
      const updaterDir = join(tempDir, "updater");
      writeFileSync(
        join(repoDir, "mixer.json"),
        JSON.stringify({ worktree: { setup: "echo old" } }),
      );
      execFileSync("git", ["add", "mixer.json"], { cwd: repoDir });
      execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-m", "add mixer.json"], {
        cwd: repoDir,
      });
      execFileSync("git", ["clone", "--bare", repoDir, remoteDir]);
      execFileSync("git", ["remote", "add", "origin", remoteDir], { cwd: repoDir });
      execFileSync("git", ["clone", remoteDir, updaterDir]);
      execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: updaterDir });
      execFileSync("git", ["config", "user.name", "Test"], { cwd: updaterDir });
      writeFileSync(
        join(updaterDir, "mixer.json"),
        JSON.stringify({ worktree: { setup: "echo new" } }),
      );
      execFileSync("git", ["add", "mixer.json"], { cwd: updaterDir });
      execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-m", "update mixer.json"], {
        cwd: updaterDir,
      });
      execFileSync("git", ["push", "origin", "main"], { cwd: updaterDir });
      execFileSync("git", ["fetch", "origin"], { cwd: repoDir });

      const result = await createLegacyWorktreeForTest({
        cwd: repoDir,
        worktreeSlug: "upstream-config",
        source: {
          kind: "branch-off",
          baseBranch: "origin/main",
          branchName: "feature/upstream-config",
        },

        mixerHome,
      });

      const worktreeConfigPath = join(result.worktreePath, "mixer.json");
      expect(JSON.parse(readFileSync(worktreeConfigPath, "utf8"))).toEqual({
        worktree: { setup: "echo new" },
      });
      expect(
        execFileSync("git", ["status", "--porcelain"], {
          cwd: result.worktreePath,
          encoding: "utf8",
        }),
      ).toBe("");
    });

    it("preserves a dangling mixer.json symlink from the selected ref", async () => {
      const externalConfigPath = join(tempDir, "outside-mixer.json");
      execFileSync("git", ["checkout", "-b", "symlink-config"], { cwd: repoDir });
      symlinkSync(externalConfigPath, join(repoDir, "mixer.json"));
      execFileSync("git", ["add", "mixer.json"], { cwd: repoDir });
      execFileSync(
        "git",
        ["-c", "commit.gpgsign=false", "commit", "-m", "add mixer.json symlink"],
        { cwd: repoDir },
      );
      execFileSync("git", ["checkout", "main"], { cwd: repoDir });
      writeFileSync(
        join(repoDir, "mixer.json"),
        JSON.stringify({ worktree: { setup: "echo source" } }),
      );

      const result = await createLegacyWorktreeForTest({
        cwd: repoDir,
        worktreeSlug: "symlink-config",
        source: {
          kind: "branch-off",
          baseBranch: "symlink-config",
          branchName: "feature/symlink-config",
        },

        mixerHome,
      });

      const worktreeConfigPath = join(result.worktreePath, "mixer.json");
      expect(lstatSync(worktreeConfigPath).isSymbolicLink()).toBe(true);
      expect(readlinkSync(worktreeConfigPath)).toBe(externalConfigPath);
      expect(existsSync(externalConfigPath)).toBe(false);
      expect(
        execFileSync("git", ["status", "--porcelain"], {
          cwd: result.worktreePath,
          encoding: "utf8",
        }),
      ).toBe("");
    });

    it("creates a worktree without error when no mixer.json exists in the main repo", async () => {
      const result = await createLegacyWorktreeForTest({
        cwd: repoDir,
        worktreeSlug: "no-config",
        source: { kind: "branch-off", baseBranch: "main", branchName: "feature/no-config" },

        mixerHome,
      });

      expect(existsSync(join(result.worktreePath, "mixer.json"))).toBe(false);
    });
  });

  describe("worktrees at explicit paths", () => {
    let tempDir: string;
    let repoDir: string;
    let mixerHome: string;

    beforeEach(() => {
      tempDir = realpathSync(mkdtempSync(join(tmpdir(), "worktree-explicit-test-")));
      repoDir = join(tempDir, "test-repo");
      mixerHome = join(tempDir, "mixer-home");

      mkdirSync(repoDir, { recursive: true });
      execFileSync("git", ["init", "-b", "main"], { cwd: repoDir });
      execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: repoDir });
      execFileSync("git", ["config", "user.name", "Test"], { cwd: repoDir });
      writeFileSync(join(repoDir, "file.txt"), "hello\n");
      execFileSync("git", ["add", "."], { cwd: repoDir });
      execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-m", "initial"], {
        cwd: repoDir,
      });
    });

    afterEach(() => {
      rmSync(tempDir, { recursive: true, force: true });
    });

    it("places, owns, lists, and deletes a worktree outside the legacy root", async () => {
      // Sibling layout: <repo-parent>/wt-<slug>

      const result = await createWorktreePrimitive({
        cwd: repoDir,
        worktreeSlug: "sibling-one",
        source: { kind: "branch-off", baseBranch: "main", branchName: "feature/sibling" },
        mixerHome,
        worktreePath: join(tempDir, "wt-sibling-one"),
      });

      expect(result.worktreePath).toBe(join(tempDir, "wt-sibling-one"));
      expect(existsSync(join(result.worktreePath, "file.txt"))).toBe(true);
      expect(existsSync(await getMixerWorktreeMetadataPath(result.worktreePath))).toBe(true);

      const ownership = await isMixerOwnedWorktreeCwd(result.worktreePath, { mixerHome });
      expect(ownership.allowed).toBe(true);
      expect(ownership.worktreePath).toBe(result.worktreePath);
      // A subdirectory of the worktree resolves to the worktree root.
      mkdirSync(join(result.worktreePath, "sub"), { recursive: true });
      const nested = await isMixerOwnedWorktreeCwd(join(result.worktreePath, "sub"), {
        mixerHome,
      });
      expect(nested.worktreePath).toBe(result.worktreePath);

      const listed = await listMixerWorktrees({ cwd: repoDir, mixerHome });
      expect(listed.map((entry) => entry.path)).toContain(result.worktreePath);

      await deleteMixerWorktree({ cwd: repoDir, worktreePath: result.worktreePath, mixerHome });
      expect(existsSync(result.worktreePath)).toBe(false);
    });

    it("removes branches fetched by the source plan when git worktree add fails", async () => {
      // A branch that exists only on the remote: resolving a
      // checkout-branch plan fetches it into a local branch. A script
      // failure must not leave that branch behind, or the next attempt
      // would uniquify to a different branch name.
      const remoteDir = join(tempDir, "remote.git");
      execFileSync("git", ["clone", "--bare", repoDir, remoteDir], { cwd: tempDir });
      execFileSync("git", ["remote", "add", "origin", remoteDir], { cwd: repoDir });
      execFileSync("git", ["push", "origin", "main"], { cwd: repoDir });
      execFileSync("git", ["branch", "feature/remote-check"], { cwd: repoDir });
      execFileSync("git", ["push", "origin", "feature/remote-check"], { cwd: repoDir });
      execFileSync("git", ["branch", "-D", "feature/remote-check"], { cwd: repoDir });
      execFileSync("git", ["fetch", "origin"], { cwd: repoDir });

      mkdirSync(join(tempDir, "occupied"));
      writeFileSync(join(tempDir, "occupied", "keep"), "keep");
      await expect(
        createWorktreePrimitive({
          cwd: repoDir,
          worktreeSlug: "remote-check",
          source: { kind: "checkout-branch", branchName: "feature/remote-check" },
          mixerHome,
          worktreePath: join(tempDir, "occupied"),
        }),
      ).rejects.toThrow();

      const localBranches = execFileSync("git", ["branch", "--list", "feature/remote-check"], {
        cwd: repoDir,
        encoding: "utf8",
      });
      expect(localBranches.trim()).toBe("");
    });

    it("deletes only the registered destination nested beneath the legacy root", async () => {
      const parent = join(mixerHome, "worktrees", "acme", "widgets");
      const worktreePath = join(parent, "topic");
      const siblingPath = join(parent, "sibling");
      await createWorktreePrimitive({
        cwd: repoDir,
        mixerHome,
        worktreeSlug: "topic",
        worktreePath,
        source: { kind: "branch-off", branchName: "topic", baseBranch: "main" },
      });
      await createWorktreePrimitive({
        cwd: repoDir,
        mixerHome,
        worktreeSlug: "sibling",
        worktreePath: siblingPath,
        source: { kind: "branch-off", branchName: "sibling", baseBranch: "main" },
      });
      mkdirSync(join(worktreePath, "nested"));
      expect(
        await isMixerOwnedWorktreeCwd(join(worktreePath, "nested"), { mixerHome }),
      ).toMatchObject({ allowed: true, worktreePath });
      await deleteMixerWorktree({ cwd: repoDir, mixerHome, worktreePath, registryProven: true });
      expect(existsSync(worktreePath)).toBe(false);
      expect(readFileSync(join(siblingPath, "file.txt"), "utf8")).toBe("hello\n");
    });

    it("rejects a destination under a symlink into .git", async () => {
      const alias = join(tempDir, "git-alias");
      symlinkSync(join(repoDir, ".git"), alias, "dir");
      await expect(
        validateWorktreePath({ candidate: join(alias, "new", "worktree"), repoPath: repoDir }),
      ).rejects.toThrow("inside a .git directory");
      expect(existsSync(join(repoDir, ".git", "new"))).toBe(false);
    });

    it("uses an explicit worktreePath verbatim", async () => {
      const explicitPath = join(tempDir, "explicit-wt");

      const result = await createWorktreePrimitive({
        cwd: repoDir,
        worktreeSlug: "explicit-one",
        source: { kind: "branch-off", baseBranch: "main", branchName: "feature/explicit" },
        mixerHome,
        worktreePath: explicitPath,
      });

      expect(result.worktreePath).toBe(explicitPath);
      expect(existsSync(join(explicitPath, "file.txt"))).toBe(true);
    });

    it("restore recreates at the recorded path", async () => {
      const created = await createWorktreePrimitive({
        cwd: repoDir,
        worktreeSlug: "restorable",
        source: { kind: "branch-off", baseBranch: "main", branchName: "feature/restorable" },
        mixerHome,
        worktreePath: join(tempDir, "wt-sibling-one"),
      });
      await deleteMixerWorktree({ cwd: repoDir, worktreePath: created.worktreePath, mixerHome });
      expect(existsSync(created.worktreePath)).toBe(false);

      const restored = await createWorktreePrimitive({
        cwd: repoDir,
        worktreeSlug: "restorable",
        source: { kind: "restore", branchName: "feature/restorable", baseRef: "main" },
        mixerHome,
        worktreePath: created.worktreePath,
      });

      expect(restored.worktreePath).toBe(created.worktreePath);
      expect(existsSync(join(restored.worktreePath, "file.txt"))).toBe(true);
    });

    it("does not treat a copied marker in a non-worktree directory as ownership", async () => {
      const created = await createWorktreePrimitive({
        cwd: repoDir,
        worktreeSlug: "marker-source",
        source: { kind: "branch-off", baseBranch: "main", branchName: "feature/marker" },
        mixerHome,
        worktreePath: join(tempDir, "wt-sibling-one"),
      });
      const metadata = await readMixerWorktreeMetadata(created.worktreePath);
      expect(metadata).not.toBeNull();

      // A plain directory with a .git file pointing at a copied admin dir
      // that holds a mixer/worktree.json. Git does not list it as a
      // worktree, so the copied marker must not prove ownership.
      const fakeDir = join(tempDir, "fake-worktree");
      const fakeAdmin = join(tempDir, "fake-admin");
      mkdirSync(join(fakeAdmin, "mixer"), { recursive: true });
      mkdirSync(fakeDir, { recursive: true });
      writeFileSync(join(fakeAdmin, "mixer", "worktree.json"), JSON.stringify(metadata));
      writeFileSync(join(fakeDir, ".git"), `gitdir: ${fakeAdmin}\n`);

      const ownership = await isMixerOwnedWorktreeCwd(fakeDir, { mixerHome });
      expect(ownership.allowed).toBe(false);
      await expect(
        deleteMixerWorktree({ cwd: repoDir, worktreePath: fakeDir, mixerHome }),
      ).rejects.toThrow("Refusing to delete non-Mixer worktree");
      expect(existsSync(fakeDir)).toBe(true);
    });
  });

  describe("mixer worktree manager", () => {
    let tempDir: string;
    let repoDir: string;
    let mixerHome: string;

    beforeEach(() => {
      tempDir = realpathSync(mkdtempSync(join(tmpdir(), "worktree-manager-test-")));
      repoDir = join(tempDir, "test-repo");
      mixerHome = join(tempDir, "mixer-home");

      mkdirSync(repoDir, { recursive: true });
      execFileSync("git", ["init", "-b", "main"], { cwd: repoDir });
      execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: repoDir });
      execFileSync("git", ["config", "user.name", "Test"], { cwd: repoDir });
      writeFileSync(join(repoDir, "file.txt"), "hello\n");
      execFileSync("git", ["add", "."], { cwd: repoDir });
      execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-m", "initial"], {
        cwd: repoDir,
      });
    });

    afterEach(() => {
      rmSync(tempDir, { recursive: true, force: true });
    });

    it("isolates worktree roots for repositories that share the same directory name", async () => {
      const repoA = join(tempDir, "team-a", "test-repo");
      const repoB = join(tempDir, "team-b", "test-repo");

      for (const repo of [repoA, repoB]) {
        mkdirSync(repo, { recursive: true });
        execFileSync("git", ["init", "-b", "main"], { cwd: repo });
        execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: repo });
        execFileSync("git", ["config", "user.name", "Test"], { cwd: repo });
        writeFileSync(join(repo, "file.txt"), "hello\n");
        execFileSync("git", ["add", "."], { cwd: repo });
        execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-m", "initial"], {
          cwd: repo,
        });
      }

      const fromRepoA = await createLegacyWorktreeForTest({
        branchName: "main",
        cwd: repoA,
        baseBranch: "main",
        worktreeSlug: "alpha",
        mixerHome,
      });
      const fromRepoB = await createLegacyWorktreeForTest({
        branchName: "main",
        cwd: repoB,
        baseBranch: "main",
        worktreeSlug: "alpha",
        mixerHome,
      });

      expect(dirname(fromRepoA.worktreePath)).not.toBe(dirname(fromRepoB.worktreePath));
      expect(fromRepoA.worktreePath.endsWith("alpha-1")).toBe(false);
      expect(fromRepoB.worktreePath.endsWith("alpha-1")).toBe(false);

      const repoAWorktrees = await listMixerWorktrees({ cwd: repoA, mixerHome });
      const repoBWorktrees = await listMixerWorktrees({ cwd: repoB, mixerHome });

      expect(repoAWorktrees.map((entry) => entry.path)).toEqual([fromRepoA.worktreePath]);
      expect(repoBWorktrees.map((entry) => entry.path)).toEqual([fromRepoB.worktreePath]);
    });

    it("lists and deletes mixer worktrees under ~/.mixer/worktrees/{hash}", async () => {
      const first = await createLegacyWorktreeForTest({
        branchName: "main",
        cwd: repoDir,
        baseBranch: "main",
        worktreeSlug: "alpha",
        mixerHome,
      });
      const second = await createLegacyWorktreeForTest({
        branchName: "main",
        cwd: repoDir,
        baseBranch: "main",
        worktreeSlug: "beta",
        mixerHome,
      });

      const worktrees = await listMixerWorktrees({ cwd: repoDir, mixerHome });
      const paths = worktrees.map((worktree) => worktree.path).sort();
      expect(paths).toEqual([first.worktreePath, second.worktreePath].sort());

      await deleteMixerWorktree({ cwd: repoDir, worktreePath: first.worktreePath, mixerHome });
      expect(existsSync(first.worktreePath)).toBe(false);

      const remaining = await listMixerWorktrees({ cwd: repoDir, mixerHome });
      expect(remaining.map((worktree) => worktree.path)).toEqual([second.worktreePath]);
    });

    it("deletes a mixer worktree even when given a subdirectory path", async () => {
      const created = await createLegacyWorktreeForTest({
        branchName: "main",
        cwd: repoDir,
        baseBranch: "main",
        worktreeSlug: "alpha",
        mixerHome,
      });

      const nestedDir = join(created.worktreePath, "nested", "dir");
      mkdirSync(nestedDir, { recursive: true });

      await deleteMixerWorktree({ cwd: repoDir, worktreePath: nestedDir, mixerHome });
      expect(existsSync(created.worktreePath)).toBe(false);

      const remaining = await listMixerWorktrees({ cwd: repoDir, mixerHome });
      expect(remaining.some((worktree) => worktree.path === created.worktreePath)).toBe(false);
    });

    it("runs teardown commands from mixer.json before deleting a worktree", async () => {
      const mixerConfig = {
        worktree: {
          teardown: [
            'echo "source=$MIXER_SOURCE_CHECKOUT_PATH" > "$MIXER_SOURCE_CHECKOUT_PATH/teardown.log"',
            'echo "root_alias=$MIXER_ROOT_PATH" >> "$MIXER_SOURCE_CHECKOUT_PATH/teardown.log"',
            'echo "worktree=$MIXER_WORKTREE_PATH" >> "$MIXER_SOURCE_CHECKOUT_PATH/teardown.log"',
            'echo "branch=$MIXER_BRANCH_NAME" >> "$MIXER_SOURCE_CHECKOUT_PATH/teardown.log"',
            'echo "port=$MIXER_WORKTREE_PORT" >> "$MIXER_SOURCE_CHECKOUT_PATH/teardown.log"',
          ],
        },
      };
      writeFileSync(join(repoDir, "mixer.json"), JSON.stringify(mixerConfig));
      execFileSync("git", ["add", "mixer.json"], { cwd: repoDir });
      execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-m", "add teardown commands"], {
        cwd: repoDir,
      });

      const created = await createLegacyWorktreeForTest({
        branchName: "teardown-branch",
        cwd: repoDir,
        baseBranch: "main",
        worktreeSlug: "teardown-test",
        mixerHome,
      });
      const runtimeEnv = await resolveWorktreeRuntimeEnv({
        worktreePath: created.worktreePath,
        branchName: created.branchName,
      });

      await deleteMixerWorktree({ cwd: repoDir, worktreePath: created.worktreePath, mixerHome });
      expect(existsSync(created.worktreePath)).toBe(false);

      const teardownLog = readFileSync(join(repoDir, "teardown.log"), "utf8");
      expect(teardownLog).toContain(`source=${repoDir}`);
      expect(teardownLog).toContain(`root_alias=${repoDir}`);
      expect(teardownLog).toContain(`worktree=${created.worktreePath}`);
      expect(teardownLog).toContain("branch=teardown-branch");
      expect(teardownLog).toContain(`port=${runtimeEnv.MIXER_WORKTREE_PORT}`);
    });

    it("runs string teardown scripts from mixer.json as a single shell command", async () => {
      const mixerConfig = {
        worktree: {
          teardown:
            'cleanup_message="teardown string"\necho "$cleanup_message" > "$MIXER_SOURCE_CHECKOUT_PATH/teardown.log"',
        },
      };
      writeFileSync(join(repoDir, "mixer.json"), JSON.stringify(mixerConfig));
      execFileSync("git", ["add", "mixer.json"], { cwd: repoDir });
      execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-m", "add string teardown"], {
        cwd: repoDir,
      });

      const created = await createLegacyWorktreeForTest({
        branchName: "teardown-string-branch",
        cwd: repoDir,
        baseBranch: "main",
        worktreeSlug: "teardown-string-test",
        mixerHome,
      });

      await deleteMixerWorktree({ cwd: repoDir, worktreePath: created.worktreePath, mixerHome });

      expect(await getWorktreeTeardownCommands(repoDir)).toEqual([
        'cleanup_message="teardown string"\necho "$cleanup_message" > "$MIXER_SOURCE_CHECKOUT_PATH/teardown.log"',
      ]);
      expect(readFileSync(join(repoDir, "teardown.log"), "utf8").trim()).toBe("teardown string");
    });

    it("omits MIXER_WORKTREE_PORT from teardown env when runtime metadata is missing", async () => {
      const mixerConfig = {
        worktree: {
          teardown: [
            'echo "port=${MIXER_WORKTREE_PORT-unset}" > "$MIXER_SOURCE_CHECKOUT_PATH/teardown-port.log"',
          ],
        },
      };
      writeFileSync(join(repoDir, "mixer.json"), JSON.stringify(mixerConfig));
      execFileSync("git", ["add", "mixer.json"], { cwd: repoDir });
      execFileSync(
        "git",
        ["-c", "commit.gpgsign=false", "commit", "-m", "add teardown port logging"],
        { cwd: repoDir },
      );

      const created = await createLegacyWorktreeForTest({
        branchName: "teardown-port-missing-branch",
        cwd: repoDir,
        baseBranch: "main",
        worktreeSlug: "teardown-port-missing-test",
        mixerHome,
      });

      await deleteMixerWorktree({ cwd: repoDir, worktreePath: created.worktreePath, mixerHome });

      expect(readFileSync(join(repoDir, "teardown-port.log"), "utf8").trim()).toBe("port=unset");
      expect(existsSync(created.worktreePath)).toBe(false);
    });

    it("does not remove worktree when a teardown command fails", async () => {
      const mixerConfig = {
        worktree: {
          teardown: [
            'echo "started" > "$MIXER_SOURCE_CHECKOUT_PATH/teardown-start.log"',
            "echo boom 1>&2; exit 9",
          ],
        },
      };
      writeFileSync(join(repoDir, "mixer.json"), JSON.stringify(mixerConfig));
      execFileSync("git", ["add", "mixer.json"], { cwd: repoDir });
      execFileSync(
        "git",
        ["-c", "commit.gpgsign=false", "commit", "-m", "add failing teardown commands"],
        { cwd: repoDir },
      );

      const created = await createLegacyWorktreeForTest({
        branchName: "teardown-failure-branch",
        cwd: repoDir,
        baseBranch: "main",
        worktreeSlug: "teardown-failure-test",
        mixerHome,
      });

      await expect(
        deleteMixerWorktree({ cwd: repoDir, worktreePath: created.worktreePath, mixerHome }),
      ).rejects.toThrow("Worktree teardown command failed");

      expect(existsSync(created.worktreePath)).toBe(true);
      expect(existsSync(join(repoDir, "teardown-start.log"))).toBe(true);
    });
  });
});

describe.skipIf(isPlatform("win32"))("async worktree metadata", () => {
  it("serializes metadata mutations per worktree while another worktree progresses", async () => {
    const root = mkdtempSync(join(tmpdir(), "worktree-metadata-order-"));
    const first = join(root, "first");
    const second = join(root, "second");
    mkdirSync(join(first, ".git"), { recursive: true });
    mkdirSync(join(second, ".git"), { recursive: true });
    try {
      await writeMixerWorktreeMetadata(first, { baseRefName: "main" });
      await writeMixerWorktreeMetadata(second, { baseRefName: "release" });
      const order: string[] = [];
      const runtime = writeMixerWorktreeRuntimeMetadata(first, { worktreePort: 4101 }).then(() =>
        order.push("first-runtime"),
      );
      const unrelated = writeMixerWorktreeRuntimeMetadata(second, { worktreePort: 4102 }).then(() =>
        order.push("second-runtime"),
      );
      const naming = writeMixerWorktreeFirstAgentBranchAutoNameMetadata(first, {
        placeholderBranchName: "topic",
      }).then(() => order.push("first-naming"));
      // A read issued while writes are pending observes their completed snapshot.
      const snapshot = readMixerWorktreeMetadata(first);
      await Promise.all([runtime, unrelated, naming]);
      expect(order.indexOf("first-runtime")).toBeLessThan(order.indexOf("first-naming"));
      expect(await snapshot).toMatchObject({
        baseRefName: "main",
        runtime: { worktreePort: 4101 },
        firstAgentBranchAutoName: { status: "pending", placeholderBranchName: "topic" },
      });
      expect(await readMixerWorktreeMetadata(second)).toMatchObject({
        baseRefName: "release",
        runtime: { worktreePort: 4102 },
      });
      const alias = join(root, "first-alias");
      symlinkSync(first, alias, "dir");
      await Promise.all([
        writeMixerWorktreeRuntimeMetadata(first, { worktreePort: 4103 }),
        writeMixerWorktreeFirstAgentBranchAutoNameMetadata(alias, {
          placeholderBranchName: "renamed",
        }),
      ]);
      expect(await readMixerWorktreeMetadata(first)).toMatchObject({
        runtime: { worktreePort: 4103 },
        firstAgentBranchAutoName: { placeholderBranchName: "renamed" },
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("a queued metadata mutation cannot recreate an archived Git directory", async () => {
    const root = mkdtempSync(join(tmpdir(), "worktree-metadata-archive-"));
    mkdirSync(join(root, ".git"));
    try {
      await writeMixerWorktreeMetadata(root, { baseRefName: "main" });
      const pending = writeMixerWorktreeRuntimeMetadata(root, { worktreePort: 4101 });
      // The mutation is queued in a microtask, so archive wins this ordering.
      rmSync(join(root, ".git"), { recursive: true });
      await expect(pending).rejects.toThrow("Not a git repository");
      expect(existsSync(join(root, ".git"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("recognizes a removed worktree under a symlinked ownership root", async () => {
    const root = mkdtempSync(join(tmpdir(), "worktree-ownership-alias-"));
    const actual = join(root, "actual");
    const alias = join(root, "worktrees");
    mkdirSync(actual);
    symlinkSync(actual, alias, "dir");
    try {
      const cwd = join(alias, "project", "removed");
      expect(
        await isMixerOwnedWorktreeCwd(cwd, { worktreesRoot: alias, knownGitCommonDir: null }),
      ).toMatchObject({ allowed: true, worktreePath: cwd });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects oversized metadata and named pipes without reading them whole", async () => {
    const root = mkdtempSync(join(tmpdir(), "worktree-metadata-admission-"));
    mkdirSync(join(root, ".git", "mixer"), { recursive: true });
    try {
      const path = await getMixerWorktreeMetadataPath(root);
      writeFileSync(path, JSON.stringify({ version: 1, baseRefName: "x".repeat(64 * 1024) }));
      await expect(readMixerWorktreeMetadata(root)).rejects.toThrow(
        "Invalid Mixer worktree metadata file",
      );
      rmSync(path);
      execFileSync("mkfifo", [path]);
      await expect(readMixerWorktreeMetadata(root)).rejects.toThrow(
        "Invalid Mixer worktree metadata file",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
