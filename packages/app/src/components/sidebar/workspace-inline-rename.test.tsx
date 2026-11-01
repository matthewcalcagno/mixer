// @vitest-environment jsdom
import React, { useCallback, useMemo, useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { WorkspaceInlineName, WorkspaceInlineRenameProvider } from "./workspace-inline-rename";

const host = vi.hoisted(() => ({ save: vi.fn() }));
const workspace = {
  serverId: "host",
  workspaceId: "workspace",
  name: "develop",
  title: "Original title",
};
vi.mock("@/runtime/host-runtime", () => ({
  getHostRuntimeStore: () => ({ getClient: () => ({ setWorkspaceTitle: host.save }) }),
}));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: () => "Rename workspace" }) }));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
function Row() {
  const [open, setOpen] = useState(false);
  const begin = useCallback(() => setOpen(true), []);
  const close = useCallback(() => setOpen(false), []);
  const context = useMemo(() => ({ open, begin, close }), [open, begin, close]);
  return (
    <WorkspaceInlineRenameProvider value={context}>
      <button type="button" onClick={begin}>
        Rename action
      </button>
      <WorkspaceInlineName workspace={workspace}>Original title</WorkspaceInlineName>
    </WorkspaceInlineRenameProvider>
  );
}
function mount() {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <Row />
    </QueryClientProvider>,
  );
}

it.each(["double-click", "menu"])(
  "selects the entire name on %s and saves a replacement",
  async (entry) => {
    host.save.mockResolvedValue(undefined);
    const view = mount();
    if (entry === "menu") fireEvent.click(view.getByText("Rename action"));
    else fireEvent.doubleClick(view.getByText("Original title"));
    const input = view.getByRole("textbox");
    if (!(input instanceof HTMLInputElement)) throw new Error("Missing input");
    expect(document.activeElement).toBe(input);
    expect([input.selectionStart, input.selectionEnd]).toEqual([0, 14]);
    fireEvent.change(input, { target: { value: " New title " } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(view.queryByRole("textbox")).toBeNull());
    expect(host.save).toHaveBeenCalledExactlyOnceWith("workspace", "New title");
  },
);

it("cancels without saving on Escape", () => {
  const view = mount();
  fireEvent.doubleClick(view.getByText("Original title"));
  fireEvent.change(view.getByRole("textbox"), { target: { value: "Discard" } });
  fireEvent.keyDown(view.getByRole("textbox"), { key: "Escape" });
  expect(view.queryByRole("textbox")).toBeNull();
  expect(host.save).not.toHaveBeenCalled();
});

it("saves an empty title as null on blur", async () => {
  host.save.mockResolvedValue(undefined);
  const view = mount();
  fireEvent.doubleClick(view.getByText("Original title"));
  fireEvent.change(view.getByRole("textbox"), { target: { value: "  " } });
  await new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  );
  fireEvent.blur(view.getByRole("textbox"));
  await waitFor(() => expect(view.queryByRole("textbox")).toBeNull());
  expect(host.save).toHaveBeenCalledExactlyOnceWith("workspace", null);
});

it("retains the draft and exposes a failed save", async () => {
  host.save.mockRejectedValue(new Error("Disconnected"));
  const view = mount();
  fireEvent.doubleClick(view.getByText("Original title"));
  fireEvent.change(view.getByRole("textbox"), { target: { value: "Keep draft" } });
  fireEvent.keyDown(view.getByRole("textbox"), { key: "Enter" });
  await waitFor(() => expect(view.getByRole("alert").textContent).toBe("Disconnected"));
  expect(view.getByRole("textbox").getAttribute("value")).toBe("Keep draft");
});
