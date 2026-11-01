import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: vi.fn(async () => null),
    setItem: vi.fn(async () => undefined),
    removeItem: vi.fn(async () => undefined),
  },
}));

import { usePanelStore } from "@/stores/panel-store";
import {
  collectAllTabs,
  findPaneById,
  selectExplorerSidebarPaneId,
  useWorkspaceLayoutStore,
} from "@/stores/workspace-layout-store";
import {
  isExplorerSidebarOpen,
  openExplorerSidebarView,
  resolveExplorerSidebarPresentation,
  toggleExplorerSidebar,
} from "@/workspace-tabs/explorer-sidebar";
import { SOURCE_CONTROL_TARGET } from "./source-control";
import { SEARCH_TARGET } from "./explorer-navigation";
import {
  inheritNewWorkspaceExplorer,
  useNewWorkspaceExplorerSelection,
  NEW_WORKSPACE_EXPLORER_KEY,
} from "@/screens/new-workspace/explorer-state";
import {
  createWorkspaceLayoutWithExplorerSidebar,
  normalizeLayout,
  restoreWorkspaceLayout,
} from "@/stores/workspace-layout-actions";

const WORKSPACE_KEY = "server-1:ws-main";
const SEARCH_TAB_ID = "plugin_workspace_6_search_6_search";

beforeEach(() => {
  useWorkspaceLayoutStore.setState({
    layoutByWorkspace: {},
    explorerSidebarPaneIdByWorkspace: {},
    sidePaneIdByWorkspace: {},
    splitSizesByWorkspace: {},
  });
  usePanelStore.setState({
    mobilePanel: { target: "agent", revision: 0 },
  });
});

describe("Explorer sidebar", () => {
  it.each([
    ["files", { kind: "files" }],
    ["search", SEARCH_TARGET],
    ["source-control", SOURCE_CONTROL_TARGET],
  ] as const)("keeps the creation Explorer open on %s after workspace creation", (view, target) => {
    const store = useWorkspaceLayoutStore.getState();
    store.setLayoutMode("split-panes");
    store.resizeExplorerSidebar(NEW_WORKSPACE_EXPLORER_KEY, 384);
    useNewWorkspaceExplorerSelection.getState().select(view);
    inheritNewWorkspaceExplorer("server-1", "ws-main");
    expect(isExplorerSidebarOpen({ isCompact: false, workspaceKey: WORKSPACE_KEY })).toBe(true);
    const state = useWorkspaceLayoutStore.getState();
    expect(state.explorerSidebarWidthByWorkspace[WORKSPACE_KEY]).toBe(384);
    const layout = state.layoutByWorkspace[WORKSPACE_KEY];
    const pane = findPaneById(layout.root, state.explorerSidebarPaneIdByWorkspace[WORKSPACE_KEY]!);
    expect(
      collectAllTabs(layout.root).find((tab) => tab.tabId === pane?.focusedTabId)?.target,
    ).toEqual(target);
    store.hideExplorerSidebar(WORKSPACE_KEY);
    expect(isExplorerSidebarOpen({ isCompact: false, workspaceKey: WORKSPACE_KEY })).toBe(false);
  });
  it("does not open a compact overlay during creation handoff", () => {
    const store = useWorkspaceLayoutStore.getState();
    store.setLayoutMode("compact");
    try {
      inheritNewWorkspaceExplorer("server-1", "ws-main");
      expect(isExplorerSidebarOpen({ isCompact: true, workspaceKey: WORKSPACE_KEY })).toBe(false);
      expect(useWorkspaceLayoutStore.getState().layoutByWorkspace[WORKSPACE_KEY]).toBeUndefined();
    } finally {
      store.setLayoutMode("split-panes");
    }
  });
  it("selects Source Control by default in a new workspace", () => {
    const layout = createWorkspaceLayoutWithExplorerSidebar();
    const pane = findPaneById(layout.root, "explorer")!;
    const tab = collectAllTabs(layout.root).find(
      (candidate) => candidate.tabId === pane.focusedTabId,
    )!;
    expect(tab.target).toEqual(SOURCE_CONTROL_TARGET);
    expect(pane.tabIds).toEqual(["files", SEARCH_TAB_ID, tab.tabId]);
  });
  it("restores old Changes tabs as one fixed Source Control tab without losing Files", () => {
    const saved = normalizeLayout({
      root: {
        kind: "pane",
        pane: {
          id: "explorer",
          focusedTabId: "changes_tree",
          tabs: [
            { tabId: "files", target: { kind: "files" }, createdAt: 1 },
            { tabId: "changes_tree", target: { kind: "changes_tree" }, createdAt: 2 },
            { tabId: "duplicate-source-control", target: SOURCE_CONTROL_TARGET, createdAt: 3 },
          ],
        },
      },
      focusedPaneId: "explorer",
    });
    const restored = restoreWorkspaceLayout(saved, "explorer");
    expect(collectAllTabs(restored.root).map((tab) => tab.target)).toEqual([
      { kind: "new_tab" },
      { kind: "files" },
      SEARCH_TARGET,
      SOURCE_CONTROL_TARGET,
    ]);
    expect(findPaneById(restored.root, "explorer")?.tabIds).toEqual([
      "files",
      SEARCH_TAB_ID,
      "changes_tree",
    ]);
    expect(restoreWorkspaceLayout(restored, "explorer")).toEqual(restored);
  });
  it("keeps Files before fixed Source Control when closing, moving, or reordering tabs", () => {
    openExplorerSidebarView({ isCompact: false, workspaceKey: WORKSPACE_KEY, view: "changes" });
    const store = useWorkspaceLayoutStore.getState();
    const layout = store.layoutByWorkspace[WORKSPACE_KEY];
    const pane = findPaneById(layout.root, "explorer")!;
    const source = collectAllTabs(layout.root).find((tab) => tab.tabId === pane.focusedTabId)!;
    expect(source.target).toEqual(SOURCE_CONTROL_TARGET);
    expect(pane.tabIds).toEqual(["files", SEARCH_TAB_ID, source.tabId]);
    store.closeTab(WORKSPACE_KEY, source.tabId);
    store.moveTabToPane(WORKSPACE_KEY, source.tabId, "main");
    store.reorderTabsInPane(WORKSPACE_KEY, "explorer", pane.tabIds.toReversed());
    const restored = useWorkspaceLayoutStore.getState().layoutByWorkspace[WORKSPACE_KEY];
    expect(findPaneById(restored.root, "explorer")?.tabIds).toEqual([
      "files",
      SEARCH_TAB_ID,
      source.tabId,
    ]);
    expect(findPaneById(restored.root, "main")?.tabIds).not.toContain(source.tabId);
    expect(
      collectAllTabs(restored.root).filter((tab) => tab.target.kind === "changes_tree"),
    ).toEqual([]);
  });
  it("selects the Explorer shell from the form factor", () => {
    expect(resolveExplorerSidebarPresentation({ isCompact: true })).toBe("overlay");
    expect(resolveExplorerSidebarPresentation({ isCompact: false })).toBe("dock");
  });

  it("puts reopened Files before Source Control", () => {
    openExplorerSidebarView({ isCompact: false, workspaceKey: WORKSPACE_KEY, view: "changes" });
    useWorkspaceLayoutStore.getState().closeTab(WORKSPACE_KEY, "files");
    openExplorerSidebarView({ isCompact: false, workspaceKey: WORKSPACE_KEY, view: "files" });
    const layout = useWorkspaceLayoutStore.getState().layoutByWorkspace[WORKSPACE_KEY];
    const sourceId = collectAllTabs(layout.root).find(
      (tab) => tab.target.kind === "plugin" && tab.target.pluginId === "source-control",
    )!.tabId;
    expect(findPaneById(layout.root, "explorer")?.tabIds).toEqual([
      "files",
      SEARCH_TAB_ID,
      sourceId,
    ]);
  });
  it("keeps Search next to Files and prevents closing or moving the built-in navigation", () => {
    openExplorerSidebarView({ isCompact: false, workspaceKey: WORKSPACE_KEY, view: "files" });
    const store = useWorkspaceLayoutStore.getState();
    store.closeTab(WORKSPACE_KEY, SEARCH_TAB_ID);
    store.moveTabToPane(WORKSPACE_KEY, SEARCH_TAB_ID, "main");
    const layout = useWorkspaceLayoutStore.getState().layoutByWorkspace[WORKSPACE_KEY];
    expect(findPaneById(layout.root, "explorer")?.tabIds.slice(0, 2)).toEqual([
      "files",
      SEARCH_TAB_ID,
    ]);
    expect(findPaneById(layout.root, "main")?.tabIds).not.toContain(SEARCH_TAB_ID);
  });

  it("uses the same Explorer pane inside the compact overlay", () => {
    openExplorerSidebarView({
      isCompact: true,
      workspaceKey: WORKSPACE_KEY,
      view: "changes",
    });

    expect(usePanelStore.getState().mobilePanel.target).toBe("file-explorer");
    const state = useWorkspaceLayoutStore.getState();
    const layout = state.layoutByWorkspace[WORKSPACE_KEY];
    const pane = findPaneById(layout.root, selectExplorerSidebarPaneId(state, WORKSPACE_KEY)!);
    expect(
      collectAllTabs(layout.root).find((tab) => tab.tabId === pane?.focusedTabId)?.target,
    ).toEqual(SOURCE_CONTROL_TARGET);
  });

  it("creates a dedicated desktop Explorer containing only its requested tree", () => {
    openExplorerSidebarView({
      isCompact: false,
      workspaceKey: WORKSPACE_KEY,
      view: "files",
    });

    const state = useWorkspaceLayoutStore.getState();
    const layout = state.layoutByWorkspace[WORKSPACE_KEY];
    const paneId = selectExplorerSidebarPaneId(state, WORKSPACE_KEY);
    expect(paneId).not.toBeNull();
    expect(layout && collectAllTabs(layout.root).map((tab) => tab.target.kind)).toContain("files");
  });

  it("toggles the desktop Explorer independently of ordinary panes", () => {
    const input = {
      isCompact: false,
      workspaceKey: WORKSPACE_KEY,
    };
    openExplorerSidebarView({ ...input, view: "files" });
    toggleExplorerSidebar(input);
    expect(isExplorerSidebarOpen(input)).toBe(false);
    toggleExplorerSidebar(input);
    expect(isExplorerSidebarOpen(input)).toBe(true);
    const openedState = useWorkspaceLayoutStore.getState();
    const openedLayout = openedState.layoutByWorkspace[WORKSPACE_KEY];
    const explorerPaneId = selectExplorerSidebarPaneId(openedState, WORKSPACE_KEY);
    const explorerPane =
      openedLayout && explorerPaneId ? findPaneById(openedLayout.root, explorerPaneId) : null;
    const activeExplorerTarget =
      openedLayout && explorerPane
        ? collectAllTabs(openedLayout.root).find((tab) => tab.tabId === explorerPane.focusedTabId)
            ?.target.kind
        : null;
    expect(activeExplorerTarget).toBe("files");
  });

  it("toggles the compact Explorer without changing its selected view", () => {
    const input = {
      isCompact: true,
      workspaceKey: WORKSPACE_KEY,
    };

    toggleExplorerSidebar(input);

    expect(isExplorerSidebarOpen(input)).toBe(true);
  });
});
