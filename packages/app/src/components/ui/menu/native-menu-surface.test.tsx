// @vitest-environment jsdom
import React, { useCallback, useState } from "react";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "../dropdown-menu";
import { MenuTextField } from "./menu-item";
import { useNativeMenuResource } from "./native-menu";
import type { ActionContextMenuRequest } from "../../../../../desktop/src/features/action-context-menu";
import type { SheetHeader } from "@/components/adaptive-modal-sheet";

const bridge = vi.hoisted(() => ({
  popup: vi.fn<(input: ActionContextMenuRequest) => Promise<string | null>>(),
  error: vi.fn(),
}));
const NATIVE_DELETE_SHORTCUT = <span data-electron-accelerator="Command+Shift+Backspace">⇧⌘⌫</span>;
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
  getDesktopHost: () => ({ menu: { showContextMenu: bridge.popup } }),
}));
vi.mock("@/contexts/toast-context", () => ({ useToast: () => ({ error: bridge.error }) }));
vi.mock("@/i18n/i18next", () => ({ i18n: { t: (key: string) => key } }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("react-native-unistyles", () => ({
  StyleSheet: { create: () => ({}) },
  withUnistyles: () => () => null,
}));
vi.mock("@/components/ui/loading-spinner", () => ({ LoadingSpinner: () => null }));
vi.mock("@/components/adaptive-modal-sheet", () => ({
  FULL_SHEET_SNAP_POINTS: ["100%"],
  SheetBackground: () => null,
  SheetHandle: () => null,
  AdaptiveModalSheet: ({
    children,
    header,
    onClose,
  }: {
    children: React.ReactNode;
    header: SheetHeader;
    onClose: () => void;
  }) => (
    <div role="dialog" aria-label={header.title}>
      <button type="button" onClick={onClose}>
        Close
      </button>
      {children}
    </div>
  ),
  AdaptiveTextInput: ({
    initialValue,
    onChangeText,
    placeholder,
    autoFocus,
  }: {
    initialValue?: string;
    onChangeText: (value: string) => void;
    placeholder: string;
    autoFocus?: boolean;
  }) => {
    const change = useCallback(
      (event: React.ChangeEvent<HTMLInputElement>) => onChangeText(event.currentTarget.value),
      [onChangeText],
    );
    return (
      <input
        type="text"
        defaultValue={initialValue}
        placeholder={placeholder}
        autoFocus={autoFocus}
        onChange={change}
      />
    );
  },
}));
afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  bridge.popup.mockResolvedValue(null);
});

function SimpleMenu({ onSelect }: { onSelect: () => unknown }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger accessibilityRole="button">Menu</DropdownMenuTrigger>
      <DropdownMenuContent>
        <span>Changes affect this project</span>
        <DropdownMenuItem onSelect={onSelect}>Open project settings</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

it("uses the OS presentation for ordinary click-open menus and retains warnings", async () => {
  const select = vi.fn();
  bridge.popup.mockImplementation(
    async (input) => input.items.find((item) => item.label === "Open project settings")?.id ?? null,
  );
  const view = render(<SimpleMenu onSelect={select} />);
  fireEvent.click(view.getByRole("button", { name: "Menu" }));
  await waitFor(() => expect(select).toHaveBeenCalledTimes(1));
  expect(
    bridge.popup.mock.calls[0][0].items.map((item) => ({
      label: item.label,
      disabled: item.disabled,
    })),
  ).toEqual([
    { label: "Changes affect this project", disabled: true },
    { label: "Open project settings", disabled: false },
  ]);
  expect(view.queryByRole("menu")).toBeNull();
});

it("preserves nested native submenu choices and check marks", async () => {
  const select = vi.fn();
  const pages = [
    {
      id: "more",
      title: "More",
      content: <DropdownMenuSubTrigger id="advanced">Advanced</DropdownMenuSubTrigger>,
    },
    {
      id: "advanced",
      title: "Advanced",
      content: (
        <DropdownMenuItem selected onSelect={select}>
          Chosen action
        </DropdownMenuItem>
      ),
    },
  ];
  bridge.popup.mockImplementation(
    async (input) => input.items[0].submenu?.[0].submenu?.[0].id ?? null,
  );
  const view = render(
    <DropdownMenu>
      <DropdownMenuTrigger accessibilityRole="button">Menu</DropdownMenuTrigger>
      <DropdownMenuContent pages={pages}>
        <DropdownMenuSubTrigger id="more">More</DropdownMenuSubTrigger>
      </DropdownMenuContent>
    </DropdownMenu>,
  );
  fireEvent.click(view.getByRole("button", { name: "Menu" }));
  await waitFor(() => expect(select).toHaveBeenCalledTimes(1));
  expect(bridge.popup.mock.calls[0][0].items[0].submenu?.[0].submenu?.[0]).toMatchObject({
    label: "Chosen action",
    checked: true,
    disabled: false,
  });
});

it("preserves shortcut hints without putting them into the action label", async () => {
  const view = render(
    <DropdownMenu>
      <DropdownMenuTrigger accessibilityRole="button">Menu</DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuItem trailing={NATIVE_DELETE_SHORTCUT}>Delete</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>,
  );
  fireEvent.click(view.getByRole("button", { name: "Menu" }));
  await waitFor(() => expect(bridge.popup).toHaveBeenCalled());
  expect(bridge.popup.mock.calls[0][0].items[0]).toMatchObject({
    label: "Delete",
    accelerator: "Command+Shift+Backspace",
  });
});

it("does not dispatch a choice under a disabled native submenu", async () => {
  const select = vi.fn();
  const pages = [
    {
      id: "more",
      title: "More",
      content: <DropdownMenuItem onSelect={select}>Hidden action</DropdownMenuItem>,
    },
  ];
  bridge.popup.mockImplementation(async (input) => input.items[0].submenu?.[0].id ?? null);
  const view = render(
    <DropdownMenu>
      <DropdownMenuTrigger accessibilityRole="button">Menu</DropdownMenuTrigger>
      <DropdownMenuContent pages={pages}>
        <DropdownMenuSubTrigger id="more" disabled>
          More
        </DropdownMenuSubTrigger>
      </DropdownMenuContent>
    </DropdownMenu>,
  );
  fireEvent.click(view.getByRole("button", { name: "Menu" }));
  await waitFor(() => expect(bridge.popup).toHaveBeenCalled());
  await waitFor(() =>
    expect(view.getByRole("button", { name: "Menu" }).getAttribute("aria-expanded")).toBe("false"),
  );
  expect(select).not.toHaveBeenCalled();
});

it("waits for menu resources before freezing the enabled choices", async () => {
  function Content({ ready }: { ready: boolean }) {
    useNativeMenuResource(!ready);
    return <DropdownMenuItem disabled={!ready}>Open in file manager</DropdownMenuItem>;
  }
  function Owner({ ready }: { ready: boolean }) {
    return (
      <DropdownMenu>
        <DropdownMenuTrigger accessibilityRole="button">Menu</DropdownMenuTrigger>
        <DropdownMenuContent>
          <Content ready={ready} />
        </DropdownMenuContent>
      </DropdownMenu>
    );
  }
  const view = render(<Owner ready={false} />);
  fireEvent.click(view.getByRole("button", { name: "Menu" }));
  await new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  );
  expect(bridge.popup).not.toHaveBeenCalled();
  view.rerender(<Owner ready />);
  await waitFor(() => expect(bridge.popup).toHaveBeenCalled());
  expect(bridge.popup.mock.calls[0][0].items[0]).toMatchObject({
    label: "Open in file manager",
    disabled: false,
  });
});

it("opens input pages as forms and keeps their original target while the OS menu is visible", async () => {
  const create = vi.fn();
  let resolvePopup: (id: string | null) => void = () => {
    throw new Error("Popup has not opened");
  };
  bridge.popup.mockImplementation(
    () =>
      new Promise((resolve) => {
        resolvePopup = resolve;
      }),
  );
  function Form({ project }: { project: string }) {
    const [name, setName] = useState("");
    const submit = useCallback(() => create({ project, name }), [project, name]);
    return (
      <>
        <MenuTextField placeholder="Label name" onChangeText={setName} />
        <DropdownMenuItem onSelect={submit}>Create label</DropdownMenuItem>
      </>
    );
  }
  function Owner({ project }: { project: string }) {
    const pages = [
      {
        id: "create",
        title: `Create for ${project}`,
        hoverIntent: false,
        content: <Form project={project} />,
      },
    ];
    return (
      <DropdownMenu>
        <DropdownMenuTrigger accessibilityRole="button">Menu</DropdownMenuTrigger>
        <DropdownMenuContent pages={pages}>
          <DropdownMenuSubTrigger id="create">Create label</DropdownMenuSubTrigger>
        </DropdownMenuContent>
      </DropdownMenu>
    );
  }
  const view = render(<Owner project="project-A" />);
  fireEvent.click(view.getByRole("button", { name: "Menu" }));
  await waitFor(() => expect(bridge.popup).toHaveBeenCalled());
  const id = bridge.popup.mock.calls[0][0].items[0].id;
  view.rerender(<Owner project="project-B" />);
  await act(async () => resolvePopup(id));
  await waitFor(() =>
    expect(view.getByRole("dialog", { name: "Create for project-A" })).toBeDefined(),
  );
  fireEvent.change(view.getByPlaceholderText("Label name"), { target: { value: "New tag" } });
  fireEvent.click(view.getByRole("menuitem", { name: "Create label" }));
  expect(create).toHaveBeenCalledWith({ project: "project-A", name: "New tag" });
  await waitFor(() => expect(view.queryByRole("dialog")).toBeNull());
});

it("reports rejected actions even after the native menu has closed", async () => {
  bridge.popup.mockImplementation(async (input) => input.items[1].id);
  const fail = vi.fn().mockRejectedValue(new Error("Action failed"));
  const view = render(<SimpleMenu onSelect={fail} />);
  fireEvent.click(view.getByRole("button", { name: "Menu" }));
  await waitFor(() => expect(bridge.error).toHaveBeenCalledWith("Action failed"));
  expect(view.getByRole("button", { name: "Menu" }).getAttribute("aria-expanded")).toBe("false");
});

it("does not retarget an action when the renderer refreshes while the OS menu is visible", async () => {
  const original = vi.fn();
  const refreshed = vi.fn();
  let resolvePopup: (id: string | null) => void = () => {
    throw new Error("Popup has not opened");
  };
  bridge.popup.mockImplementation(
    () =>
      new Promise((resolve) => {
        resolvePopup = resolve;
      }),
  );
  const view = render(<SimpleMenu onSelect={original} />);
  fireEvent.click(view.getByRole("button", { name: "Menu" }));
  await waitFor(() => expect(bridge.popup).toHaveBeenCalled());
  const id = bridge.popup.mock.calls[0][0].items.find(
    (item) => item.label === "Open project settings",
  )?.id;
  if (!id) throw new Error("Missing project action");
  view.rerender(<SimpleMenu onSelect={refreshed} />);
  await act(async () => resolvePopup(id));
  expect(original).toHaveBeenCalledTimes(1);
  expect(refreshed).not.toHaveBeenCalled();
});
