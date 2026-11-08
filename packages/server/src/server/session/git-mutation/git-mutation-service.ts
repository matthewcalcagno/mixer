import type pino from "pino";
import {
  checkoutResolvedBranch,
  type CheckoutExistingBranchResult,
  type GitMutationRefreshReason,
} from "../../../utils/checkout-git.js";
import { runGitCommand } from "../../../utils/run-git-command.js";
import type { WorkspaceGitService } from "../../workspace-git-service.js";
import { assertSafeGitRef as assertWorktreeSafeGitRef } from "../../worktree-session.js";

/**
 * The git branch / working-tree mutation primitives a client session performs on a
 * workspace: switch to an existing branch, create a branch from a base, and force a
 * snapshot refresh (plus optional forge cache invalidation) after any mutation.
 *
 * CheckoutSession (the branch/commit/merge commands), the worktree session-config
 * builder, and the auto-naming + worktree-creation paths all funnel their git
 * mutations through this one module, so the validate-ref → execute →
 * refresh sequence lives in a single place instead of being smeared across the
 * session as loose callbacks.
 */
export interface GitMutationService {
  checkoutExistingBranch(cwd: string, branch: string): Promise<CheckoutExistingBranchResult>;
  createBranchFromBase(params: {
    cwd: string;
    baseBranch: string;
    newBranchName: string;
  }): Promise<void>;
  notifyGitMutation(
    cwd: string,
    reason: GitMutationRefreshReason,
    options?: { invalidateForge?: boolean },
  ): Promise<void>;
}

type GitMutationGitSource = Pick<
  WorkspaceGitService,
  "validateBranchRef" | "getSnapshot" | "hasLocalBranch" | "invalidateForge"
>;

export function createGitMutationService(deps: {
  workspaceGitService: GitMutationGitSource;
  logger: pino.Logger;
}): GitMutationService {
  const { workspaceGitService, logger } = deps;

  function assertSafeGitRef(ref: string, label: string): void {
    if (!/^[A-Za-z0-9._/-]+$/.test(ref)) {
      throw new Error(`Invalid ${label}: ${ref}`);
    }
    assertWorktreeSafeGitRef(ref, label);
  }

  async function notifyGitMutation(
    cwd: string,
    reason: GitMutationRefreshReason,
    options?: { invalidateForge?: boolean },
  ): Promise<void> {
    if (options?.invalidateForge) {
      workspaceGitService.invalidateForge(cwd);
    }
    try {
      await workspaceGitService.getSnapshot(cwd, { force: true, reason });
    } catch (error) {
      logger.warn(
        { err: error, cwd, reason },
        "Failed to force-refresh workspace git snapshot after mutation",
      );
    }
  }

  return {
    async checkoutExistingBranch(cwd, branch) {
      assertSafeGitRef(branch, "branch");
      const resolution = await workspaceGitService.validateBranchRef(cwd, branch);
      if (resolution.kind === "not-found") {
        throw new Error(`Branch not found: ${branch}`);
      }
      const result = await checkoutResolvedBranch({ cwd, resolution });
      await notifyGitMutation(cwd, "switch-branch", { invalidateForge: true });
      return result;
    },

    async createBranchFromBase({ cwd, baseBranch, newBranchName }) {
      assertSafeGitRef(baseBranch, "base branch");
      assertSafeGitRef(newBranchName, "new branch");

      const baseResolution = await workspaceGitService.validateBranchRef(cwd, baseBranch);
      if (baseResolution.kind === "not-found") {
        throw new Error(`Base branch not found: ${baseBranch}`);
      }

      const exists = await workspaceGitService.hasLocalBranch(cwd, newBranchName);
      if (exists) {
        throw new Error(`Branch already exists: ${newBranchName}`);
      }

      // --no-track: a branch we create is not a continuation of its base, so it gets no
      // upstream. Without it git hands the new branch `origin/<base>` whenever the base is a
      // remote-tracking ref or branch.autoSetupMerge asks for inheritance, and every later
      // push then reads that upstream and lands the work on the default branch. The worktree
      // path makes the same promise with `git worktree add -b <branch> --no-track <base>`.
      await runGitCommand(["checkout", "-b", newBranchName, "--no-track", baseBranch], {
        cwd,
        timeout: 120_000,
        envOverlay: { LC_ALL: "C" },
      });
      await notifyGitMutation(cwd, "create-branch");
    },

    notifyGitMutation,
  };
}
