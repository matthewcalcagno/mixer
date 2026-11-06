import type { ApiRequest, Pair } from "../shared/contracts.js";
import { interpolate, newPair } from "../shared/request.js";
import { requestCollection, type ClientState } from "./model.js";
export interface VariableStatus {
  name: string;
  resolved: boolean;
  value: string;
  source: string;
  scopeId: string;
  error?: string;
}
export function variableNames(text: string): string[] {
  return [
    ...new Set([...text.matchAll(/\{\{\s*([^{}]+?)\s*\}\}/g)].map((match) => match[1]!.trim())),
  ];
}
export function activeVariablePairs(state: ClientState): Pair[] {
  return [
    ...state.globals,
    ...(requestCollection(state, state.activeId)?.variables ?? []),
    ...(state.environments.find((environment) => environment.id === state.activeEnvironmentId)
      ?.variables ?? []),
  ];
}
export function variableStatus(state: ClientState, name: string): VariableStatus {
  const environment = state.environments.find((item) => item.id === state.activeEnvironmentId);
  const collection = requestCollection(state, state.activeId);
  const inherited = collection?.variables?.findLast((pair) => pair.enabled && pair.key === name);
  const local = environment?.variables.findLast((pair) => pair.enabled && pair.key === name);
  const global = state.globals.findLast((pair) => pair.enabled && pair.key === name);
  const result: VariableStatus = {
    name,
    resolved: false,
    value: "",
    source: "Globals",
    scopeId: "globals",
  };
  if (inherited) {
    result.source = `Collection · ${collection!.name}`;
    result.scopeId = `collection:${collection!.id}`;
  }
  if (local) {
    result.source = environment!.name;
    result.scopeId = environment!.id;
  }
  if (!local && !global && !inherited)
    result.scopeId = environment?.id ?? (collection ? `collection:${collection.id}` : "globals");
  try {
    result.value = interpolate(`{{${name}}}`, activeVariablePairs(state));
    result.resolved = true;
  } catch (error) {
    result.error = error instanceof Error ? error.message : "Unresolved variable";
  }
  return result;
}
export function variableDefinitions(state: ClientState): VariableStatus[] {
  const names = [
    ...new Set(
      activeVariablePairs(state)
        .filter((pair) => pair.enabled && pair.key)
        .map((pair) => pair.key),
    ),
  ];
  return names.map((name) => variableStatus(state, name));
}
export function requestVariableNames(request: ApiRequest): string[] {
  const strings = [request.url];
  for (const pair of [...request.params, ...request.headers])
    if (pair.enabled) strings.push(pair.key, pair.value);
  if (request.auth.type === "bearer") strings.push(request.auth.token);
  if (request.auth.type === "basic") strings.push(request.auth.username, request.auth.password);
  if (request.auth.type === "api-key") strings.push(request.auth.key, request.auth.value);
  if (request.body.type === "json" || request.body.type === "text") strings.push(request.body.text);
  if (request.body.type === "urlencoded" || request.body.type === "multipart")
    for (const pair of request.body.fields) if (pair.enabled) strings.push(pair.key, pair.value);
  return [...new Set(strings.flatMap(variableNames))];
}
export function saveVariable(
  state: ClientState,
  name: string,
  value: string,
  scopeId: string,
): ClientState {
  const replace = (pairs: Pair[]) => {
    const previous = pairs.find((pair) => pair.key === name);
    return [
      ...pairs.filter((pair) => pair.key !== name),
      { ...(previous ?? newPair(name)), value, enabled: true },
    ];
  };
  if (scopeId === "globals") return { ...state, globals: replace(state.globals) };
  if (scopeId.startsWith("collection:"))
    return {
      ...state,
      collections: state.collections.map((collection) =>
        collection.id === scopeId.slice(11)
          ? { ...collection, variables: replace(collection.variables ?? []) }
          : collection,
      ),
    };
  return {
    ...state,
    environments: state.environments.map((environment) =>
      environment.id === scopeId
        ? { ...environment, variables: replace(environment.variables) }
        : environment,
    ),
  };
}

export function scopeVariables(state: ClientState, scopeId: string): Pair[] {
  if (scopeId === "globals") return state.globals;
  if (scopeId.startsWith("collection:"))
    return (
      state.collections.find((collection) => collection.id === scopeId.slice(11))?.variables ?? []
    );
  return state.environments.find((environment) => environment.id === scopeId)?.variables ?? [];
}
