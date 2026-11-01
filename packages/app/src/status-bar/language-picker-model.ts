import { fileAssociationKey, type LanguageMode } from "@/file-panels/source/editor/language-modes";

export type LanguagePickerRow =
  | { kind: "language"; id: string; mode: LanguageMode }
  | { kind: "action"; id: "auto" | "association" | "back" | "clear" };
export type LanguagePickerSelection =
  | { kind: "language"; mode: string | null }
  | { kind: "association"; pattern: string; mode: string | null };

export function openLanguagePicker(filename: string, modes: readonly LanguageMode[]) {
  const listeners = new Set<() => void>();
  let closed = false;
  const pattern = fileAssociationKey(filename);
  const languages: LanguagePickerRow[] = modes.map((mode) => ({
    kind: "language",
    id: `language:${mode.id}`,
    mode,
  }));
  const initial: LanguagePickerRow[] = [
    { kind: "action", id: "auto" },
    { kind: "action", id: "association" },
    ...languages,
  ];
  let state: { phase: "language" | "association"; pattern: string; rows: LanguagePickerRow[] } = {
    phase: "language",
    pattern,
    rows: initial,
  };
  const publish = () => {
    for (const listener of listeners) listener();
  };
  return {
    getSnapshot: () => state,
    isActive: () => !closed,
    close() {
      closed = true;
      listeners.clear();
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    choose(id: string): LanguagePickerSelection | null {
      if (closed) return null;
      if (id === "association") {
        state = {
          phase: "association",
          pattern,
          rows: [{ kind: "action", id: "back" }, { kind: "action", id: "clear" }, ...languages],
        };
        publish();
        return null;
      }
      if (id === "back") {
        state = { phase: "language", pattern, rows: initial };
        publish();
        return null;
      }
      if (id === "auto") return { kind: "language", mode: null };
      if (id === "clear") return { kind: "association", pattern, mode: null };
      const row = languages.find((candidate) => candidate.id === id);
      if (!row || row.kind !== "language") return null;
      return state.phase === "language"
        ? { kind: "language", mode: row.mode.id }
        : { kind: "association", pattern, mode: row.mode.id };
    },
  };
}
