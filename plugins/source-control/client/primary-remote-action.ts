import type { RpcOutput } from "@mixer/plugin";
import type { statusRpc } from "../shared/git.js";

interface RemoteAction {
  kind: "pull" | "sync" | "publish";
  label: string;
  icon: "ArrowDown" | "ArrowUp" | "RefreshCw";
  accessibilityLabel: string;
}

interface PrimaryRemoteActionInput {
  status: RpcOutput<typeof statusRpc> | undefined;
  commitFlowPending: boolean;
  pushing: boolean;
}

export function primaryRemoteAction({
  status,
  commitFlowPending,
  pushing,
}: PrimaryRemoteActionInput): RemoteAction | null {
  if (commitFlowPending || !status || status.files.length > 0 || !status.hasRemote) return null;
  if (!status.upstream && status.branch !== "Detached HEAD")
    return {
      kind: "publish",
      label: "Publish branch",
      icon: "ArrowUp",
      accessibilityLabel: "Publish branch",
    };
  if (status.upstream && status.behind > 0 && status.ahead === 0)
    return {
      kind: "pull",
      label: `Pull ${status.behind}↓`,
      icon: "ArrowDown",
      accessibilityLabel: "Pull incoming commits",
    };
  if (status.ahead > 0 || pushing) {
    const counts = [];
    if (status.behind > 0) counts.push(`${status.behind}↓`);
    if (status.ahead > 0) counts.push(`${status.ahead}↑`);
    return {
      kind: "sync",
      label: ["Sync Changes", ...counts].join(" "),
      icon: "RefreshCw",
      accessibilityLabel: "Sync changes",
    };
  }
  return null;
}
