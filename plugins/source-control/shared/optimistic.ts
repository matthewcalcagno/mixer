import type { RpcInput, RpcOutput } from "@mixer/plugin";
import type { actionRpc, statusRpc } from "./git.js";

export function optimisticStatus(
  current: RpcOutput<typeof statusRpc>,
  action: RpcInput<typeof actionRpc>["action"],
): RpcOutput<typeof statusRpc> {
  if (action.kind !== "stage" && action.kind !== "unstage" && action.kind !== "discard")
    return current;
  const paths = new Set(action.paths);
  return {
    ...current,
    files: current.files.flatMap((file) => {
      if (!paths.has(file.path) || file.index === "U" || file.worktree === "U") return [file];
      if (action.kind === "discard") {
        if (file.index === "?") return [file];
        return file.index === " " ? [] : [{ ...file, worktree: " ", head: file.index }];
      }
      const head = file.head;
      if (action.kind === "stage") {
        if (head === " ") return [];
        return [{ ...file, index: head === "?" ? "A" : head, worktree: " " }];
      }
      if (head === " ") return [];
      if (head === "?" || (file.index === "A" && head === "A")) {
        return file.worktree === "D" ? [] : [{ ...file, index: "?", worktree: "?" }];
      }
      return [{ ...file, index: " ", worktree: head }];
    }),
  };
}
