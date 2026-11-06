import { authFilled, generatedHeaders } from "../shared/headers.js";
import { describe, expect, it } from "vitest";
import { fromCurl, importCollection, toCurl } from "./import-export.js";
import { newPair, newRequest } from "../shared/request.js";
import { interpolate } from "../shared/request.js";

describe("API Client imports and variables", () => {
  it("round trips quoted cURL values, method, headers, and JSON", () => {
    const request = newRequest();
    request.url = "https://example.com/api";
    request.method = "POST";
    request.headers = [newPair("X-Note", "it's quoted")];
    request.body.type = "json";
    request.body.text = '{"name":"O\'Brien"}';
    const imported = fromCurl(toCurl(request));
    expect(imported.method).toBe(request.method);
    expect(imported.url).toBe(request.url);
    expect(imported.body.text).toBe(request.body.text);
    expect(imported.headers[0]?.value).toBe("it's quoted");
  });
  it("imports nested Postman requests with inherited auth", () => {
    const collection = importCollection(
      JSON.stringify({
        info: { name: "Local API" },
        auth: { type: "bearer", bearer: [{ key: "token", value: "{{token}}" }] },
        item: [
          {
            name: "Health",
            item: [
              { name: "Check", request: { method: "GET", url: { raw: "{{baseUrl}}/health" } } },
            ],
          },
        ],
      }),
    );
    expect(collection.name).toBe("Local API");
    expect(collection.requests[0]?.name).toBe("Check");
    expect(collection.folders?.[0]?.name).toBe("Health");
    expect(collection.locations?.[collection.requests[0]!.id]).toBe(collection.folders?.[0]?.id);
    expect(collection.requests[0]?.auth).toEqual({ type: "bearer", token: "{{token}}" });
  });
  it("supports environment precedence and disabled variables", () => {
    expect(interpolate("{{url}}", [newPair("url", "global"), newPair("url", "local")])).toBe(
      "local",
    );
    expect(() =>
      interpolate("{{secret}}", [{ ...newPair("secret", "x"), enabled: false }]),
    ).toThrow("not defined");
  });
  it("rejects unsupported curl flags instead of silently changing the request", () => {
    expect(() => fromCurl("curl --insecure https://example.com")).toThrow(
      "Unsupported cURL option",
    );
  });
  it("marks authorization only after values are filled and previews generated headers", () => {
    const request = newRequest();
    request.auth = { type: "bearer", token: "" };
    expect(authFilled(request)).toBe(false);
    request.auth.token = "{{token}}";
    expect(authFilled(request)).toBe(true);
    request.body.type = "text";
    request.body.rawFormat = "xml";
    request.headers = [newPair("Accept", "application/xml")];
    const headers = generatedHeaders(request);
    expect(headers.some((header) => header.name === "Accept")).toBe(false);
    expect(headers).toContainEqual({ name: "Content-Type", value: "application/xml" });
    expect(headers).toContainEqual({ name: "Authorization", value: "Bearer {{token}}" });
    expect(toCurl(request)).toContain("Content-Type: application/xml");
  });
});

describe("API Client collection hierarchy", () => {
  it("keeps folder destinations when saving, copying, moving, and importing", async () => {
    const { cloneCollection, deleteTree, duplicateTree, moveTree } =
      await import("./collection-model.js");
    const { initialState, saveToCollection } = await import("./model.js");
    const state = initialState();
    const collection = state.collections[0]!;
    collection.folders = [
      { id: "parent", name: "Accounts", parentId: null },
      { id: "child", name: "Users", parentId: "parent" },
    ];
    const request = newRequest();
    request.name = "List users";
    const saved = saveToCollection(state, request, collection.id, "child").collections[0]!;
    const clone = cloneCollection(saved);
    expect(clone.id).not.toBe(saved.id);
    expect(clone.locations?.[clone.requests[0]!.id]).toBe(clone.folders?.[1]?.id);
    expect(clone.folders?.[1]?.parentId).toBe(clone.folders?.[0]?.id);
    const imported = importCollection(JSON.stringify(saved));
    expect(imported.locations?.[imported.requests[0]!.id]).toBe(imported.folders?.[1]?.id);
    const duplicated = duplicateTree(saved, { kind: "folder", id: "parent" });
    expect(duplicated.requests).toHaveLength(2);
    expect(duplicated.folders).toHaveLength(4);
    expect(() => moveTree(saved, { kind: "folder", id: "parent" }, "child")).toThrow("itself");
    const moved = moveTree(saved, { kind: "request", id: request.id }, "");
    expect(moved.locations?.[request.id]).toBeUndefined();
    const removed = deleteTree(saved, { kind: "folder", id: "parent" });
    expect(removed.requests).toHaveLength(0);
    expect(removed.folders).toHaveLength(0);
    expect(removed.locations).toEqual({});
  });
  it("formats HTML with nested CSS and JavaScript for Pretty responses", async () => {
    const { formatMarkup } = await import("../shared/vendor/format.gen.js");
    const formatted = await formatMarkup(
      "<!DOCTYPE html><html><head><style>body{color:#1a73e8}</style><script>const x={value:42};</script></head><body><h1>Hello</h1></body></html>",
    );
    expect(formatted).toContain("\n<html>");
    expect(formatted).toContain("\n  <head>");
    expect(formatted).toContain("color: #1a73e8;");
    expect(formatted).toContain("\n    <h1>Hello</h1>");
  });
});

describe("API Client query editing", () => {
  it("synchronizes URL edits, duplicate keys, disabled rows, fragments, and variables", async () => {
    const { requestParams, withRequestParams, withRequestUrl } = await import("../shared/query.js");
    let request = withRequestUrl(newRequest(), "{{baseUrl}}/users?tag=one&tag=two#details");
    const original = request.params[0]!.id;
    expect(request.params.map((pair) => [pair.key, pair.value])).toEqual([
      ["tag", "one"],
      ["tag", "two"],
    ]);
    request = withRequestParams(request, [
      { ...request.params[0]!, value: "a & b" },
      { ...request.params[1]!, enabled: false },
      newPair("token", "{{token}}"),
    ]);
    expect(request.url).toBe("{{baseUrl}}/users?tag=a%20%26%20b&token={{token}}#details");
    expect(requestParams(request)).toHaveLength(3);
    request = withRequestUrl(request, "{{baseUrl}}/users?tag=changed&token={{token}}#details");
    expect(request.params[0]!.id).toBe(original);
    expect(request.params.filter((pair) => !pair.enabled)).toHaveLength(1);
    expect(fromCurl(toCurl(request)).params.filter((pair) => pair.key === "tag")).toHaveLength(1);
    request = withRequestUrl(request, "{{baseUrl}}/users?");
    expect(request.url).toBe("{{baseUrl}}/users?");
    expect(request.params.filter((pair) => pair.enabled)).toHaveLength(0);
  });
  it("moves folders across collections without changing IDs or losing unsaved tabs", async () => {
    const { moveCollectionResource } = await import("./collection-model.js");
    const { initialState } = await import("./model.js");
    const state = initialState();
    const source = state.collections[0]!;
    const request = state.tabs[0]!;
    source.requests = [{ ...request, name: "Saved request" }];
    source.folders = [
      { id: "folder", name: "Folder", parentId: null },
      { id: "child", name: "Child", parentId: "folder" },
    ];
    source.locations = { [request.id]: "child" };
    state.collections.push({
      id: "other",
      name: "Other",
      requests: [],
      folders: [{ id: "destination", name: "Destination", parentId: null }],
    });
    const moved = moveCollectionResource(
      state,
      source.id,
      { kind: "folder", id: "folder" },
      "other",
      "destination",
    );
    expect(moved.collections[0]!.requests).toHaveLength(0);
    expect(moved.collections[1]!.requests[0]!.id).toBe(request.id);
    expect(moved.collections[1]!.folders?.find((folder) => folder.id === "folder")?.parentId).toBe(
      "destination",
    );
    expect(moved.collections[1]!.locations?.[request.id]).toBe("child");
    expect(moved.tabs[0]).toBe(request);
    expect(moved.tabs[0]!.name).toBe("Untitled request");
  });
});

describe("API Client tab closing", () => {
  it("closes ranges around the clicked tab and preserves saved requests", async () => {
    const { initialState, tabsToClose, closeRequests } = await import("./model.js");
    const state = initialState();
    state.tabs = [newRequest(), newRequest(), newRequest(), newRequest()];
    state.activeId = state.tabs[2]!.id;
    state.collections[0]!.requests = [state.tabs[0]!];
    const anchor = state.tabs[1]!.id;
    expect(tabsToClose(state, anchor, "left").map((tab) => tab.id)).toEqual([state.tabs[0]!.id]);
    expect(tabsToClose(state, anchor, "right").map((tab) => tab.id)).toEqual(
      state.tabs.slice(2).map((tab) => tab.id),
    );
    const closed = closeRequests(
      state,
      tabsToClose(state, anchor, "right").map((tab) => tab.id),
    );
    expect(closed.activeId).toBe(anchor);
    const only = closeRequests(
      state,
      tabsToClose(state, anchor, "others").map((tab) => tab.id),
    );
    expect(only.tabs.map((tab) => tab.id)).toEqual([anchor]);
    const all = closeRequests(
      state,
      state.tabs.map((tab) => tab.id),
    );
    expect(all.tabs).toHaveLength(1);
    expect(all.tabs[0]!.url).toBe("");
    expect(all.activeId).toBe(all.tabs[0]!.id);
    expect(all.collections).toBe(state.collections);
    expect(all.collections[0]!.requests).toHaveLength(1);
  });
  it("guards unsaved auth and settings edits while closing blank drafts without prompting", async () => {
    const { initialState, needsDiscardConfirmation } = await import("./model.js");
    const state = initialState();
    const request = state.tabs[0]!;
    expect(needsDiscardConfirmation(state, request)).toBe(false);
    expect(
      needsDiscardConfirmation(state, { ...request, auth: { type: "bearer", token: "secret" } }),
    ).toBe(true);
    expect(needsDiscardConfirmation(state, { ...request, timeoutMs: 5000 })).toBe(true);
  });
});

describe("API Client variable experience", () => {
  it("resolves environment, collection, globals and nested values with matching diagnostics", async () => {
    const { initialState } = await import("./model.js");
    const { variableStatus, saveVariable, activeVariablePairs } =
      await import("./variables-model.js");
    let state = initialState();
    const request = state.tabs[0]!;
    state.collections[0]!.requests = [request];
    state.globals = [newPair("host", "global.example"), newPair("baseUrl", "https://{{host}}")];
    state.collections[0]!.variables = [newPair("host", "collection.example")];
    state.environments = [
      { id: "dev", name: "Development", variables: [newPair("host", "dev.example")] },
      { id: "prod", name: "Production", variables: [newPair("onlyProd", "production")] },
    ];
    state.activeEnvironmentId = "dev";
    expect(variableStatus(state, "baseUrl")).toMatchObject({
      resolved: true,
      value: "https://dev.example",
      source: "Globals",
    });
    expect(interpolate("{{baseUrl}}", activeVariablePairs(state))).toBe("https://dev.example");
    expect(variableStatus(state, "host").source).toBe("Development");
    expect(variableStatus(state, "onlyProd")).toMatchObject({
      resolved: false,
      scopeId: "dev",
    });
    expect(variableStatus(state, "onlyProd")).not.toHaveProperty("otherEnvironments");
    const { variableDefinitions } = await import("./variables-model.js");
    expect(variableDefinitions(state).map((variable) => variable.name)).not.toContain("onlyProd");
    state = saveVariable(state, "onlyProd", "now available", "dev");
    expect(variableStatus(state, "onlyProd").value).toBe("now available");
    state.activeEnvironmentId = null;
    expect(variableStatus(state, "host").value).toBe("collection.example");
    state = saveVariable(state, "host", "new.example", `collection:${state.collections[0]!.id}`);
    expect(variableStatus(state, "baseUrl").value).toBe("https://new.example");
    state = saveVariable(state, "loop", "{{loop}}", "globals");
    expect(variableStatus(state, "loop")).toMatchObject({
      resolved: false,
      error: expect.stringContaining("circular"),
    });
    state = saveVariable(state, "broken", "{{missing}}", "globals");
    expect(variableStatus(state, "broken").resolved).toBe(false);
  });
  it("preserves Postman collection variables", () => {
    const collection = importCollection(
      JSON.stringify({
        info: { name: "Scoped API" },
        variable: [
          { key: "id", value: 42 },
          { key: "disabled", value: "hidden", disabled: true },
        ],
        item: [{ name: "Get", request: { method: "GET", url: "https://example.com/{{id}}" } }],
      }),
    );
    expect(
      collection.variables?.map(({ key, value, enabled }) => ({ key, value, enabled })),
    ).toEqual([
      { key: "id", value: "42", enabled: true },
      { key: "disabled", value: "hidden", enabled: false },
    ]);
  });
});

it("retains collection scope when history opens an independent persisted draft", async () => {
  const { initialState, recordHistory, openHistoryRequest, stateSchema, closeRequests } =
    await import("./model.js");
  const { activeVariablePairs } = await import("./variables-model.js");
  let state = initialState();
  const saved = state.tabs[0]!;
  saved.url = "{{baseUrl}}/users";
  state.collections[0]!.requests = [structuredClone(saved)];
  state.collections[0]!.variables = [newPair("baseUrl", "https://collection.example")];
  state.environments = [
    { id: "dev", name: "Development", variables: [newPair("token", "active-token")] },
  ];
  state.activeEnvironmentId = "dev";
  state = recordHistory(state, saved, null, null);
  state = openHistoryRequest(state, state.history[0]!);
  expect(state.activeId).not.toBe(saved.id);
  expect(state.activeEnvironmentId).toBe("dev");
  expect(interpolate("{{baseUrl}}", activeVariablePairs(state))).toBe("https://collection.example");
  state = stateSchema.parse(JSON.parse(JSON.stringify(state)));
  expect(interpolate("{{baseUrl}}", activeVariablePairs(state))).toBe("https://collection.example");
  const draft = state.tabs.find((tab) => tab.id === state.activeId)!;
  draft.url = "{{baseUrl}}/changed";
  expect(state.collections[0]!.requests[0]!.url).toBe("{{baseUrl}}/users");
  state = recordHistory(state, draft, null, null);
  state.collections[0]!.requests = [];
  const closedId = state.activeId;
  state = closeRequests(state, [closedId]);
  state = openHistoryRequest(state, state.history[0]!);
  expect(interpolate("{{baseUrl}}", activeVariablePairs(state))).toBe("https://collection.example");
});

it("accepts the maximum valid globals, collection, and environment variables when sending", async () => {
  const { initialState, stateSchema } = await import("./model.js");
  const { activeVariablePairs } = await import("./variables-model.js");
  const { sendRpc } = await import("../shared/contracts.js");
  const state = initialState();
  const request = state.tabs[0]!;
  request.url = "https://example.com";
  state.collections[0]!.requests = [request];
  const rows = (prefix: string) =>
    Array.from({ length: 200 }, (_, index) => newPair(`${prefix}${index}`, String(index)));
  state.globals = rows("global");
  state.collections[0]!.variables = rows("collection");
  state.environments = [{ id: "dev", name: "Development", variables: rows("environment") }];
  state.activeEnvironmentId = "dev";
  expect(stateSchema.safeParse(state).success).toBe(true);
  const variables = activeVariablePairs(state);
  expect(variables).toHaveLength(600);
  const input = { requestId: crypto.randomUUID(), request, variables, cookieJar: "" };
  expect(sendRpc.input.safeParse(input).success).toBe(true);
  expect(
    sendRpc.input.safeParse({ ...input, variables: [...variables, newPair("extra", "value")] })
      .success,
  ).toBe(false);
});
