import type { ApiRequest, Pair } from "./contracts.js";

export function newPair(key = "", value = ""): Pair {
  return { id: crypto.randomUUID(), key, value, enabled: true };
}
export function newRequest(): ApiRequest {
  return {
    id: crypto.randomUUID(),
    name: "Untitled request",
    method: "GET",
    url: "",
    params: [],
    headers: [],
    auth: { type: "none" },
    body: { type: "none", text: "", fields: [], file: null },
    timeoutMs: 30000,
    followRedirects: true,
  };
}

export function interpolate(value: string, variables: readonly Pair[]): string {
  const values = new Map(
    variables.filter((pair) => pair.enabled && pair.key).map((pair) => [pair.key, pair.value]),
  );
  const resolve = (text: string, path: string[]): string =>
    text.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (_match, name: string) => {
      const key = name.trim();
      if (path.includes(key)) throw new Error(`Variable "${key}" contains a circular reference.`);
      if (path.length >= 32) throw new Error("Variable references are nested too deeply.");
      const result = values.get(key);
      if (result === undefined)
        throw new Error(
          `Variable "${key}" is not defined in the selected environment, collection, or globals.`,
        );
      return resolve(result, [...path, key]);
    });
  return resolve(value, []);
}
