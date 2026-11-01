/** @vitest-environment jsdom */
import { fireEvent, render, screen, waitFor, cleanup } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ContextMenu } from "./context-menu.electron";
import { createElement, useRef } from "react";
import { useNativeTabContextMenu } from "@/screens/workspace/use-native-tab-context-menu.electron";
import type { NativeTabContextMenuInput } from "@/screens/workspace/tab-native-menu-types";

const bridge = vi.hoisted(() => ({ show: vi.fn(), error: vi.fn() }));
vi.mock("@/desktop/host", () => ({
  getDesktopHost: () => ({ menu: { showContextMenu: bridge.show } }),
}));
vi.mock("@/contexts/toast-context", () => ({ useToast: () => ({ error: bridge.error }) }));
vi.mock("@/constants/platform", () => ({ isWeb: true }));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

it("delegates right click to the OS menu without drawing extra UI and preserves the opening action snapshot", async () => {
  const pending = Promise.withResolvers<string | null>();
  bridge.show.mockReturnValueOnce(pending.promise);
  const opened = vi.fn();
  const selected = vi.fn();
  const replacement = vi.fn();
  const actions = [{ id: "stage", label: "Stage 2 Changes" }];
  const view = render(
    <ContextMenu actions={actions} onOpen={opened} onSelect={selected}>
      <button type="button">file.txt</button>
    </ContextMenu>,
  );
  fireEvent.contextMenu(screen.getByRole("button", { name: "file.txt" }));
  expect(opened).toHaveBeenCalledTimes(1);
  expect(bridge.show).toHaveBeenCalledWith({
    kind: "actions",
    items: [{ id: "stage", label: "Stage 2 Changes" }],
  });
  expect(screen.queryByRole("menu")).toBeNull();
  expect(screen.queryByRole("checkbox")).toBeNull();
  view.rerender(
    <ContextMenu
      actions={[{ id: "discard", label: "Discard Changes" }]}
      onOpen={opened}
      onSelect={replacement}
    >
      <button type="button">file.txt</button>
    </ContextMenu>,
  );
  pending.resolve("stage");
  await waitFor(() => expect(selected).toHaveBeenCalledWith("stage"));
  expect(replacement).not.toHaveBeenCalled();
});

it("supports the keyboard context-menu gesture and does nothing when the native menu is canceled", async () => {
  bridge.show.mockResolvedValueOnce(null);
  const selected = vi.fn();
  const opened = vi.fn();
  render(
    <ContextMenu
      actions={[{ id: "stage", label: "Stage Changes" }]}
      onOpen={opened}
      onSelect={selected}
    >
      <button type="button">file.txt</button>
    </ContextMenu>,
  );
  fireEvent.keyDown(screen.getByRole("button"), { key: "F10", shiftKey: true });
  await waitFor(() => expect(bridge.show).toHaveBeenCalledTimes(1));
  expect(selected).not.toHaveBeenCalled();
});

it("does not run disabled actions and reports an old desktop handler instead of drawing a fallback menu", async () => {
  bridge.show.mockResolvedValueOnce("discard").mockResolvedValueOnce(undefined);
  const selected = vi.fn();
  const opened = vi.fn();
  render(
    <ContextMenu
      actions={[{ id: "discard", label: "Discard Changes", disabled: true }]}
      onOpen={opened}
      onSelect={selected}
    >
      <button type="button">file.txt</button>
    </ContextMenu>,
  );
  fireEvent.contextMenu(screen.getByRole("button"));
  await waitFor(() => expect(bridge.show).toHaveBeenCalledTimes(1));
  expect(selected).not.toHaveBeenCalled();
  fireEvent.contextMenu(screen.getByRole("button"));
  await waitFor(() =>
    expect(bridge.error).toHaveBeenCalledWith(
      "Restart the desktop app to enable native context menus.",
    ),
  );
  expect(screen.queryByRole("menu")).toBeNull();
});

function TabFixture({
  entries,
  openWith = null,
  custom,
}: Omit<NativeTabContextMenuInput, "ref"> & { custom(): void }) {
  const ref = useRef<HTMLDivElement>(null);
  useNativeTabContextMenu({ ref, entries, openWith });
  return (
    <div ref={ref}>
      <button type="button" onContextMenu={custom} onKeyDown={custom}>
        file.ts
      </button>
    </div>
  );
}

it("tab right click uses the native action snapshot and prevents the custom menu from opening", async () => {
  const pending = Promise.withResolvers<string | null>();
  bridge.show.mockReturnValueOnce(pending.promise);
  const selected = vi.fn();
  const replacement = vi.fn();
  const custom = vi.fn();
  const view = render(
    <TabFixture
      custom={custom}
      openWith={null}
      entries={[
        { kind: "item", key: "close", label: "Close", testID: "close", onSelect: selected },
      ]}
    />,
  );
  fireEvent.contextMenu(screen.getByRole("button"));
  expect(bridge.show).toHaveBeenCalledWith({
    kind: "actions",
    items: [{ id: "close", label: "Close", disabled: undefined, separatorBefore: false }],
  });
  expect(custom).not.toHaveBeenCalled();
  view.rerender(
    <TabFixture
      custom={custom}
      openWith={null}
      entries={[
        { kind: "item", key: "close", label: "Close", testID: "close", onSelect: replacement },
      ]}
    />,
  );
  pending.resolve("close");
  await waitFor(() => expect(selected).toHaveBeenCalledTimes(1));
  expect(replacement).not.toHaveBeenCalled();
});

it("tab keyboard menus preserve Open with choices and skip canceled or disabled actions", async () => {
  bridge.show
    .mockResolvedValueOnce("open-with:source")
    .mockResolvedValueOnce("close")
    .mockResolvedValueOnce(null);
  const openSource = vi.fn();
  const close = vi.fn();
  const custom = vi.fn();
  const nativeOpenWith = {
    label: "Open with",
    items: [{ id: "open-with:source", label: "Source", checked: true, onSelect: openSource }],
  };
  render(
    createElement(TabFixture, {
      custom,
      entries: [
        { kind: "file-panel-open-with", key: "open-with" },
        { kind: "separator", key: "separator" },
        {
          kind: "item",
          key: "close",
          label: "Close",
          disabled: true,
          testID: "close",
          onSelect: close,
        },
      ],
      openWith: nativeOpenWith,
    }),
  );
  const button = screen.getByRole("button");
  fireEvent.keyDown(button, { key: "F10", shiftKey: true });
  await waitFor(() => expect(openSource).toHaveBeenCalledTimes(1));
  expect(bridge.show).toHaveBeenCalledWith({
    kind: "actions",
    items: [
      {
        id: "open-with",
        label: "Open with",
        separatorBefore: false,
        submenu: [{ id: "open-with:source", label: "Source", checked: true }],
      },
      { id: "close", label: "Close", disabled: true, separatorBefore: true },
    ],
  });
  expect(custom).not.toHaveBeenCalled();
  fireEvent.contextMenu(button);
  await waitFor(() => expect(bridge.show).toHaveBeenCalledTimes(2));
  fireEvent.contextMenu(button);
  await waitFor(() => expect(bridge.show).toHaveBeenCalledTimes(3));
  expect(close).not.toHaveBeenCalled();
  expect(openSource).toHaveBeenCalledTimes(1);
});
