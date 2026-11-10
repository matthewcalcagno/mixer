import { readFile } from "node:fs/promises";
import { continueOperation } from "./operation.js";
import { resolve } from "node:path";
import type { RpcInput } from "@mixer/plugin";
import type { actionRpc } from "../shared/git.js";
import { resourceGroups } from "../shared/resources.js";
import { diff, git, selectHunk, status, validatePaths } from "./git.js";

type Action = RpcInput<typeof actionRpc>["action"];
interface ActionInput {
  cwd: string;
  revision: string;
  action: Action;
}
export async function executeGitAction({ cwd, revision, action }: ActionInput): Promise<string> {
  const current = await status(cwd);
  if (current.revision !== revision)
    throw new Error("Files changed. Refresh and review the diff before trying again.");
  validateActionState(current, action);
  let output: string;
  switch (action.kind) {
    case "stage":
      validatePaths(cwd, action.paths);
      await validateResolvedFiles(cwd, current, action.paths);
      output = await git(cwd, ["add", "--", ...action.paths]);
      break;
    case "unstage":
      output = await unstage(cwd, action.paths);
      break;
    case "discard":
      validatePaths(cwd, action.paths);
      if (
        action.paths.some(
          (path) => !current.files.some((file) => file.path === path && file.index !== "?"),
        )
      )
        throw new Error("Untracked files are not deleted by this plugin");
      output = await git(cwd, ["restore", "--worktree", "--", ...action.paths]);
      break;
    case "commit":
      output = await git(cwd, ["commit", "-m", action.message]);
      break;
    case "amend":
      output = await git(cwd, ["commit", "--amend", "-m", action.message]);
      break;
    case "continue":
      output = await continueOperation(cwd, requireOperation(current), action.message);
      break;
    case "abort":
      output = await git(cwd, [requireOperation(current).kind, "--abort"]);
      break;
    case "fetch":
      output = await git(cwd, ["fetch"]);
      break;
    case "pull":
      output = await git(cwd, ["pull", "--ff-only"]);
      break;
    case "publish":
      output = await publishBranch(cwd, current);
      break;
    case "push":
      output = await git(cwd, ["push"]);
      break;
    case "sync":
      output = await syncBranch(cwd, current);
      break;
    case "patch":
      output = await applyPatch(cwd, action);
      break;
  }
  return output.trim() || "Done";
}
function validateActionState(current: Awaited<ReturnType<typeof status>>, action: Action): void {
  const committing =
    action.kind === "commit" || action.kind === "amend" || action.kind === "continue";
  if (committing && resourceGroups(current.files).merge.length > 0)
    throw new Error("Resolve merge conflicts before committing.");
  if (current.operation && ["pull", "sync", "push", "publish", "amend"].includes(action.kind))
    throw new Error(`Finish the current ${current.operation.kind} first.`);
}
async function unstage(cwd: string, paths: string[]): Promise<string> {
  validatePaths(cwd, paths);
  const hasHead = await git(cwd, ["rev-parse", "--verify", "HEAD"]).then(
    () => true,
    () => false,
  );
  return git(
    cwd,
    hasHead ? ["restore", "--staged", "--", ...paths] : ["rm", "--cached", "--", ...paths],
  );
}
async function applyPatch(
  cwd: string,
  action: Extract<Action, { kind: "patch" }>,
): Promise<string> {
  const actual = await diff(cwd, action.path, action.staged);
  if (actual !== action.patch) throw new Error("Diff changed. Refresh before trying again.");
  if (action.staged && action.discard) throw new Error("Unstage changes before discarding them");
  const patch = selectHunk(actual, action.hunk);
  const args = [
    "apply",
    ...(action.discard ? [] : ["--cached"]),
    ...(action.staged || action.discard ? ["--reverse"] : []),
  ];
  await git(cwd, [...args, "--check", "-"], patch);
  return git(cwd, [...args, "-"], patch);
}

async function publishBranch(
  cwd: string,
  current: Awaited<ReturnType<typeof status>>,
): Promise<string> {
  if (current.branch === "Detached HEAD") throw new Error("Create a branch before publishing.");
  if (current.upstream)
    throw new Error("This branch already has an upstream. Refresh before pushing.");
  const remotes = (await git(cwd, ["remote"])).trim().split(/\s+/).filter(Boolean);
  const remote = remotes.includes("origin") ? "origin" : remotes[0];
  if (!remote) throw new Error("Add a Git remote before publishing this branch.");
  if (!remotes.includes("origin") && remotes.length > 1)
    throw new Error("Multiple remotes found. Configure an origin remote before publishing.");
  return git(cwd, ["push", "--set-upstream", remote, `HEAD:refs/heads/${current.branch}`]);
}

async function syncBranch(
  cwd: string,
  current: Awaited<ReturnType<typeof status>>,
): Promise<string> {
  if (current.files.length > 0) throw new Error("Commit or stash changes before syncing.");
  if (!current.upstream) throw new Error("Publish this branch before syncing.");
  const branchRebase = (
    await git(cwd, ["config", "--get", `branch.${current.branch}.rebase`]).catch(() => "")
  ).trim();
  const pullRebase =
    branchRebase || (await git(cwd, ["config", "--get", "pull.rebase"]).catch(() => "")).trim();
  if (pullRebase === "interactive")
    throw new Error("Run interactive rebase in a terminal before syncing.");
  // Modern Git requires an explicit strategy for divergent branches. Default to merge;
  // retain the repository's rebase preference and stop before push on any conflict.
  const strategy = pullRebase ? `--rebase=${pullRebase}` : "--no-rebase";
  await git(cwd, ["pull", "--no-edit", strategy]);
  return git(cwd, ["push"]);
}

export async function prepareTrash(
  cwd: string,
  paths: string[],
  revision: string,
): Promise<string[]> {
  validatePaths(cwd, paths);
  const current = await status(cwd);
  if (current.revision !== revision)
    throw new Error("Files changed. Refresh and review before moving files to Trash.");
  if (
    paths.some(
      (path) =>
        !current.files.some(
          (file) => file.path === path && file.index === "?" && file.worktree === "?",
        ),
    )
  )
    throw new Error("Only untracked files can be moved to Trash from this action.");
  return paths.map((path) => resolve(cwd, path));
}

async function validateResolvedFiles(
  cwd: string,
  current: Awaited<ReturnType<typeof status>>,
  paths: string[],
): Promise<void> {
  const conflicts = new Set(resourceGroups(current.files).merge.map((file) => file.path));
  for (const path of paths) {
    if (!conflicts.has(path)) continue;
    const content = await readFile(resolve(cwd, path), "utf8").catch((error) => {
      if (error.code === "ENOENT") return "";
      throw error;
    });
    if (/^(?:<{7,}(?: |$)|\|{7,}(?: |$)|={7,}$|>{7,}(?: |$))/m.test(content))
      throw new Error(`Resolve conflict markers in ${path} before staging.`);
  }
}

function requireOperation(current: Awaited<ReturnType<typeof status>>) {
  if (!current.operation) throw new Error("No Git operation in progress. Refresh and try again.");
  return current.operation;
}
