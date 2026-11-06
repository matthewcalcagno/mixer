import { cookieHeader, mergeCookies } from "../shared/vendor/cookie-jar.gen.js";
import type { ApiRequest, ApiResponse, Pair, RequestFile } from "../shared/contracts.js";
import { resolveRequest } from "./resolve-request.js";

import { rawContentType } from "../shared/headers.js";

const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
function fileBytes(file: RequestFile): Blob {
  const data = Uint8Array.from(Buffer.from(file.base64, "base64"));
  return new Blob([data], { type: file.mimeType || "application/octet-stream" });
}
function multipartBody(
  body: ApiRequest["body"],
  headers: Headers,
  resolve: (value: string) => string,
) {
  const form = new FormData();
  for (const field of body.fields) {
    if (!field.enabled || !field.key) continue;
    if (field.file) form.append(resolve(field.key), fileBytes(field.file), field.file.name);
    else form.append(resolve(field.key), resolve(field.value));
  }
  // Fetch supplies the boundary for this particular FormData body.
  headers.delete("content-type");
  return form;
}
function buildBody(
  request: ApiRequest,
  headers: Headers,
  resolve: (value: string) => string,
): BodyInit | undefined {
  const body = request.body;
  if (body.type === "none") return undefined;
  if (request.method === "GET" || request.method === "HEAD")
    throw new Error(`${request.method} requests cannot have a body.`);
  if (body.type === "binary") {
    if (!body.file) throw new Error("Choose a file for the binary request body.");
    if (!headers.has("content-type"))
      headers.set("content-type", body.file.mimeType || "application/octet-stream");
    return fileBytes(body.file);
  }
  if (body.type === "multipart") {
    return multipartBody(body, headers, resolve);
  }
  if (body.type === "urlencoded") {
    const form = new URLSearchParams();
    for (const field of body.fields) {
      if (field.enabled && field.key) form.append(resolve(field.key), resolve(field.value));
    }
    if (!headers.has("content-type"))
      headers.set("content-type", "application/x-www-form-urlencoded");
    return form;
  }
  const text = resolve(body.text);
  if (body.type === "json") {
    try {
      JSON.parse(text);
    } catch {
      throw new Error("The JSON request body is invalid after resolving variables.");
    }
  }
  if (!headers.has("content-type")) headers.set("content-type", rawContentType(body));
  return text;
}

async function readBody(response: Response) {
  const reader = response.body?.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let truncated = false;
  if (reader) {
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        const remaining = MAX_RESPONSE_BYTES - bytes;
        const chunk = next.value.subarray(0, remaining);
        chunks.push(chunk);
        bytes += chunk.length;
        if (next.value.length > remaining) {
          truncated = true;
          await reader.cancel();
          break;
        }
      }
    } finally {
      reader.releaseLock();
    }
  }
  const buffer = Buffer.concat(chunks);
  const contentType = response.headers.get("content-type") ?? "";
  const isText =
    !contentType ||
    /(?:^text\/|json|xml|javascript|graphql|x-www-form-urlencoded)/i.test(contentType);
  return {
    body: buffer.toString(isText ? "utf8" : "base64"),
    encoding: isText ? ("text" as const) : ("base64" as const),
    contentType,
    bytes,
    truncated,
  };
}

function redirectTarget(
  request: ApiRequest,
  location: string,
  url: URL,
  headers: Headers,
  credentialHeaders: readonly string[],
) {
  const destination = new URL(location, url);
  if (!["http:", "https:"].includes(destination.protocol))
    throw new Error("Redirect target must use HTTP or HTTPS.");
  if (destination.username || destination.password)
    throw new Error("Redirect target contains embedded credentials.");
  if (destination.origin !== url.origin && !request.forwardAuthorization) {
    for (const name of credentialHeaders) headers.delete(name);
  }
  if (request.removeReferer) headers.delete("referer");
  return destination;
}
function switchToGet(request: ApiRequest, status: number, method: string) {
  return (
    !request.followOriginalMethod &&
    ((status === 303 && method !== "HEAD") || ([301, 302].includes(status) && method === "POST"))
  );
}
/** HTTP executes on the selected host, including access to its loopback services. */
export async function sendHttp(input: {
  request: ApiRequest;
  variables: Pair[];
  cookieJar: string;
  signal: AbortSignal;
}): Promise<ApiResponse> {
  const started = performance.now();
  const {
    headers,
    resolve,
    credentialHeaders,
    url: initialUrl,
  } = resolveRequest(input.request, input.variables);
  let url = initialUrl;
  let method: string = input.request.method;
  let body = buildBody(input.request, headers, resolve);
  let cookieJar = input.cookieJar;
  const signal = AbortSignal.any([input.signal, AbortSignal.timeout(input.request.timeoutMs)]);
  const redirects: ApiResponse["redirects"] = [];
  const cookies: string[] = [];
  const cookieUpdates: ApiResponse["cookieUpdates"] = [];
  const explicitCookie = headers.get("cookie");
  const maxRedirects = input.request.maxRedirects ?? 10;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    signal.throwIfAborted();
    headers.delete("cookie");
    const cookie = input.request.disableCookieJar ? "" : cookieHeader(cookieJar, url.href);
    if (cookie) headers.set("cookie", cookie);
    if (explicitCookie && url.origin === initialUrl.origin) headers.set("cookie", explicitCookie);
    const response = await fetch(url, { method, headers, body, redirect: "manual", signal });
    for (const value of response.headers.getSetCookie()) {
      cookies.push(value);
      if (!input.request.disableCookieJar) {
        cookieUpdates.push({ url: url.href, value });
        cookieJar = mergeCookies(cookieJar, [{ url: url.href, value }]);
      }
    }
    const location = response.headers.get("location");
    if (
      input.request.followRedirects &&
      location &&
      [301, 302, 303, 307, 308].includes(response.status)
    ) {
      await response.body?.cancel();
      if (hop === maxRedirects) throw new Error(`Request exceeded ${maxRedirects} redirects.`);
      const destination = redirectTarget(input.request, location, url, headers, credentialHeaders);
      redirects.push({ status: response.status, url: url.href });
      if (switchToGet(input.request, response.status, method)) {
        method = "GET";
        body = undefined;
        headers.delete("content-type");
        headers.delete("content-length");
      }
      url = destination;
      continue;
    }
    const result = await readBody(response);
    return {
      ...result,
      status: response.status,
      statusText: response.statusText,
      url: url.href,
      headers: [...response.headers].map(([name, value]) => ({ name, value })),
      cookies,
      cookieUpdates,
      cookieJar,
      redirects,
      durationMs: Math.round((performance.now() - started) * 10) / 10,
    };
  }
  throw new Error("Unable to complete request.");
}
