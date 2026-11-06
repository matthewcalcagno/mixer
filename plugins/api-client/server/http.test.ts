import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { sendHttp } from "./http.js";
import { newPair, newRequest } from "../shared/request.js";
import type { ApiRequest } from "../shared/contracts.js";

let server: Server;
let origin = "";
beforeAll(async () => {
  server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (url.pathname === "/wait") return;
    if (url.pathname === "/loop") {
      response.writeHead(302, { location: "/loop" });
      response.end();
      return;
    }
    if (url.pathname === "/redirect-to") {
      response.writeHead(302, { location: url.searchParams.get("target") ?? "/echo" });
      response.end();
      return;
    }
    if (url.pathname === "/redirect") {
      response.writeHead(302, { location: "/echo", "set-cookie": "session=abc; Path=/; HttpOnly" });
      response.end();
      return;
    }
    if (url.pathname === "/large") {
      response.end(Buffer.alloc(6 * 1024 * 1024, 65));
      return;
    }
    if (url.pathname === "/binary") {
      response.setHeader("content-type", "application/octet-stream");
      response.end(Buffer.from([0, 255, 32]));
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify({
        method: request.method,
        query: [...url.searchParams],
        headers: request.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      }),
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing HTTP listener");
  origin = `http://127.0.0.1:${address.port}`;
});
afterAll(async () => {
  server.closeAllConnections();
  server.close();
  await once(server, "close");
});
function send(request: ApiRequest, options: { cookieJar?: string; signal?: AbortSignal } = {}) {
  return sendHttp({
    request,
    variables: [newPair("baseUrl", origin), newPair("token", "abc")],
    cookieJar: options.cookieJar ?? "",
    signal: options.signal ?? new AbortController().signal,
  });
}
describe("HTTP client on the workspace host", () => {
  it("resolves variables, duplicate query keys, auth and a JSON body", async () => {
    const request = newRequest();
    request.url = "{{baseUrl}}/echo?first=1";
    request.method = "POST";
    request.params = [newPair("tag", "a b"), newPair("tag", "two")];
    request.auth = { type: "bearer", token: "{{token}}" };
    request.body.type = "json";
    request.body.text = '{"token":"{{token}}"}';
    const result = await send(request);
    expect(result.status).toBe(200);
    const payload = JSON.parse(result.body);
    expect(payload.query).toEqual([
      ["first", "1"],
      ["tag", "a b"],
      ["tag", "two"],
    ]);
    expect(payload.headers.authorization).toBe("Bearer abc");
    expect(payload.headers["content-type"]).toBe("application/json");
    expect(payload.body).toBe('{"token":"abc"}');
  });
  it("captures redirect cookies and sends the cookie on the next hop and request", async () => {
    const request = newRequest();
    request.url = `${origin}/redirect`;
    const result = await send(request);
    expect(result.redirects).toEqual([{ status: 302, url: request.url }]);
    expect(JSON.parse(result.body).headers.cookie).toBe("session=abc");
    request.url = `${origin}/echo`;
    expect(
      JSON.parse((await send(request, { cookieJar: result.cookieJar })).body).headers.cookie,
    ).toBe("session=abc");
  });
  it("honors disabled redirects", async () => {
    const request = newRequest();
    request.url = `${origin}/redirect`;
    request.followRedirects = false;
    const result = await send(request);
    expect(result.status).toBe(302);
    expect(result.redirects).toEqual([]);
  });
  it("sends multipart fields and a file with a generated boundary", async () => {
    const request = newRequest();
    request.url = `${origin}/echo`;
    request.method = "POST";
    request.body.type = "multipart";
    request.body.fields = [
      {
        ...newPair("upload"),
        file: {
          name: "note.txt",
          mimeType: "text/plain",
          base64: Buffer.from("file content").toString("base64"),
        },
      },
      newPair("name", "hello"),
    ];
    const payload = JSON.parse((await send(request)).body);
    expect(payload.headers["content-type"]).toContain("multipart/form-data; boundary=");
    expect(payload.body).toContain('filename="note.txt"');
    expect(payload.body).toContain("file content");
    expect(payload.body).toContain("hello");
  });
  it("bounds response bytes and preserves binary content", async () => {
    const request = newRequest();
    request.url = `${origin}/large`;
    const result = await send(request);
    expect(result.truncated).toBe(true);
    expect(result.bytes).toBe(5 * 1024 * 1024);
    request.url = `${origin}/binary`;
    const binary = await send(request);
    expect(binary.encoding).toBe("base64");
    expect(Buffer.from(binary.body, "base64")).toEqual(Buffer.from([0, 255, 32]));
  });
  it("fails before sending an unresolved variable or unsupported protocol", async () => {
    const request = newRequest();
    request.url = "{{missing}}/echo";
    await expect(send(request)).rejects.toThrow('Variable "missing"');
    request.url = "file:///etc/passwd";
    await expect(send(request)).rejects.toThrow("http:// or https://");
  });
  it("honors cancellation and timeout", async () => {
    const request = newRequest();
    request.url = `${origin}/wait`;
    request.timeoutMs = 100;
    await expect(send(request)).rejects.toHaveProperty("name", "TimeoutError");
    const controller = new AbortController();
    controller.abort();
    await expect(send(request, { signal: controller.signal })).rejects.toHaveProperty(
      "name",
      "AbortError",
    );
  });
  it("sends generated defaults and honors a manual override", async () => {
    const request = newRequest();
    request.url = `${origin}/echo`;
    request.headers = [newPair("User-Agent", "custom-client")];
    const result = JSON.parse((await send(request)).body);
    expect(result.headers).toMatchObject({
      accept: "*/*",
      "accept-encoding": "gzip, deflate",
      "user-agent": "custom-client",
      connection: "keep-alive",
    });
  });
  it("sends the selected raw format and preserves POST on redirect when requested", async () => {
    const request = newRequest();
    request.url = `${origin}/redirect`;
    request.method = "POST";
    request.body.type = "text";
    request.body.rawFormat = "javascript";
    request.body.text = "hello();";
    request.followOriginalMethod = true;
    request.removeReferer = true;
    request.headers = [newPair("Referer", origin)];
    const result = JSON.parse((await send(request)).body);
    expect(result.method).toBe("POST");
    expect(result.body).toBe("hello();");
    expect(result.headers["content-type"]).toBe("application/javascript");
    expect(result.headers.referer).toBeUndefined();
  });
  it("applies redirect limits and can disable sending and storing jar cookies", async () => {
    const request = newRequest();
    request.url = `${origin}/loop`;
    request.maxRedirects = 2;
    await expect(send(request)).rejects.toThrow("exceeded 2 redirects");
    request.url = `${origin}/redirect`;
    request.maxRedirects = 10;
    const first = await send(request);
    request.disableCookieJar = true;
    const second = await send(request, { cookieJar: first.cookieJar });
    expect(JSON.parse(second.body).headers.cookie).toBeUndefined();
    expect(second.cookieUpdates).toEqual([]);
    expect(second.cookieJar).toBe(first.cookieJar);
  });
  it("forwards authorization across origins only when enabled", async () => {
    const target = createServer((request, response) =>
      response.end(request.headers.authorization ?? "none"),
    );
    target.listen(0, "127.0.0.1");
    await once(target, "listening");
    const address = target.address();
    if (!address || typeof address === "string") throw new Error("No redirect target");
    try {
      const request = newRequest();
      request.url = `${origin}/redirect-to?target=${encodeURIComponent(`http://127.0.0.1:${address.port}/`)}`;
      request.auth = { type: "bearer", token: "secret" };
      expect((await send(request)).body).toBe("none");
      request.forwardAuthorization = true;
      expect((await send(request)).body).toBe("Bearer secret");
    } finally {
      target.closeAllConnections();
      await new Promise<void>((resolve) => target.close(() => resolve()));
    }
  });
});

it("sends URL-synchronized query parameters once and encodes resolved variable values", async () => {
  const { withRequestUrl, withRequestParams } = await import("../shared/query.js");
  let request = withRequestUrl(newRequest(), "{{baseUrl}}/echo?tag=one&tag=two#ignored");
  request = withRequestParams(request, [
    ...request.params,
    newPair("token", "{{token}}"),
    newPair("q", "a & b"),
  ]);
  const response = await send(request);
  expect(JSON.parse(response.body).query).toEqual([
    ["tag", "one"],
    ["tag", "two"],
    ["token", "abc"],
    ["q", "a & b"],
  ]);
});

it("keeps API-key auth on same-origin redirects and requires opt-in across origins", async () => {
  const target = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ headers: request.headers }));
  });
  target.listen(0, "127.0.0.1");
  await once(target, "listening");
  const address = target.address();
  if (!address || typeof address === "string") throw new Error("No API-key redirect target");
  try {
    const request = newRequest();
    request.url = `${origin}/redirect`;
    request.auth = {
      type: "api-key",
      key: "X-{{token}}-Key",
      value: "review-marker",
      location: "header",
    };
    expect(JSON.parse((await send(request)).body).headers["x-abc-key"]).toBe("review-marker");
    request.url = `${origin}/redirect-to?target=${encodeURIComponent(`http://127.0.0.1:${address.port}/`)}`;
    expect(JSON.parse((await send(request)).body).headers["x-abc-key"]).toBeUndefined();
    request.forwardAuthorization = true;
    expect(JSON.parse((await send(request)).body).headers["x-abc-key"]).toBe("review-marker");
  } finally {
    target.closeAllConnections();
    await new Promise<void>((resolve) => target.close(() => resolve()));
  }
});
