// @vitest-environment jsdom
import React, { useCallback, useState } from "react";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ActionContextMenuRequest } from "../../../../desktop/src/features/action-context-menu";
import type { SidebarWorkspaceEntry } from "@/hooks/use-sidebar-workspaces-list";
import { SidebarWorkspaceContextMenu } from "./sidebar-workspace-menu";

const native = vi.hoisted(() => ({
  show: vi.fn<(input: ActionContextMenuRequest) => Promise<string | null>>(),
  assign: vi.fn(),
  openFolder: vi.fn(),
  error: vi.fn(),
  projection: { labels: [{ name: "Urgent", color: "red" }], targetHost: { status: "online" } },
}));
vi.mock("@/constants/platform", () => ({
  getIsElectron: () => true,
  isWeb: true,
  isNative: false,
}));
vi.mock("@/constants/layout", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/constants/layout")>()),
  useIsCompactFormFactor: () => false,
}));
vi.mock("@/desktop/host", () => ({
  getDesktopHost: () => ({ menu: { showContextMenu: native.show } }),
}));
vi.mock("@/contexts/toast-context", () => ({ useToast: () => ({ error: native.error }) }));
vi.mock("@/i18n/i18next", () => ({ i18n: { t: (key: string) => key } }));
vi.mock("@/workspace-labels", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/workspace-labels")>()),
  useWorkspaceLabelProjection: () => native.projection,
  workspaceLabels: { setAssignment: native.assign },
}));
vi.mock("@/workspace/desktop-open-targets", () => ({
  useDesktopOpenTargets: () => ({
    targets: [{ id: "finder", kind: "file-manager" }],
    isLoading: false,
  }),
  openDesktopTarget: native.openFolder,
}));
vi.mock("react-native-unistyles", () => ({
  StyleSheet: { create: () => ({}) },
  withUnistyles: () => () => null,
}));
vi.mock("@/components/ui/loading-spinner", () => ({ LoadingSpinner: () => null }));
vi.mock("@/components/adaptive-modal-sheet", () => ({
  FULL_SHEET_SNAP_POINTS: ["100%"],
  SheetBackground: () => null,
  SheetHandle: () => null,
  AdaptiveModalSheet: ({ children }: { children: React.ReactNode }) => (
    <div role="dialog">{children}</div>
  ),
  AdaptiveTextInput: () => <input type="text" />,
}));
vi.mock("@/components/sidebar/workspace-meta-row", () => ({
  workspaceServiceLabelKey: () => "unused",
}));
vi.mock("@/components/sidebar/sidebar-workspace-title", () => ({
  resolveSidebarWorkspaceAccessibilityLabel: () => "develop",
}));
vi.mock("@/styles/density", () => ({ densityIconProps: () => ({}) }));
vi.mock("@/components/ui/shortcut", () => ({ Shortcut: () => null }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) =>
      new Map(
        Object.entries({
          "sidebar.workspace.actions.copyPath": "Copy path",
          "sidebar.workspace.actions.copyBranchName": "Copy branch name",
          "sidebar.workspace.actions.rename": "Rename workspace",
          "sidebar.workspace.actions.pin": "Pin to top",
          "sidebar.workspace.actions.archive": "Delete",
          "sidebar.project.actions.openFolder": "Open in file manager",
          "workspaceLabels.title": "Labels",
          "workspaceLabels.create": "Create label",
        }),
      ).get(key) ?? key,
  }),
}));

const workspace: SidebarWorkspaceEntry = {
  workspaceKey: "host:workspace",
  serverId: "host",
  workspaceId: "workspace",
  projectViewKey: "project",
  projectName: "Project",
  projectKind: "git",
  workspaceKind: "worktree",
  name: "develop",
  statusBucket: "done",
  statusEnteredAt: null,
  workspaceDirectory: "/project",
  workspaceDirectoryLabel: "project",
  title: null,
  currentBranch: "develop",
  archivingAt: null,
  diffStat: null,
  prHint: null,
  archiveHasUncommittedChanges: false,
  archiveUnpushedCommitCount: 0,
  scripts: [],
  hasRunningScripts: false,
  labels: ["Urgent"],
};
afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  native.show.mockResolvedValue(null);
  native.assign.mockResolvedValue(undefined);
  native.openFolder.mockResolvedValue(undefined);
});

function mount(archiveStatus: "idle" | "pending" = "idle") {
  const copy = vi.fn();
  const remove = vi.fn();
  const openChange = vi.fn();
  function Row() {
    const [open, setOpen] = useState(false);
    const changeOpen = useCallback((next: boolean) => {
      openChange(next);
      setOpen(next);
    }, []);
    return (
      <SidebarWorkspaceContextMenu
        workspace={workspace}
        workspaceKey={workspace.workspaceKey}
        contextMenuOpen={open}
        onContextMenuOpenChange={changeOpen}
        accessibilityRole="button"
        highlightStyle={undefined}
        onCopyPath={copy}
        onCopyBranchName={vi.fn()}
        onRename={vi.fn()}
        onMarkAsUnread={vi.fn()}
        onTogglePin={vi.fn()}
        onArchive={remove}
        archiveStatus={archiveStatus}
        archivePendingLabel="Deleting…"
        openInFileManagerPath="/project"
      >
        develop
      </SidebarWorkspaceContextMenu>
    );
  }
  const result = render(<Row />);
  fireEvent.contextMenu(result.getByRole("button", { name: "develop" }), {
    clientX: 20,
    clientY: 30,
  });
  return { ...result, copy, remove, openChange };
}

it("uses the shared OS menu on right-click and dispatches the selected workspace action", async () => {
  native.show.mockImplementation(
    async (input) => input.items.find((item) => item.label === "Copy path")?.id ?? null,
  );
  const view = mount();
  await waitFor(() => expect(view.copy).toHaveBeenCalledTimes(1));
  expect(view.queryByRole("menu")).toBeNull();
  const request = native.show.mock.calls[0][0];
  expect(request.kind).toBe("actions");
  expect(request.items.map((item) => item.label)).toEqual([
    "Copy path",
    "Copy branch name",
    "Rename workspace",
    "Mark as unread",
    "Pin to top",
    "Labels",
    "Open in file manager",
    "Delete",
  ]);
  const labels = request.items.find((item) => item.label === "Labels")?.submenu;
  expect(
    labels?.map((item) => ({ label: item.label, checked: item.checked, disabled: item.disabled })),
  ).toEqual([
    { label: "Urgent", checked: true, disabled: false },
    { label: "Create label", checked: undefined, disabled: false },
  ]);
  expect(view.openChange).toHaveBeenLastCalledWith(false);
});

it("toggles a native label checkbox on the correct workspace", async () => {
  native.show.mockImplementation(
    async (input) =>
      input.items
        .find((item) => item.label === "Labels")
        ?.submenu?.find((item) => item.label === "Urgent")?.id ?? null,
  );
  mount();
  await waitFor(() =>
    expect(native.assign).toHaveBeenCalledWith({
      serverId: "host",
      workspaceId: "workspace",
      label: { name: "Urgent", color: "red" },
      assigned: false,
    }),
  );
});

it("does not repeat a pending deletion even if the bridge returns that action", async () => {
  native.show.mockImplementation(
    async (input) => input.items.find((item) => item.label === "Deleting…")?.id ?? null,
  );
  const view = mount("pending");
  await waitFor(() => expect(native.show).toHaveBeenCalled());
  await waitFor(() => expect(view.openChange).toHaveBeenLastCalledWith(false));
  expect(view.remove).not.toHaveBeenCalled();
  expect(native.show.mock.calls[0][0].items.at(-1)).toMatchObject({
    label: "Deleting…",
    disabled: true,
  });
});

it("closes the menu and reports native bridge failures", async () => {
  native.show.mockRejectedValue(new Error("Native menu unavailable"));
  const view = mount();
  await waitFor(() => expect(native.error).toHaveBeenCalledWith("Native menu unavailable"));
  expect(view.openChange).toHaveBeenLastCalledWith(false);
  expect(view.queryByRole("menu")).toBeNull();
});
