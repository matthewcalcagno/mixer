import type { LanguageMode } from "./language-modes";
import type { LayoutRectangle } from "react-native";

export interface EditorLanguageState {
  id: string;
  modes: LanguageMode[];
}
export interface EditorStatusEntry extends EditorLanguageState {
  key: string;
  filename: string;
  selectLanguage(mode: string | null): void;
  focus(): void;
  quickPickBounds?(): LayoutRectangle | null;
}
const listeners = new Set<() => void>();
let snapshot: ReadonlyMap<string, EditorStatusEntry> = new Map();
const owners = new Map<string, object>();
export const editorStatus = {
  key: (serverId: string, workspaceId: string, tabId: string) =>
    JSON.stringify([serverId, workspaceId, tabId]),
  getSnapshot: () => snapshot,
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  register(
    key: string,
    controls: Pick<EditorStatusEntry, "filename" | "selectLanguage" | "focus" | "quickPickBounds">,
  ) {
    const owner = {};
    owners.set(key, owner);
    if (snapshot.has(key)) {
      const next = new Map(snapshot);
      next.delete(key);
      snapshot = next;
      for (const listener of listeners) listener();
    }
    return {
      publish(state: EditorLanguageState) {
        if (owners.get(key) !== owner) return;
        snapshot = new Map(snapshot).set(key, { ...controls, ...state, key });
        for (const listener of listeners) listener();
      },
      dispose() {
        if (owners.get(key) !== owner) return;
        owners.delete(key);
        const next = new Map(snapshot);
        next.delete(key);
        snapshot = next;
        for (const listener of listeners) listener();
      },
    };
  },
};
