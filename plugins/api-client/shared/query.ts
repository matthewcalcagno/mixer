import type { ApiRequest, Pair } from "./contracts.js";
import { newPair } from "./request.js";

export function splitRequestUrl(url: string) {
  const hashAt = url.indexOf("#");
  const fragment = hashAt < 0 ? "" : url.slice(hashAt);
  const address = hashAt < 0 ? url : url.slice(0, hashAt);
  const queryAt = address.indexOf("?");
  return {
    base: queryAt < 0 ? address : address.slice(0, queryAt),
    query: queryAt < 0 ? "" : address.slice(queryAt + 1),
    fragment,
  };
}
function decode(value: string) {
  try {
    return decodeURIComponent(value.replaceAll("+", " "));
  } catch {
    return value;
  }
}
function parseQuery(url: string): { key: string; value: string }[] {
  const query = splitRequestUrl(url).query;
  return query
    ? query
        .split("&")
        .filter(Boolean)
        .map((part) => {
          const at = part.indexOf("=");
          return {
            key: decode(at < 0 ? part : part.slice(0, at)),
            value: decode(at < 0 ? "" : part.slice(at + 1)),
          };
        })
    : [];
}
/** URL query and persisted table rows can overlap in older saved requests. Match occurrences, not keys. */
export function requestParams(request: ApiRequest): Pair[] {
  const remaining = [...request.params];
  const pairs = parseQuery(request.url).map((pair) => {
    const at = remaining.findIndex((item) => item.key === pair.key && item.value === pair.value);
    return at < 0 ? newPair(pair.key, pair.value) : remaining.splice(at, 1)[0]!;
  });
  return [...pairs, ...remaining];
}
function encode(value: string) {
  // Variables stay readable and are resolved by the daemon before URL encoding.
  return value
    .split(/(\{\{[^{}]+\}\})/g)
    .map((part) => (part.startsWith("{{") ? part : encodeURIComponent(part)))
    .join("");
}
export function withRequestParams(request: ApiRequest, params: Pair[]): ApiRequest {
  const { base, fragment } = splitRequestUrl(request.url);
  const query = params
    .filter((pair) => pair.enabled && pair.key)
    .map((pair) => `${encode(pair.key)}=${encode(pair.value)}`)
    .join("&");
  return { ...request, params, url: `${base}${query ? `?${query}` : ""}${fragment}` };
}
export function withRequestUrl(request: ApiRequest, url: string): ApiRequest {
  const remaining = [...requestParams(request)];
  const params = parseQuery(url).map((pair) => {
    let at = remaining.findIndex((item) => item.key === pair.key && item.value === pair.value);
    if (at < 0) at = remaining.findIndex((item) => item.enabled && item.key === pair.key);
    const previous = at < 0 ? undefined : remaining.splice(at, 1)[0];
    return {
      id: previous?.id ?? crypto.randomUUID(),
      key: pair.key,
      value: pair.value,
      enabled: true,
    };
  });
  return { ...request, url, params: [...params, ...remaining.filter((pair) => !pair.enabled)] };
}
