import { supportsDesktopPaneSplits } from "@/constants/layout";
import { revealWorkspaceTab } from "./navigation";
import {
  collectAllPanes,
  collectAllTabs,
  createWorkspaceLayoutWithExplorerSidebar,
  DEFAULT_PANE_ID,
  findPaneContainingTab,
  resolveExplorerSidebarPaneId,
  useWorkspaceLayoutStore,
} from "@/stores/workspace-layout-store";
import type { OpenInSidePanePreferences, PullRequestOpenLocation } from "@/hooks/use-settings";
import {
  openExplorerSidebarView,
  type ExplorerSidebarView,
} from "@/workspace-tabs/explorer-sidebar";
import { openWorkspaceTargetAtLocation } from "@/workspace-tabs/open-beside";
import { isSourceControlTarget } from "./source-control";

interface WorkspaceViewInput {
  isCompact: boolean;
  workspaceKey: string | null;
  supportsPaneSplits?: boolean;
}

interface OpenWorkspaceChangesInput extends WorkspaceViewInput {
  preferences: OpenInSidePanePreferences;
}

interface OpenWorkspacePullRequestInput extends WorkspaceViewInput {
  destination: PullRequestOpenLocation;
}

function supportingViewsBelongInExplorer(input: WorkspaceViewInput): boolean {
  return input.isCompact || !(input.supportsPaneSplits ?? supportsDesktopPaneSplits());
}

function openExplorerView(input: WorkspaceViewInput, view: ExplorerSidebarView): void {
  openExplorerSidebarView({ ...input, view });
}

/** Git entry points always reveal the fixed Source Control panel. */
export function openWorkspaceChanges(input: OpenWorkspaceChangesInput): string | null {
  openExplorerView(input, "changes");
  return null;
}

/** The composer uses the same Source Control destination as other Git entry points. */
export function openComposerChanges(input: OpenWorkspaceChangesInput): string | null {
  return openWorkspaceChanges(input);
}

/** Opens the workspace pull request at its semantic destination. */
export function openWorkspacePullRequest(input: OpenWorkspacePullRequestInput): string | null {
  if (!input.workspaceKey) return null;
  let tabId: string | null;
  if (supportingViewsBelongInExplorer(input) || input.destination === "explorer") {
    const store = useWorkspaceLayoutStore.getState();
    const paneId = store.ensureExplorerSidebar(input.workspaceKey);
    tabId = store.openTab({
      workspaceKey: input.workspaceKey,
      target: { kind: "pull_request" },
      intent: "reveal",
      placement: paneId ? { mode: "prefer", paneId } : undefined,
    });
  } else {
    return openWorkspaceTargetAtLocation({
      workspaceKey: input.workspaceKey,
      target: { kind: "pull_request" },
      location: input.destination,
    });
  }
  revealWorkspaceTab(input.workspaceKey, tabId);
  return tabId;
}

/** Adds a detected desktop PR once without revealing or selecting its destination. */
export function autoOpenWorkspacePullRequest(input: {
  workspaceKey: string | null;
  destination: PullRequestOpenLocation;
}): string | null {
  if (!input.workspaceKey) return null;
  const workspaceKey = input.workspaceKey;
  const store = useWorkspaceLayoutStore.getState();
  return store.autoOpenPullRequestTab(workspaceKey, () => {
    const layout =
      store.layoutByWorkspace[workspaceKey] ?? createWorkspaceLayoutWithExplorerSidebar();
    // A background open finds an existing PR tab wherever the user left it.
    if (collectAllTabs(layout.root).some((tab) => tab.target.kind === "pull_request")) {
      return {};
    }
    const explorerPaneId = resolveExplorerSidebarPaneId(
      layout,
      store.explorerSidebarPaneIdByWorkspace[workspaceKey],
    );
    let paneId = explorerPaneId;
    if (input.destination === "side") {
      paneId = store.ensureSidePane(workspaceKey, { focus: false });
    } else if (input.destination === "main") {
      const panes = collectAllPanes(layout.root);
      const mainPane =
        panes.find((pane) => pane.id === DEFAULT_PANE_ID) ??
        panes.find((pane) => pane.id !== explorerPaneId && !pane.hidden);
      paneId = mainPane?.id ?? null;
    }
    const changes =
      input.destination === "explorer"
        ? collectAllTabs(layout.root).find(
            (tab) =>
              isSourceControlTarget(tab.target) &&
              findPaneContainingTab(layout.root, tab.tabId)?.id === paneId,
          )
        : undefined;
    return {
      placement: paneId ? { mode: "prefer", paneId } : undefined,
      insertionPosition: changes ? { afterTabId: changes.tabId } : undefined,
    };
  });
}
