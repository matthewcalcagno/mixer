import type { ApiRequest, Pair } from "../shared/contracts.js";
import { requestParams, splitRequestUrl } from "../shared/query.js";
import { DEFAULT_HEADERS } from "../shared/headers.js";
import { interpolate } from "../shared/request.js";

export function resolveRequest(request: ApiRequest, variables: readonly Pair[]) {
  const resolve = (value: string) => interpolate(value, variables);
  const { base, fragment } = splitRequestUrl(request.url);
  const url = new URL(resolve(`${base}${fragment}`));
  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw new Error("Use an http:// or https:// URL.");
  if (url.username || url.password)
    throw new Error(
      "Use the Authorization tab for credentials instead of including them in the URL.",
    );
  for (const pair of requestParams(request)) {
    if (pair.enabled && pair.key) url.searchParams.append(resolve(pair.key), resolve(pair.value));
  }
  const headers = new Headers();
  const credentialHeaders = ["authorization"];
  for (const pair of request.headers) {
    if (pair.enabled && pair.key) headers.append(resolve(pair.key), resolve(pair.value));
  }
  for (const header of DEFAULT_HEADERS)
    if (!headers.has(header.name)) headers.set(header.name, header.value);
  const auth = request.auth;
  if (auth.type === "bearer") headers.set("Authorization", `Bearer ${resolve(auth.token)}`);
  if (auth.type === "basic")
    headers.set(
      "Authorization",
      `Basic ${Buffer.from(`${resolve(auth.username)}:${resolve(auth.password)}`).toString("base64")}`,
    );
  if (auth.type === "api-key") {
    if (auth.location === "header") {
      const name = resolve(auth.key);
      headers.set(name, resolve(auth.value));
      credentialHeaders.push(name);
    } else url.searchParams.set(resolve(auth.key), resolve(auth.value));
  }
  return { url, headers, resolve, credentialHeaders };
}
