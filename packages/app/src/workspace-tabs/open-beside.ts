import { revealWorkspaceTab } from "./navigation";
import type { OpenInSidePanePreferences } from "@/hooks/use-settings";
import {
  collectAllTabs,
  collectAllPanes,
  DEFAULT_PANE_ID,
  findPaneById,
  findPaneContainingTab,
  selectSheetTab,
  useWorkspaceLayoutStore,
  type WorkspaceTabPlacement,
} from "@/stores/workspace-layout-store";
import { getPanelInstanceAttributes } from "@/panels/panel-instance-attributes";
import { workspaceTabTargetsEqual } from "@/workspace-tabs/identity";
import type { WorkspaceTabTarget } from "@/workspace-tabs/model";
import { usePreviewTabs, keepPreviewTabOpen } from "./preview";

export type OpenInSidePaneSource = keyof OpenInSidePanePreferences;
export type WorkspaceTargetOpenLocation = "main" | "side";

interface OpenWorkspaceTargetInput {
  workspaceKey: string | null;
  target: WorkspaceTabTarget;
  parentTabId?: string | null;
}

export interface OpenPreferredWorkspaceTargetInput extends OpenWorkspaceTargetInput {
  source: OpenInSidePaneSource;
  preferences: OpenInSidePanePreferences;
}

interface OpenWorkspaceTargetAtLocationInput extends OpenWorkspaceTargetInput {
  location: WorkspaceTargetOpenLocation;
}

interface OpenPreferredWorkspacePreviewInput extends OpenPreferredWorkspaceTargetInput {
  serverId: string;
  workspaceId: string;
  explorerSidebarPaneId: string | null;
  lastMainPaneId: string | null;
}

/** A side pane exists only where the workspace renders split panes. */
function canOpenBeside(): boolean {
  return useWorkspaceLayoutStore.getState().layoutMode === "split-panes";
}

function resolveMainPane(input: {
  workspaceKey: string;
  explorerSidebarPaneId: string | null;
  lastMainPaneId: string | null;
}) {
  const layout = useWorkspaceLayoutStore.getState().layoutByWorkspace[input.workspaceKey];
  if (!layout) return null;
  const panes = collectAllPanes(layout.root);
  return (
    panes.find(
      (pane) =>
        pane.id === input.lastMainPaneId &&
        pane.id !== input.explorerSidebarPaneId &&
        pane.hidden !== true,
    ) ??
    panes.find((pane) => pane.id === DEFAULT_PANE_ID && pane.hidden !== true) ??
    panes.find((pane) => pane.id !== input.explorerSidebarPaneId && pane.hidden !== true) ??
    null
  );
}

function canReplacePreview(input: {
  serverId: string;
  workspaceId: string;
  tabId: string;
}): boolean {
  return !getPanelInstanceAttributes({
    serverId: input.serverId,
    workspaceId: input.workspaceId,
    tabId: input.tabId,
  }).modified;
}

function samePreviewIdentity(left: WorkspaceTabTarget, right: WorkspaceTabTarget): boolean {
  if (left.kind === "file" && right.kind === "file") return left.path === right.path;
  return workspaceTabTargetsEqual(left, right);
}

/** Opens an implicit target according to its source-specific desktop preference. */
export function openPreferredWorkspaceTarget(
  input: OpenPreferredWorkspaceTargetInput,
): string | null {
  return openWorkspaceTargetAtLocation({
    workspaceKey: input.workspaceKey,
    target: input.target,
    location: input.preferences[input.source] ? "side" : "main",
    parentTabId: input.parentTabId,
  });
}

/** Opens an implicit target at the user's preferred main or side location. */
export function openWorkspaceTargetAtLocation(
  input: OpenWorkspaceTargetAtLocationInput,
): string | null {
  if (!input.workspaceKey) return null;
  const store = useWorkspaceLayoutStore.getState();
  const layout = store.layoutByWorkspace[input.workspaceKey];
  const targetAlreadyExists = Boolean(
    layout &&
    collectAllTabs(layout.root).some((tab) => workspaceTabTargetsEqual(tab.target, input.target)),
  );
  const shouldOpenBeside = canOpenBeside() && input.location === "side";
  let placement: WorkspaceTabPlacement | undefined;
  if (shouldOpenBeside && !targetAlreadyExists) {
    const paneId = store.ensureSidePane(input.workspaceKey);
    placement = paneId ? { mode: "prefer", paneId } : undefined;
  } else if (!shouldOpenBeside && layout && input.parentTabId) {
    // A target opened from a tab belongs in that tab's pane, whichever pane has focus.
    const parentPane = findPaneContainingTab(layout.root, input.parentTabId);
    placement = parentPane ? { mode: "prefer", paneId: parentPane.id } : undefined;
  }
  return revealWorkspaceTab(
    input.workspaceKey,
    store.openTab({
      workspaceKey: input.workspaceKey,
      target: input.target,
      intent: "reveal",
      placement,
      parentTabId: input.parentTabId ?? undefined,
    }),
  );
}

/** Opens a tree selection while reusing an unmodified preview in its destination pane. */
export function openPreferredWorkspacePreview(
  input: OpenPreferredWorkspacePreviewInput,
): string | null {
  if (!input.workspaceKey) return null;
  if (input.target.kind !== "file" && input.target.kind !== "working_diff")
    return openPreferredWorkspaceTarget(input);
  const store = useWorkspaceLayoutStore.getState();
  const layout = store.layoutByWorkspace[input.workspaceKey];
  if (!layout) return null;
  const existing = collectAllTabs(layout.root).some((tab) =>
    samePreviewIdentity(tab.target, input.target),
  );
  // The sheet is already a single replaceable slot, so it needs no preview tab.
  if (
    existing ||
    selectSheetTab(store, { workspaceKey: input.workspaceKey, target: input.target }) !== null
  ) {
    return revealWorkspaceTab(
      input.workspaceKey,
      store.openTab({ workspaceKey: input.workspaceKey, target: input.target, intent: "reveal" }),
    );
  }

  const mainPane = resolveMainPane({
    workspaceKey: input.workspaceKey,
    explorerSidebarPaneId: input.explorerSidebarPaneId,
    lastMainPaneId: input.lastMainPaneId,
  });
  const destinationPaneId =
    canOpenBeside() && input.preferences[input.source]
      ? store.ensureSidePane(input.workspaceKey)
      : mainPane?.id;
  if (!destinationPaneId) return null;
  return openWorkspacePreviewInPane({
    workspaceKey: input.workspaceKey,
    serverId: input.serverId,
    workspaceId: input.workspaceId,
    target: input.target,
    paneId: destinationPaneId,
    parentTabId: input.parentTabId,
  });
}

export function openWorkspacePreviewInPane(input: {
  workspaceKey: string;
  serverId: string;
  workspaceId: string;
  target: WorkspaceTabTarget;
  paneId: string;
  parentTabId?: string | null;
}): string | null {
  const store = useWorkspaceLayoutStore.getState();
  const nextLayout = store.layoutByWorkspace[input.workspaceKey];
  const existing =
    nextLayout &&
    collectAllTabs(nextLayout.root).find((tab) => samePreviewIdentity(tab.target, input.target));
  if (existing)
    return revealWorkspaceTab(
      input.workspaceKey,
      store.openTab({ workspaceKey: input.workspaceKey, target: input.target, intent: "reveal" }),
    );
  const destinationPaneId = input.paneId;
  const destinationPane = nextLayout ? findPaneById(nextLayout.root, destinationPaneId) : null;
  const previews = usePreviewTabs.getState().previews[input.workspaceKey];
  const previewTab = nextLayout
    ? collectAllTabs(nextLayout.root).find(
        (tab) => destinationPane?.tabIds.includes(tab.tabId) && previews?.has(tab.tabId),
      )
    : null;
  if (
    previewTab &&
    canReplacePreview({
      serverId: input.serverId,
      workspaceId: input.workspaceId,
      tabId: previewTab.tabId,
    })
  ) {
    const tabId = store.replaceTab(input.workspaceKey, previewTab.tabId, input.target);
    keepPreviewTabOpen(input.workspaceKey, previewTab.tabId);
    if (tabId) usePreviewTabs.getState().preview(input.workspaceKey, tabId);
    return revealWorkspaceTab(input.workspaceKey, tabId);
  }
  if (previewTab) keepPreviewTabOpen(input.workspaceKey, previewTab.tabId);
  const tabId = store.openTab({
    workspaceKey: input.workspaceKey,
    target: input.target,
    intent: "reveal",
    placement: { mode: "pane", paneId: destinationPaneId },
    parentTabId: input.parentTabId ?? destinationPane?.focusedTabId ?? undefined,
  });
  if (tabId) usePreviewTabs.getState().preview(input.workspaceKey, tabId);
  return revealWorkspaceTab(input.workspaceKey, tabId);
}

/**
 * Explicit Open to Side: creates the side pane and places the target there. Without split panes
 * the target opens like any other.
 */
export function openWorkspaceTargetBeside(input: OpenWorkspaceTargetInput): string | null {
  if (!input.workspaceKey) return null;
  if (!canOpenBeside()) {
    return openWorkspaceTargetAtLocation({ ...input, location: "main" });
  }
  const store = useWorkspaceLayoutStore.getState();
  const paneId = store.ensureSidePane(input.workspaceKey);
  return revealWorkspaceTab(
    input.workspaceKey,
    store.openTab({
      workspaceKey: input.workspaceKey,
      target: input.target,
      intent: "reveal",
      placement: paneId ? { mode: "pane", paneId } : undefined,
      parentTabId: input.parentTabId ?? undefined,
    }),
  );
}
