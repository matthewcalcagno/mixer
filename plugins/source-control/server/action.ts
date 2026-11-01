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
  const committing = action.kind === "commit" || action.kind === "amend";
  if (committing && resourceGroups(current.files).merge.length > 0)
    throw new Error("Resolve merge conflicts before committing.");
  let output: string;
  switch (action.kind) {
    case "stage":
      validatePaths(cwd, action.paths);
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
    case "fetch":
      output = await git(cwd, ["fetch"]);
      break;
    case "pull":
      output = await git(cwd, ["pull", "--ff-only"]);
      break;
    case "push":
      output = await git(cwd, ["push"]);
      break;
    case "sync":
      await git(cwd, ["pull", "--ff-only"]);
      output = await git(cwd, ["push"]);
      break;
    case "patch":
      output = await applyPatch(cwd, action);
      break;
  }
  return output.trim() || "Done";
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
