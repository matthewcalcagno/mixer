import { create } from "zustand";
import { useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import type { WorkspaceTabTarget } from "@/workspace-tabs/model";
import { SEARCH_TARGET } from "@/workspace-tabs/explorer-navigation";
import { SOURCE_CONTROL_TARGET } from "@/workspace-tabs/source-control";

export const NEW_WORKSPACE_EXPLORER_KEY = "new-workspace";
export type NewWorkspaceExplorerView = "files" | "search" | "source-control";
interface ExplorerSelection {
  view: NewWorkspaceExplorerView;
  select(view: NewWorkspaceExplorerView): void;
}
export const useNewWorkspaceExplorerSelection = create<ExplorerSelection>((set) => ({
  view: "files",
  select: (view) => set({ view }),
}));
const targets: Record<NewWorkspaceExplorerView, WorkspaceTabTarget> = {
  files: { kind: "files" },
  search: SEARCH_TARGET,
  "source-control": SOURCE_CONTROL_TARGET,
};

/** Prepare the destination before navigation, so its first frame retains the creation dock. */
export function inheritNewWorkspaceExplorer(serverId: string, workspaceId: string): void {
  const store = useWorkspaceLayoutStore.getState();
  if (store.layoutMode === "compact") return;
  const workspaceKey = `${serverId}:${workspaceId}`;
  const paneId = store.showExplorerSidebar(workspaceKey);
  if (!paneId) return;
  const width = store.explorerSidebarWidthByWorkspace[NEW_WORKSPACE_EXPLORER_KEY];
  if (width !== undefined) store.resizeExplorerSidebar(workspaceKey, width);
  store.openTab({
    workspaceKey,
    target: targets[useNewWorkspaceExplorerSelection.getState().view],
    intent: "reveal",
    placement: { mode: "pane", paneId },
  });
}
