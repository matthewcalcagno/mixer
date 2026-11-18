/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { createAutomationWorkspaceStore, useAutomationWorkspaceField } from "./workspace-state.js";

beforeEach(() => localStorage.clear());

describe("Automations workspace persistence", () => {
  it("keeps the active conversation when the React screen unmounts and mounts again", () => {
    const first = renderHook(() => useAutomationWorkspaceField("navigation-host", "assistant"));
    const draftId = first.result.current[0].draftId;
    act(() => first.result.current[1]({ draftId, agentId: "chat-a" }));
    expect(first.result.current[0].agentId).toBe("chat-a");
    first.unmount();
    const returned = renderHook(() => useAutomationWorkspaceField("navigation-host", "assistant"));
    expect(returned.result.current[0]).toEqual({ draftId, agentId: "chat-a" });
    returned.unmount();
  });

  it("restores the floating conversation and open state after leaving the screen", () => {
    const workspace = createAutomationWorkspaceStore("host-a", localStorage);
    const draftId = workspace.getSnapshot().assistant.draftId;
    workspace.set("assistant", { draftId, agentId: "conversation-a" });
    workspace.set("aiOpen", true);

    const restored = createAutomationWorkspaceStore("host-a", localStorage);
    expect(restored.getSnapshot().assistant).toEqual({ draftId, agentId: "conversation-a" });
    expect(restored.getSnapshot().aiOpen).toBe(true);
  });

  it("restores conversation tabs, workflow tabs, selection, and unsaved content", () => {
    const workspace = createAutomationWorkspaceStore("host-a", localStorage);
    workspace.set("agentTabs", [{ agentId: "chat-a", workspaceId: "workspace-a" }]);
    workspace.set("page", { kind: "agent", agentId: "chat-a" });
    workspace.set("documents", { selected: "task.md", paths: ["task.md", "config.json"] });
    workspace.set("editorDrafts", {
      "task.md": {
        source: { path: "task.md", content: "original", version: "a".repeat(64) },
        content: "unsaved changes",
      },
    });

    const restored = createAutomationWorkspaceStore("host-a", localStorage).getSnapshot();
    expect(restored.agentTabs).toEqual([{ agentId: "chat-a", workspaceId: "workspace-a" }]);
    expect(restored.page).toEqual({ kind: "agent", agentId: "chat-a" });
    expect(restored.documents).toEqual({ selected: "task.md", paths: ["task.md", "config.json"] });
    expect(restored.editorDrafts["task.md"]).toEqual({
      source: { path: "task.md", content: "original", version: "a".repeat(64) },
      content: "unsaved changes",
    });
  });

  it("remembers explicit closes and does not restore another host's workspace", () => {
    const workspace = createAutomationWorkspaceStore("host-a", localStorage);
    workspace.set("aiOpen", true);
    workspace.set("agentTabs", [{ agentId: "chat-a", workspaceId: "workspace-a" }]);
    workspace.set("aiOpen", false);
    workspace.set("agentTabs", () => []);
    expect(createAutomationWorkspaceStore("host-a", localStorage).getSnapshot().aiOpen).toBe(false);
    expect(createAutomationWorkspaceStore("host-a", localStorage).getSnapshot().agentTabs).toEqual(
      [],
    );
    expect(createAutomationWorkspaceStore("host-b", localStorage).getSnapshot().agentTabs).toEqual(
      [],
    );
    expect(
      createAutomationWorkspaceStore("host-b", localStorage).getSnapshot().assistant.agentId,
    ).toBeUndefined();
  });

  it("reports unavailable storage while preserving the conversation in this window", () => {
    const workspace = createAutomationWorkspaceStore("host-a", {
      getItem: () => null,
      setItem: () => {
        throw new Error("quota exceeded");
      },
    });
    workspace.set("assistant", (previous) => ({ ...previous, agentId: "chat-a" }));
    expect(workspace.getSnapshot().assistant.agentId).toBe("chat-a");
    expect(workspace.getError()).toBe(
      "Could not save the Automations workspace. Keep this window open to preserve your chats and drafts.",
    );
  });

  it("rejects corrupted saved state instead of rendering invalid tabs", () => {
    localStorage.setItem("mixer:automations:workspace:v1:host-a", '{"agentTabs":"invalid"}');
    const workspace = createAutomationWorkspaceStore("host-a", localStorage);
    expect(workspace.getSnapshot().agentTabs).toEqual([]);
    expect(workspace.getError()).toBe(
      "Could not restore the Automations workspace. Saved state is unavailable or invalid.",
    );
  });
});
