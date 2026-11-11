import { deriveWorkspacePaneState } from "@/screens/workspace/workspace-pane-state";
import { useEffect } from "react";
import {
  buildWorkspaceExplorerStateKey,
  useFileExplorerActions,
} from "@/hooks/use-file-explorer-actions";
import { resolveWorkspaceFilePaths } from "@/workspace/file-open";
import { parentExplorerPath } from "@/utils/explorer-paths";
import { isHiddenExplorerPath } from "@/file-explorer/visibility";
import { useSessionStore } from "@/stores/session-store";
import { usePanelStore } from "@/stores/panel-store";

export function useAutoRevealFile(input: {
  serverId: string;
  workspaceId: string;
  workspaceRoot: string | null;
  paneState: Parameters<typeof deriveWorkspacePaneState>[0];
  routeFocused: boolean;
  explorerShowing: boolean;
}) {
  const { revealDirectory, selectExplorerEntry } = useFileExplorerActions(input);
  const target = deriveWorkspacePaneState(input.paneState).activeTab?.descriptor.target;
  const path = target?.kind === "file" ? target.path : null;
  const enabled = input.routeFocused && input.explorerShowing;
  const { workspaceRoot, serverId, workspaceId } = input;
  useEffect(() => {
    if (!enabled || !path || !workspaceRoot) return;
    const relativePath = resolveWorkspaceFilePaths({ path, workspaceRoot })?.relativePath;
    if (!relativePath) return;
    const panel = usePanelStore.getState();
    if (isHiddenExplorerPath(relativePath) && !panel.explorerShowHiddenFiles)
      panel.toggleExplorerShowHiddenFiles();
    const key = buildWorkspaceExplorerStateKey({ workspaceId, workspaceRoot });
    const explorer = key
      ? useSessionStore.getState().sessions[serverId]?.fileExplorer.get(key)
      : undefined;
    const expanded = key ? usePanelStore.getState().expandedPathsByWorkspace[key] : undefined;
    const ancestors = relativePath
      .split("/")
      .slice(0, -1)
      .map((_, index, parts) => parts.slice(0, index + 1).join("/"));
    // Tree-origin opens already have loaded, expanded ancestors. Finish synchronously
    // so a subsequent manual collapse cannot be undone by a pending reveal.
    if (
      explorer?.directories.has(".") &&
      ancestors.every(
        (ancestor) => expanded?.includes(ancestor) && explorer.directories.has(ancestor),
      )
    ) {
      selectExplorerEntry(relativePath, { reveal: true });
      return;
    }
    let cancelled = false;
    async function reveal(filePath: string) {
      await revealDirectory(parentExplorerPath(filePath));
      if (cancelled) return;
      selectExplorerEntry(filePath, { reveal: true });
    }
    // Directory-listing failures are already surfaced by the explorer request owner.
    void reveal(relativePath).catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [enabled, path, workspaceRoot, serverId, workspaceId, revealDirectory, selectExplorerEntry]);
}
