import {
  EditorShortcutInputMessageSchema,
  type EditorShortcutInput,
  type EditorShortcutPolicy,
} from "./editor-layout-shortcuts";

interface EditorFrameSubscription {
  document: Document | null;
  load(): void;
}

/** Only host-authored editor frames participate; file previews retain their isolated keyboard. */
export function observeEditorShortcutDocuments({
  root,
  keyDown,
  bridge,
}: {
  root: Document;
  keyDown(event: KeyboardEvent): void;
  bridge?: { policy: EditorShortcutPolicy; onInput(input: EditorShortcutInput): void };
}): () => void {
  const frames = new Map<HTMLIFrameElement, EditorFrameSubscription>();
  function attach(frame: HTMLIFrameElement) {
    if (frames.has(frame)) return;
    const entry: EditorFrameSubscription = { document: null, load: () => {} };
    entry.load = () => {
      let next: Document | null;
      try {
        next = frame.contentDocument;
      } catch {
        next = null;
      }
      if (next !== entry.document) {
        entry.document?.removeEventListener("keydown", keyDown, true);
        entry.document = next;
        next?.addEventListener("keydown", keyDown, true);
      }
      if (bridge)
        frame.contentWindow?.postMessage(
          { source: "mixer-editor-shortcuts", type: "policy", policy: bridge.policy },
          "*",
        );
    };
    frames.set(frame, entry);
    frame.addEventListener("load", entry.load);
    entry.load();
  }
  function detach(frame: HTMLIFrameElement) {
    const entry = frames.get(frame);
    if (!entry) return;
    entry.document?.removeEventListener("keydown", keyDown, true);
    frame.removeEventListener("load", entry.load);
    frames.delete(frame);
  }
  function sync() {
    for (const frame of frames.keys()) if (!root.contains(frame)) detach(frame);
    for (const frame of root.querySelectorAll<HTMLIFrameElement>("iframe[data-mixer-editor]"))
      attach(frame);
  }
  const observer = new MutationObserver(sync);
  observer.observe(root.documentElement, { childList: true, subtree: true });
  function receive(event: MessageEvent<unknown>) {
    if (!bridge) return;
    const activeFrame = [...frames.keys()].find(
      (frame) => event.source === frame.contentWindow && root.activeElement === frame,
    );
    if (!activeFrame) return;
    const parsed = EditorShortcutInputMessageSchema.safeParse(event.data);
    if (parsed.success) bridge.onInput(parsed.data.input);
  }
  root.defaultView?.addEventListener("message", receive);
  sync();
  return () => {
    observer.disconnect();
    root.defaultView?.removeEventListener("message", receive);
    for (const frame of frames.keys()) detach(frame);
  };
}
