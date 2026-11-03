import { describe, expect, it } from "vitest";
import {
  createWorkspaceFileAttachment,
  workspaceFileAttachmentToAgentAttachment,
} from "./workspace-file";
import {
  parseWorkspaceFileDragPayload,
  resolveWorkspaceFileDrop,
  serializeWorkspaceFileDragPayload,
  type WorkspaceFileDragPayload,
} from "./workspace-file-drag";

function payload(): WorkspaceFileDragPayload {
  return {
    version: 1,
    serverId: "server-1",
    workspaceId: "workspace-1",
    attachment: createWorkspaceFileAttachment({
      path: "src/app.ts",
      selection: { kind: "line_range", startLine: 12, endLine: 24 },
    }),
  };
}

describe("workspace file drag payload", () => {
  it("round-trips workspace identity and future line selections", () => {
    expect(parseWorkspaceFileDragPayload(serializeWorkspaceFileDragPayload(payload()))).toEqual(
      payload(),
    );
  });

  it("preserves a folder reference through drag, drop, and submission", () => {
    const dragged = {
      ...payload(),
      attachment: createWorkspaceFileAttachment({
        path: "packages/app",
        selection: { kind: "whole_folder" },
      }),
    };
    const parsed = parseWorkspaceFileDragPayload(serializeWorkspaceFileDragPayload(dragged));
    expect(parsed).toEqual(dragged);
    if (!parsed) throw new Error("Missing folder drag payload");
    const attachment = resolveWorkspaceFileDrop({
      payload: parsed,
      serverId: dragged.serverId,
      workspaceId: dragged.workspaceId,
    });
    if (!attachment) throw new Error("Missing folder attachment");
    expect(workspaceFileAttachmentToAgentAttachment(attachment)).toEqual({
      type: "text",
      mimeType: "text/plain",
      title: "app",
      text: "Workspace folder: packages/app",
    });
  });

  it("rejects malformed and invalid payloads", () => {
    expect(parseWorkspaceFileDragPayload("not json")).toBeNull();
    expect(
      parseWorkspaceFileDragPayload(
        JSON.stringify({
          ...payload(),
          attachment: {
            kind: "workspace_file",
            path: "src/app.ts",
            selection: { kind: "line_range", startLine: 24, endLine: 12 },
          },
        }),
      ),
    ).toBeNull();
  });

  it("accepts drops only within the originating server and workspace", () => {
    const dragged = payload();
    expect(
      resolveWorkspaceFileDrop({
        payload: dragged,
        serverId: "server-1",
        workspaceId: "workspace-1",
      }),
    ).toEqual(dragged.attachment);
    expect(
      resolveWorkspaceFileDrop({
        payload: dragged,
        serverId: "server-1",
        workspaceId: "workspace-2",
      }),
    ).toBeNull();
  });
});
