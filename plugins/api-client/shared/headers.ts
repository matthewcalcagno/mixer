import type { ApiRequest } from "./contracts.js";

export const DEFAULT_HEADERS = [
  { name: "Accept", value: "*/*" },
  { name: "Accept-Encoding", value: "gzip, deflate" },
  { name: "User-Agent", value: "Mixer" },
  { name: "Connection", value: "keep-alive" },
] as const;
export function rawContentType(body: ApiRequest["body"]) {
  if (body.type === "json") return "application/json";
  const types = {
    text: "text/plain",
    javascript: "application/javascript",
    html: "text/html",
    xml: "application/xml",
    json: "application/json",
  };
  return types[body.rawFormat ?? "text"];
}
export function authFilled(request: ApiRequest) {
  const auth = request.auth;
  switch (auth.type) {
    case "bearer":
      return Boolean(auth.token.trim());
    case "basic":
      return Boolean(auth.username || auth.password);
    case "api-key":
      return Boolean(auth.value.trim());
    default:
      return false;
  }
}
export function generatedHeaders(request: ApiRequest) {
  const manual = new Set(
    request.headers
      .filter((pair) => pair.enabled && pair.key)
      .map((pair) => pair.key.toLowerCase()),
  );
  const headers: Array<{ name: string; value: string }> = DEFAULT_HEADERS.filter(
    (header) => !manual.has(header.name.toLowerCase()),
  ).map((header) => ({ name: header.name, value: header.value }));
  if (!manual.has("host"))
    headers.push({ name: "Host", value: "Calculated when the request is sent" });
  const body = request.body;
  if (body.type !== "none" && !manual.has("content-type")) {
    let value = rawContentType(body);
    if (body.type === "urlencoded") value = "application/x-www-form-urlencoded";
    if (body.type === "multipart") value = "multipart/form-data; boundary=<calculated when sent>";
    if (body.type === "binary") value = body.file?.mimeType || "application/octet-stream";
    headers.push({ name: "Content-Type", value });
  }
  if (body.type !== "none" && !manual.has("content-length"))
    headers.push({ name: "Content-Length", value: "Calculated when the request is sent" });
  const auth = request.auth;
  if (auth.type === "bearer")
    headers.push({ name: "Authorization", value: `Bearer ${auth.token || "<token>"}` });
  if (auth.type === "basic")
    headers.push({ name: "Authorization", value: "Basic <calculated when sent>" });
  if (auth.type === "api-key" && auth.location === "header" && auth.key)
    headers.push({ name: auth.key, value: auth.value || "<value>" });
  return headers;
}
