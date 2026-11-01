import { describe, expect, test } from "vitest";
import {
  FileSubscribeRequestSchema,
  FileSubscribeResponseSchema,
  FileUnsubscribeRequestSchema,
  FileUpdateSchema,
  FileWriteRequestSchema,
  FileWriteResponseSchema,
  ServerInfoStatusPayloadSchema,
  SessionInboundMessageSchema,
  SessionOutboundMessageSchema,
} from "./messages.js";

describe("workspace file editing messages", () => {
  test("accepts language provider discovery and keeps new capability fields optional", () => {
    expect(
      ServerInfoStatusPayloadSchema.parse({ status: "server_info", serverId: "host", features: {} })
        .features?.languageProviders,
    ).toBeUndefined();
    expect(
      SessionInboundMessageSchema.parse({
        type: "workspace.language.providers.request",
        requestId: "providers",
      }).type,
    ).toBe("workspace.language.providers.request");
    expect(
      SessionInboundMessageSchema.parse({
        type: "workspace.language.query.request",
        requestId: "language",
        workspaceId: "workspace",
        language: "custom/lua",
        channelId: "editor",
        method: "initialize",
        params: {},
        notification: false,
      }).type,
    ).toBe("workspace.language.query.request");
    expect(
      SessionOutboundMessageSchema.parse({
        type: "workspace.language.providers.response",
        payload: {
          requestId: "providers",
          providers: [
            {
              id: "custom/lua",
              label: "Lua",
              documents: [{ languageId: "lua", extensions: [".lua"] }],
              status: "available",
            },
          ],
        },
      }).type,
    ).toBe("workspace.language.providers.response");
  });
  test("Git annotations are optional on older hosts and use namespaced request/response pairs", () => {
    expect(
      ServerInfoStatusPayloadSchema.parse({ status: "server_info", serverId: "host", features: {} })
        .features?.editorGitAnnotations,
    ).toBeUndefined();
    expect(
      SessionInboundMessageSchema.parse({
        type: "workspace.git.blame.request",
        requestId: "blame",
        workspaceId: "workspace",
        path: "src/file.ts",
        content: "unsaved\n",
      }).type,
    ).toBe("workspace.git.blame.request");
    expect(
      SessionOutboundMessageSchema.parse({
        type: "workspace.git.blame.response",
        payload: { requestId: "blame", result: { kind: "unavailable", reason: "untracked" } },
      }).type,
    ).toBe("workspace.git.blame.response");
    expect(() =>
      SessionInboundMessageSchema.parse({
        type: "workspace.git.commit.request",
        requestId: "commit",
        workspaceId: "workspace",
        path: "src/file.ts",
        sha: "--unsafe-option",
      }),
    ).toThrow();
  });
  test("keeps the capability optional for older server info payloads", () => {
    expect(
      ServerInfoStatusPayloadSchema.parse({
        status: "server_info",
        serverId: "server-1",
        features: {},
      }).features?.workspaceFileEditing,
    ).toBeUndefined();
  });

  test("parses subscribe, unsubscribe, and version update messages", () => {
    expect(
      FileSubscribeRequestSchema.parse({
        type: "fs.file.subscribe.request",
        cwd: "/workspace",
        path: "file.ts",
        subscriptionId: "subscription-1",
        requestId: "request-1",
      }).subscriptionId,
    ).toBe("subscription-1");
    expect(
      FileSubscribeResponseSchema.parse({
        type: "fs.file.subscribe.response",
        payload: {
          subscriptionId: "subscription-1",
          initial: {
            status: "ready",
            cwd: "/workspace",
            path: "file.ts",
            size: 12,
            modifiedAt: "2026-07-18T00:00:00.000Z",
          },
          requestId: "request-1",
        },
      }).payload.initial.status,
    ).toBe("ready");
    expect(
      FileUnsubscribeRequestSchema.parse({
        type: "fs.file.unsubscribe.request",
        subscriptionId: "subscription-1",
        requestId: "request-2",
      }).subscriptionId,
    ).toBe("subscription-1");
    expect(
      FileUpdateSchema.parse({
        type: "fs.file.update",
        payload: {
          subscriptionId: "subscription-1",
          version: { status: "missing", cwd: "/workspace", path: "file.ts" },
        },
      }).payload.version.status,
    ).toBe("missing");
  });

  test("parses optimistic write requests and conflict responses", () => {
    expect(
      FileWriteRequestSchema.parse({
        type: "fs.file.write.request",
        cwd: "/workspace",
        path: "file.ts",
        content: "const value = 1;\n",
        expectedModifiedAt: "2026-07-18T00:00:00.000Z",
        requestId: "request-1",
      }).content,
    ).toBe("const value = 1;\n");
    expect(
      FileWriteResponseSchema.parse({
        type: "fs.file.write.response",
        payload: {
          result: {
            status: "conflict",
            version: {
              status: "ready",
              cwd: "/workspace",
              path: "file.ts",
              size: 20,
              modifiedAt: "2026-07-18T00:00:01.000Z",
            },
          },
          requestId: "request-1",
        },
      }).payload.result.status,
    ).toBe("conflict");
  });
});
