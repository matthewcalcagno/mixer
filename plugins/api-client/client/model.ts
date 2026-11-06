import { z } from "zod";
import {
  MAX_VARIABLES_PER_SCOPE,
  environmentSchema,
  pairSchema,
  requestSchema,
  type ApiRequest,
  type ApiResponse,
} from "../shared/contracts.js";
import { newRequest } from "../shared/request.js";

export const collectionSchema = z.object({
  id: z.string(),
  name: z.string().max(128),
  requests: z.array(requestSchema).max(500),
  variables: z.array(pairSchema).max(MAX_VARIABLES_PER_SCOPE).optional(),
  folders: z
    .array(z.object({ id: z.string(), name: z.string().max(128), parentId: z.string().nullable() }))
    .max(500)
    .optional(),
  locations: z.record(z.string(), z.string()).optional(),
  sort: z.enum(["default", "name"]).optional(),
});
const historySchema = z.object({
  collectionId: z.string().optional(),
  id: z.string(),
  at: z.string(),
  request: requestSchema,
  status: z.number().nullable(),
  durationMs: z.number(),
  error: z.string().nullable(),
});
export const stateSchema = z.object({
  version: z.literal(1),
  tabs: z.array(requestSchema).min(1).max(30),
  activeId: z.string(),
  collapsedResources: z.record(z.string(), z.array(z.string())).optional(),
  collectionContextByRequest: z.record(z.string(), z.string()).optional(),
  collections: z.array(collectionSchema).max(100),
  history: z.array(historySchema).max(100),
  globals: z.array(pairSchema).max(MAX_VARIABLES_PER_SCOPE),
  environments: z.array(environmentSchema).max(50),
  activeEnvironmentId: z.string().nullable(),
  cookieJar: z.string().max(250000),
});
export type ClientState = z.infer<typeof stateSchema>;
export type Collection = z.infer<typeof collectionSchema>;
export type HistoryEntry = z.infer<typeof historySchema>;
export function initialState(): ClientState {
  const request = newRequest();
  return {
    version: 1,
    tabs: [request],
    activeId: request.id,
    collections: [{ id: crypto.randomUUID(), name: "My collection", requests: [] }],
    history: [],
    globals: [],
    environments: [],
    activeEnvironmentId: null,
    cookieJar: "",
  };
}
export function openRequest(state: ClientState, request: ApiRequest): ClientState {
  const existing = state.tabs.find((tab) => tab.id === request.id);
  if (existing) return { ...state, activeId: existing.id };
  if (state.tabs.length >= 30)
    throw new Error("Close a request tab before opening another. Up to 30 tabs can be open.");
  return { ...state, tabs: [...state.tabs, structuredClone(request)], activeId: request.id };
}
export function replaceRequest(state: ClientState, request: ApiRequest): ClientState {
  return { ...state, tabs: state.tabs.map((tab) => (tab.id === request.id ? request : tab)) };
}
export type CloseTabsMode = "current" | "left" | "right" | "others" | "all";
export function tabsToClose(state: ClientState, id: string, mode: CloseTabsMode): ApiRequest[] {
  const index = state.tabs.findIndex((tab) => tab.id === id);
  if (index < 0) return [];
  if (mode === "left") return state.tabs.slice(0, index);
  if (mode === "right") return state.tabs.slice(index + 1);
  if (mode === "all") return state.tabs;
  return state.tabs.filter((tab) => (mode === "others" ? tab.id !== id : tab.id === id));
}
export function closeRequests(state: ClientState, ids: readonly string[]): ClientState {
  const closed = new Set(ids);
  const index = state.tabs.findIndex((tab) => tab.id === state.activeId);
  const tabs = state.tabs.filter((tab) => !closed.has(tab.id));
  if (!tabs.length) tabs.push(newRequest());
  const preceding = state.tabs.slice(0, index).findLast((tab) => !closed.has(tab.id));
  const activeId = closed.has(state.activeId) ? (preceding?.id ?? tabs[0]!.id) : state.activeId;
  const collectionContextByRequest = state.collectionContextByRequest
    ? Object.fromEntries(
        Object.entries(state.collectionContextByRequest).filter(([id]) => !closed.has(id)),
      )
    : undefined;
  return { ...state, tabs, activeId, collectionContextByRequest };
}
export function closeRequest(state: ClientState, id: string): ClientState {
  return closeRequests(state, [id]);
}
export function needsDiscardConfirmation(state: ClientState, request: ApiRequest): boolean {
  if (!isModified(state, request)) return false;
  if (savedRequest(state, request.id)) return true;
  return JSON.stringify({ ...request, id: "" }) !== JSON.stringify({ ...newRequest(), id: "" });
}
export function recordHistory(
  state: ClientState,
  request: ApiRequest,
  result: ApiResponse | null,
  error: string | null,
): ClientState {
  return {
    ...state,
    history: [
      {
        id: crypto.randomUUID(),
        at: new Date().toISOString(),
        request,
        collectionId: requestCollection(state, request.id)?.id,
        status: result?.status ?? null,
        durationMs: result?.durationMs ?? 0,
        error,
      },
      ...state.history,
    ].slice(0, 100),
  };
}
export function savedRequest(state: ClientState, id: string) {
  return state.collections
    .flatMap((collection) => collection.requests)
    .find((request) => request.id === id);
}
export function isModified(state: ClientState, request: ApiRequest) {
  const saved = savedRequest(state, request.id);
  return !saved || JSON.stringify(saved) !== JSON.stringify(request);
}

export function removeSavedRequest(
  state: ClientState,
  collectionId: string,
  requestId: string,
): ClientState {
  return {
    ...state,
    collections: state.collections.map((collection) =>
      collection.id === collectionId
        ? {
            ...collection,
            requests: collection.requests.filter((request) => request.id !== requestId),
          }
        : collection,
    ),
  };
}
export function saveToCollection(
  state: ClientState,
  request: ApiRequest,
  collectionId: string,
  folderId?: string,
): ClientState {
  return {
    ...replaceRequest(state, request),
    collections: state.collections.map((collection) => {
      const requests = collection.requests.filter((saved) => saved.id !== request.id);
      if (collection.id === collectionId) requests.push(request);
      const locations = { ...collection.locations };
      delete locations[request.id];
      if (collection.id === collectionId && folderId) locations[request.id] = folderId;
      return { ...collection, requests, locations };
    }),
  };
}

/** Saved membership wins when a draft is saved or moved to a different collection. */
export function requestCollection(state: ClientState, requestId: string): Collection | undefined {
  const saved = state.collections.find((collection) =>
    collection.requests.some((request) => request.id === requestId),
  );
  if (saved) return saved;
  const collectionId = state.collectionContextByRequest?.[requestId];
  return state.collections.find((collection) => collection.id === collectionId);
}

export function openHistoryRequest(state: ClientState, entry: HistoryEntry): ClientState {
  const request = { ...structuredClone(entry.request), id: crypto.randomUUID() };
  const collectionId = entry.collectionId ?? requestCollection(state, entry.request.id)?.id;
  const opened = openRequest(state, request);
  if (!collectionId || !state.collections.some((collection) => collection.id === collectionId))
    return opened;
  return {
    ...opened,
    collectionContextByRequest: { ...state.collectionContextByRequest, [request.id]: collectionId },
  };
}
