export interface GitFileStatus {
  path: string;
  index: string;
  worktree: string;
}
export type GitDecoration = "M" | "U" | "A" | "D" | "!";
const priority: Record<GitDecoration, number> = { U: 1, A: 2, M: 3, D: 4, "!": 5 };
/** Git uses repo-relative paths; the RPC scopes them to the explorer's workspace root. */
export function buildGitDecorations(files: readonly GitFileStatus[]): Map<string, GitDecoration> {
  const result = new Map<string, GitDecoration>();
  for (const file of files) {
    const xy = file.index + file.worktree;
    const status = gitDecorationStatus(xy);
    const parts = file.path.split("/");
    while (parts.length) {
      const key = parts.join("/");
      const previous = result.get(key);
      if (!previous || priority[status] > priority[previous]) result.set(key, status);
      parts.pop();
    }
  }
  return result;
}

function gitDecorationStatus(xy: string): GitDecoration {
  if (xy === "??") return "U";
  if (xy.includes("U") || xy === "AA" || xy === "DD") return "!";
  if (xy.includes("D")) return "D";
  if (xy.includes("A")) return "A";
  return "M";
}
