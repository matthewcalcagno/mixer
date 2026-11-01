import { useSyncExternalStore } from "react";
import { findPaneById, useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import { editorStatus } from "@/file-panels/source/editor/status";

export function useActiveEditorStatus(serverId: string, workspaceId: string) {
  const tabId = useWorkspaceLayoutStore((state) => {
    const layout = state.layoutByWorkspace[`${serverId}:${workspaceId}`];
    return layout?.focusedPaneId
      ? (findPaneById(layout.root, layout.focusedPaneId)?.focusedTabId ?? null)
      : null;
  });
  const editors = useSyncExternalStore(
    editorStatus.subscribe,
    editorStatus.getSnapshot,
    editorStatus.getSnapshot,
  );
  return tabId ? (editors.get(editorStatus.key(serverId, workspaceId, tabId)) ?? null) : null;
}
