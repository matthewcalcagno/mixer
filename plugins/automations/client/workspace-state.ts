import { useCallback, useSyncExternalStore, type SetStateAction } from "react";
import { z } from "zod";
import { readWorkflowRpc } from "../shared/contracts.js";

const workspaceSchema = z.object({
  agentTabs: z.array(z.object({ agentId: z.string(), workspaceId: z.string() })).default([]),
  page: z
    .union([
      z.literal("Runs"),
      z.literal("Workflows"),
      z.object({ kind: z.literal("agent"), agentId: z.string() }),
    ])
    .default("Runs"),
  selectedRun: z.string().optional(),
  workflowFilter: z.string().default(""),
  aiOpen: z.boolean().default(false),
  assistant: z.object({ agentId: z.string().optional(), draftId: z.string() }),
  documents: z
    .object({
      selected: z.string(),
      paths: z.array(z.string()),
    })
    .default({ selected: "", paths: [] }),
  editorDrafts: z
    .record(z.string(), z.object({ source: readWorkflowRpc.output, content: z.string() }))
    .default({}),
});

type WorkspaceState = z.output<typeof workspaceSchema>;
export type AutomationsPage = WorkspaceState["page"];
type Storage = Pick<globalThis.Storage, "getItem" | "setItem">;

export function createAutomationWorkspaceStore(hostId: string, storage: Storage) {
  const key = `mixer:automations:workspace:v1:${hostId}`;
  let state = workspaceSchema.parse({ assistant: { draftId: globalThis.crypto.randomUUID() } });
  let error: string | null = null;
  try {
    const saved = storage.getItem(key);
    if (saved) state = workspaceSchema.parse(JSON.parse(saved));
  } catch {
    error = "Could not restore the Automations workspace. Saved state is unavailable or invalid.";
  }
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => state,
    getError: () => error,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    set<K extends keyof WorkspaceState>(field: K, update: SetStateAction<WorkspaceState[K]>) {
      const previous = state[field];
      const value = typeof update === "function" ? update(previous) : update;
      if (Object.is(previous, value)) return;
      state = { ...state, [field]: value };
      try {
        storage.setItem(key, JSON.stringify(state));
        error = null;
      } catch {
        error =
          "Could not save the Automations workspace. Keep this window open to preserve your chats and drafts.";
      }
      for (const listener of listeners) listener();
    },
  };
}

const workspaces = new Map<string, ReturnType<typeof createAutomationWorkspaceStore>>();
function workspaceStore(hostId: string) {
  let store = workspaces.get(hostId);
  if (!store) {
    // Access storage inside the boundary so restricted storage still retains this window's state.
    store = createAutomationWorkspaceStore(hostId, {
      getItem: (key) => globalThis.localStorage.getItem(key),
      setItem: (key, value) => globalThis.localStorage.setItem(key, value),
    });
    workspaces.set(hostId, store);
  }
  return store;
}

export function useAutomationWorkspaceField<K extends keyof WorkspaceState>(
  hostId: string,
  field: K,
): [WorkspaceState[K], (update: SetStateAction<WorkspaceState[K]>) => void] {
  const store = workspaceStore(hostId);
  const getSnapshot = useCallback(() => store.getSnapshot()[field], [store, field]);
  const value = useSyncExternalStore(store.subscribe, getSnapshot, getSnapshot);
  const setValue = useCallback(
    (update: SetStateAction<WorkspaceState[K]>) => store.set(field, update),
    [store, field],
  );
  return [value, setValue];
}

export function useAutomationWorkspaceError(hostId: string) {
  const store = workspaceStore(hostId);
  return useSyncExternalStore(store.subscribe, store.getError, store.getError);
}
