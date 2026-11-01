import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: vi.fn(async () => null),
    setItem: vi.fn(async () => undefined),
    removeItem: vi.fn(async () => undefined),
  },
}));

import { DEFAULT_APP_SETTINGS } from "@/hooks/use-settings";
import { setPanelInstanceAttributes } from "@/panels/panel-instance-attributes";
import {
  collectAllPanes,
  collectAllTabs,
  findPaneById,
  useWorkspaceLayoutStore,
} from "@/stores/workspace-layout-store";
import {
  openPreferredWorkspacePreview,
  openPreferredWorkspaceTarget,
  openWorkspaceTargetBeside,
  openWorkspacePreviewInPane,
} from "@/workspace-tabs/open-beside";
import { keepPreviewTabOpen, usePreviewTabs } from "./preview";

const WORKSPACE_KEY = "server-1:workspace-1";

beforeEach(() => {
  usePreviewTabs.setState({ previews: {} });
  useWorkspaceLayoutStore.setState({
    layoutMode: "split-panes",
    sheetsByWorkspace: {},
    layoutByWorkspace: {},
    explorerSidebarPaneIdByWorkspace: {},
    sidePaneIdByWorkspace: {},
  });
});

describe("openPreferredWorkspacePreview", () => {
  function prepare() {
    useWorkspaceLayoutStore.getState().openTab({
      workspaceKey: WORKSPACE_KEY,
      target: { kind: "terminal", terminalId: "terminal-1" },
      intent: "reveal",
    });
  }
  function openFile(path: string) {
    const tabId = openPreferredWorkspacePreview({
      workspaceKey: WORKSPACE_KEY,
      serverId: "server-1",
      workspaceId: "workspace-1",
      explorerSidebarPaneId: "explorer",
      lastMainPaneId: "main",
      target: { kind: "file", path },
      source: "explorerFiles",
      preferences: DEFAULT_APP_SETTINGS.openInSidePane,
    });
    if (!tabId) throw new Error("Missing file preview");
    return tabId;
  }
  function targets() {
    const root = useWorkspaceLayoutStore.getState().layoutByWorkspace[WORKSPACE_KEY].root;
    const main = findPaneById(root, "main");
    return collectAllTabs(root)
      .filter((tab) => main?.tabIds.includes(tab.tabId) && tab.target.kind !== "terminal")
      .map((tab) => tab.target);
  }
  it("replaces only the preview and never replaces an explicitly kept tab", () => {
    prepare();
    const first = openFile("a.ts");
    expect(openFile("b.ts")).toBe(first);
    expect(targets()).toEqual([{ kind: "file", path: "b.ts" }]);
    expect(usePreviewTabs.getState().previews[WORKSPACE_KEY].has(first)).toBe(true);
    keepPreviewTabOpen(WORKSPACE_KEY, first);
    const second = openFile("c.ts");
    expect(second).not.toBe(first);
    openFile("b.ts");
    openFile("d.ts");
    expect(targets()).toEqual([
      { kind: "file", path: "b.ts" },
      { kind: "file", path: "d.ts" },
    ]);
    expect(usePreviewTabs.getState().previews[WORKSPACE_KEY].has(first)).toBe(false);
  });
  it("keeps an edited preview permanently after its unsaved state clears", () => {
    prepare();
    const first = openFile("edited.ts");
    const identity = { serverId: "server-1", workspaceId: "workspace-1", tabId: first };
    setPanelInstanceAttributes(identity, { modified: true });
    setPanelInstanceAttributes(identity, { modified: false });
    expect(usePreviewTabs.getState().previews[WORKSPACE_KEY].has(first)).toBe(false);
    openFile("next.ts");
    expect(targets()).toEqual([
      { kind: "file", path: "edited.ts" },
      { kind: "file", path: "next.ts" },
    ]);
  });
  it("shares the replaceable slot with Source Control plugin diffs", () => {
    prepare();
    const first = openFile("a.ts");
    const target = {
      kind: "plugin",
      pluginId: "source-control",
      panelId: "file-diff-a",
      context: "workspace",
    } as const;
    const diff = openWorkspacePreviewInPane({
      workspaceKey: WORKSPACE_KEY,
      serverId: "server-1",
      workspaceId: "workspace-1",
      paneId: "main",
      target,
    });
    expect(diff).not.toBeNull();
    expect(targets()).toEqual([target]);
    expect(usePreviewTabs.getState().previews[WORKSPACE_KEY].has(first)).toBe(false);
    if (!diff) throw new Error("Missing diff preview");
    keepPreviewTabOpen(WORKSPACE_KEY, diff);
    openFile("b.ts");
    expect(targets()).toEqual([target, { kind: "file", path: "b.ts" }]);
  });
  it("does not replace files that were opened permanently", () => {
    prepare();
    useWorkspaceLayoutStore.getState().openTab({
      workspaceKey: WORKSPACE_KEY,
      target: { kind: "file", path: "permanent.ts" },
      intent: "reveal",
    });
    openFile("preview.ts");
    expect(targets()).toEqual([
      { kind: "file", path: "permanent.ts" },
      { kind: "file", path: "preview.ts" },
    ]);
  });
  it("keeps independent preview slots in separate panes", () => {
    prepare();
    openFile("main.ts");
    const paneId = useWorkspaceLayoutStore.getState().ensureSidePane(WORKSPACE_KEY);
    if (!paneId) throw new Error("Missing side pane");
    const sideTabId = openWorkspacePreviewInPane({
      workspaceKey: WORKSPACE_KEY,
      serverId: "server-1",
      workspaceId: "workspace-1",
      paneId,
      target: { kind: "file", path: "side.ts" },
    });
    openFile("next-main.ts");
    const root = useWorkspaceLayoutStore.getState().layoutByWorkspace[WORKSPACE_KEY].root;
    expect(targets()).toEqual([{ kind: "file", path: "next-main.ts" }]);
    expect(findPaneById(root, paneId)?.tabIds).toEqual([sideTabId]);
    expect(collectAllTabs(root).find((tab) => tab.tabId === sideTabId)?.target).toEqual({
      kind: "file",
      path: "side.ts",
    });
  });
  it("opens a compact file preview in the sheet instead of replacing the active file tab", () => {
    const store = useWorkspaceLayoutStore.getState();
    const fileTabId = store.openTab({
      workspaceKey: WORKSPACE_KEY,
      target: { kind: "file", path: "src/open.ts" },
      intent: "reveal",
    });
    store.setLayoutMode("compact");

    const tabId = openPreferredWorkspacePreview({
      workspaceKey: WORKSPACE_KEY,
      serverId: "server-1",
      workspaceId: "workspace-1",
      explorerSidebarPaneId: "explorer",
      lastMainPaneId: "main",
      target: { kind: "file", path: "src/preview.ts" },
      source: "explorerFiles",
      preferences: DEFAULT_APP_SETTINGS.openInSidePane,
    });

    const state = useWorkspaceLayoutStore.getState();
    expect(state.sheetsByWorkspace[WORKSPACE_KEY]?.at(-1)?.tab).toMatchObject({
      tabId,
      target: { kind: "file", path: "src/preview.ts" },
    });
    const root = state.layoutByWorkspace[WORKSPACE_KEY].root;
    expect(findPaneById(root, "main")?.tabIds).toEqual([fileTabId]);
    expect(collectAllTabs(root).find((tab) => tab.tabId === fileTabId)?.target).toEqual({
      kind: "file",
      path: "src/open.ts",
    });
  });
});

describe("previews under a sheet with unsaved work", () => {
  const sheetTarget = { kind: "file" as const, path: "src/draft.ts" };
  let sheetTabId: string | null = null;

  afterEach(() => {
    if (sheetTabId) {
      setPanelInstanceAttributes(
        { serverId: "server-1", workspaceId: "workspace-1", tabId: sheetTabId },
        { modified: false },
      );
    }
    sheetTabId = null;
  });

  function previewFile(path: string): string | null {
    return openPreferredWorkspacePreview({
      workspaceKey: WORKSPACE_KEY,
      serverId: "server-1",
      workspaceId: "workspace-1",
      explorerSidebarPaneId: "explorer",
      lastMainPaneId: "main",
      target: { kind: "file", path },
      source: "explorerFiles",
      preferences: DEFAULT_APP_SETTINGS.openInSidePane,
    });
  }

  it("stacks link previews over the sheet instead of dropping its unsaved work", () => {
    const store = useWorkspaceLayoutStore.getState();
    store.openTab({
      workspaceKey: WORKSPACE_KEY,
      target: { kind: "terminal", terminalId: "term-1" },
      intent: "reveal",
    });
    store.setLayoutMode("compact");
    sheetTabId = store.openTab({
      workspaceKey: WORKSPACE_KEY,
      target: sheetTarget,
      intent: "reveal",
    });
    setPanelInstanceAttributes(
      { serverId: "server-1", workspaceId: "workspace-1", tabId: sheetTabId ?? "" },
      { modified: true },
    );

    previewFile("src/first.ts");
    previewFile("src/second.ts");

    const state = useWorkspaceLayoutStore.getState();
    expect(state.sheetsByWorkspace[WORKSPACE_KEY]?.map((sheet) => sheet.tab.target)).toEqual([
      sheetTarget,
      { kind: "file", path: "src/first.ts" },
      { kind: "file", path: "src/second.ts" },
    ]);
    const root = state.layoutByWorkspace[WORKSPACE_KEY].root;
    expect(findPaneById(root, "main")?.tabIds).toHaveLength(1);
  });
});

describe("opening beside", () => {
  const sidePreference = { ...DEFAULT_APP_SETTINGS.openInSidePane, subagents: true };

  function openSubagentWithSidePreference(): string | null {
    useWorkspaceLayoutStore.getState().openTab({
      workspaceKey: WORKSPACE_KEY,
      target: { kind: "file", path: "src/open.ts" },
      intent: "reveal",
    });
    return openPreferredWorkspaceTarget({
      workspaceKey: WORKSPACE_KEY,
      target: { kind: "file", path: "src/subagent.ts" },
      source: "subagents",
      preferences: sidePreference,
    });
  }

  function paneIdHolding(tabId: string | null): string | undefined {
    const root = useWorkspaceLayoutStore.getState().layoutByWorkspace[WORKSPACE_KEY].root;
    return collectAllPanes(root).find((pane) => pane.tabIds.includes(tabId ?? ""))?.id;
  }

  it("follows the side preference where the workspace renders split panes", () => {
    useWorkspaceLayoutStore.getState().setLayoutMode("split-panes");

    const tabId = openSubagentWithSidePreference();

    const sidePaneId = useWorkspaceLayoutStore.getState().sidePaneIdByWorkspace[WORKSPACE_KEY];
    expect(sidePaneId).toEqual(expect.any(String));
    expect(paneIdHolding(tabId)).toBe(sidePaneId);
  });

  it("keeps a single-pane workspace in one pane despite the side preference", () => {
    useWorkspaceLayoutStore.getState().setLayoutMode("single-pane");

    const preferredTabId = openSubagentWithSidePreference();
    const besideTabId = openWorkspaceTargetBeside({
      workspaceKey: WORKSPACE_KEY,
      target: { kind: "file", path: "src/beside.ts" },
    });

    expect(useWorkspaceLayoutStore.getState().sidePaneIdByWorkspace[WORKSPACE_KEY]).toBeFalsy();
    expect(paneIdHolding(preferredTabId)).toBe("main");
    expect(paneIdHolding(besideTabId)).toBe("main");
  });
});
