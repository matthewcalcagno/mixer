/** @vitest-environment jsdom */
import { afterEach, expect, it, vi } from "vitest";
import { observeEditorShortcutDocuments } from "./editor-shortcuts";
import { installEditorLayoutShortcuts } from "./editor-shortcuts-iframe";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  document.body.replaceChildren();
  vi.restoreAllMocks();
});
function frame(marked: boolean) {
  const node = document.createElement("iframe");
  if (marked) node.setAttribute("data-mixer-editor", "");
  document.body.appendChild(node);
  if (!node.contentDocument) throw new Error("Missing frame document");
  return { node, document: node.contentDocument };
}
function key(target: Document | Window, letter: string, code: string) {
  const event = new KeyboardEvent("keydown", {
    key: letter,
    code,
    metaKey: true,
    bubbles: true,
    cancelable: true,
  });
  target.dispatchEvent(event);
  return event;
}
it("captures shortcuts only in marked editor documents and releases removed frames", async () => {
  const editor = frame(true);
  const preview = frame(false);
  const handle = vi.fn((event: KeyboardEvent) => event.preventDefault());
  cleanups.push(observeEditorShortcutDocuments({ root: document, keyDown: handle }));
  expect(key(editor.document, "b", "KeyB").defaultPrevented).toBe(true);
  expect(key(preview.document, "b", "KeyB").defaultPrevented).toBe(false);
  expect(handle).toHaveBeenCalledTimes(1);
  editor.node.remove();
  await Promise.resolve();
  key(editor.document, "b", "KeyB");
  expect(handle).toHaveBeenCalledTimes(1);
});
it("attaches newly loaded editor documents and removes listeners before an opaque-origin navigation", async () => {
  const handle = vi.fn();
  cleanups.push(observeEditorShortcutDocuments({ root: document, keyDown: handle }));
  const editor = frame(true);
  await Promise.resolve();
  key(editor.document, "d", "KeyD");
  expect(handle).toHaveBeenCalledTimes(1);
  const replacement = document.implementation.createHTMLDocument("New editor");
  Object.defineProperty(editor.node, "contentDocument", {
    configurable: true,
    get: () => replacement,
  });
  editor.node.dispatchEvent(new Event("load"));
  key(editor.document, "d", "KeyD");
  key(replacement, "d", "KeyD");
  expect(handle).toHaveBeenCalledTimes(2);
  Object.defineProperty(editor.node, "contentDocument", {
    configurable: true,
    get: () => {
      throw new DOMException("Opaque frame", "SecurityError");
    },
  });
  expect(() => editor.node.dispatchEvent(new Event("load"))).not.toThrow();
  key(replacement, "d", "KeyD");
  expect(handle).toHaveBeenCalledTimes(2);
});
it("accepts validated sandbox shortcut input only from the active marked frame", () => {
  const editor = frame(true);
  const preview = frame(false);
  const received = vi.fn();
  cleanups.push(
    observeEditorShortcutDocuments({
      root: document,
      keyDown: () => {},
      bridge: { policy: { isMac: true, isDesktop: true, overrides: {} }, onInput: received },
    }),
  );
  const input = {
    key: "d",
    code: "KeyD",
    metaKey: true,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    repeat: false,
  };
  const data = { source: "mixer-editor-shortcuts", type: "input", input };
  preview.node.focus();
  window.dispatchEvent(new MessageEvent("message", { source: preview.node.contentWindow, data }));
  window.dispatchEvent(new MessageEvent("message", { source: editor.node.contentWindow, data }));
  expect(received).not.toHaveBeenCalled();
  editor.node.focus();
  window.dispatchEvent(new MessageEvent("message", { source: editor.node.contentWindow, data }));
  expect(received).toHaveBeenCalledWith(input);
  window.dispatchEvent(
    new MessageEvent("message", {
      source: editor.node.contentWindow,
      data: { ...data, input: { key: "d" } },
    }),
  );
  expect(received).toHaveBeenCalledTimes(1);
});
it("sandbox editors forward layout keys and overrides but leave editing shortcuts local", () => {
  const posted = vi.spyOn(window, "postMessage").mockImplementation(() => {});
  cleanups.push(installEditorLayoutShortcuts());
  function policy(overrides: Record<string, string>) {
    window.dispatchEvent(
      new MessageEvent("message", {
        source: window.parent,
        data: {
          source: "mixer-editor-shortcuts",
          type: "policy",
          policy: { isMac: true, isDesktop: true, overrides },
        },
      }),
    );
  }
  policy({});
  expect(key(window, "d", "KeyD").defaultPrevented).toBe(true);
  expect(posted).toHaveBeenCalledTimes(1);
  expect(key(window, "f", "KeyF").defaultPrevented).toBe(false);
  expect(key(window, "s", "KeyS").defaultPrevented).toBe(false);
  expect(posted).toHaveBeenCalledTimes(1);
  policy({ "workspace-pane-split-right-cmd-backslash": "Cmd+Y" });
  expect(key(window, "d", "KeyD").defaultPrevented).toBe(false);
  expect(key(window, "y", "KeyY").defaultPrevented).toBe(true);
  expect(posted).toHaveBeenCalledTimes(2);
  policy({ "workspace-pane-split-right-cmd-backslash": "Cmd+K Cmd+D" });
  expect(key(window, "k", "KeyK").defaultPrevented).toBe(true);
  expect(key(window, "d", "KeyD").defaultPrevented).toBe(true);
  expect(posted).toHaveBeenCalledTimes(4);
  expect(key(window, "k", "KeyK").defaultPrevented).toBe(true);
  expect(key(window, "x", "KeyX").defaultPrevented).toBe(false);
  expect(posted).toHaveBeenCalledTimes(6);
  expect(key(window, "d", "KeyD").defaultPrevented).toBe(false);
});
