import { useSyncExternalStore } from "react";
import { z } from "zod";
import { diffTargetSchema } from "../shared/diff-tabs.js";

export const diffSelection = diffTargetSchema;
export type DiffSelection = z.infer<typeof diffSelection>;
const selections = new Map<string, DiffSelection>();
const listeners = new Set<() => void>();

export function selectDiff(workspaceId: string, selection: DiffSelection) {
  selections.set(workspaceId, selection);
  for (const listener of listeners) listener();
}

export function useDiffSelection(workspaceId: string) {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    () => selections.get(workspaceId) ?? null,
  );
}
