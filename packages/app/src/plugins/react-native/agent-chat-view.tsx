import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { AgentChatProps } from "@mixer/plugin/client/ui";
import { AgentConversationPanel } from "@/panels/agent-panel";
import {
  WorkspacePaneContent,
  buildWorkspacePaneContentModel,
  type WorkspacePaneContentModel,
} from "@/screens/workspace/workspace-pane-content";
import { RetainedPanel } from "@/components/retained-panel";
import type { WorkspaceTabTarget } from "@/workspace-tabs/model";
import type { WorkspaceFileOpenRequest } from "@/workspace/file-open";
import { navigateToWorkspace } from "@/stores/navigation-active-workspace-store";
import { useDraftStore } from "@/stores/draft-store";
import { buildDraftStoreKey } from "@/stores/draft-keys";
import { createWorkspaceFileAttachment } from "@/attachments/workspace-file";
import { useToast } from "@/contexts/toast-context";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import { useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import { buildWorkspaceTabPersistenceKey } from "@/workspace-tabs/model";
import type { SheetPaneHost } from "@/screens/workspace/sheet-pane/host";
import { AgentChatEnvironment } from "./agent-chat-environment";
import invariant from "tiny-invariant";
import { ensurePanelsRegistered } from "@/panels/register-panels";

export default function AgentChatView({
  serverId,
  workspaceId,
  agentId,
  active,
  focused = active,
  contextFile,
  onOpenFile,
  onOpenAgent,
}: AgentChatProps) {
  ensurePanelsRegistered();
  const toast = useToast();
  const wasActive = useRef(false);
  const instance = useId();
  const source = `plugin-agent-chat:${instance}`;
  const timeline = useSessionStore((state) => state.sessions[serverId]?.viewedTimelineSync ?? null);
  useLayoutEffect(() => {
    timeline?.replaceVisibleAgentIds(source, active ? [agentId] : []);
    return () => timeline?.replaceVisibleAgentIds(source, []);
  }, [timeline, source, active, agentId]);
  useEffect(() => {
    if (!active) return;
    const runtime = getHostRuntimeStore();
    void Promise.all([
      runtime.prepareAgentRoute(serverId, agentId),
      runtime.prepareAgentTimeline(serverId, agentId),
    ]).catch((error) =>
      toast.error(error instanceof Error ? error.message : "Could not load the conversation."),
    );
  }, [active, serverId, agentId, toast]);
  useEffect(() => {
    const focus = active && !wasActive.current;
    wasActive.current = active;
    if (!active || !contextFile) return;
    void useDraftStore
      .getState()
      .attachWorkspaceFile({
        draftKey: buildDraftStoreKey({ serverId, agentId }),
        attachment: createWorkspaceFileAttachment({ path: contextFile }),
        focus,
      })
      .catch((error) =>
        toast.error(error instanceof Error ? error.message : "Could not attach the selected file."),
      );
  }, [active, contextFile, serverId, agentId, toast]);
  const [state, setState] = useState<WorkspacePaneContentModel["paneContextValue"]["state"]>();
  const openFile = useCallback(
    (request: WorkspaceFileOpenRequest) => onOpenFile(request.location.path),
    [onOpenFile],
  );
  const open = useCallback(
    (target: WorkspaceTabTarget) => {
      if (target.kind === "agent") {
        onOpenAgent(target.agentId);
        return;
      }
      if (target.kind === "file") {
        onOpenFile(target.path);
        return;
      }
      navigateToWorkspace({ serverId, workspaceId, target });
    },
    [onOpenAgent, onOpenFile, serverId, workspaceId],
  );
  const content = useMemo<WorkspacePaneContentModel>(
    () => ({
      key: `${serverId}:${agentId}:plugin-chat`,
      Component: AgentConversationPanel,
      paneContextValue: {
        serverId,
        workspaceId,
        host: "main",
        tabId: `plugin-chat:${agentId}`,
        target: { kind: "agent", agentId },
        state,
        openTab: open,
        openPreferredTarget: open,
        retargetCurrentTab: open,
        setCurrentTabState: setState,
        openFileInWorkspace: openFile,
        closeCurrentTab: () => onOpenAgent(agentId),
        openImportSheet: () => onOpenAgent(agentId),
      },
    }),
    [serverId, workspaceId, agentId, state, open, openFile, onOpenAgent],
  );
  const sheetHost = useMemo<SheetPaneHost>(() => {
    const workspaceKey = buildWorkspaceTabPersistenceKey({ serverId, workspaceId });
    invariant(workspaceKey, "AgentChat requires an owning host and workspace");
    return {
      workspaceKey,
      serverId,
      workspaceId,
      isWorkspaceFocused: active,
      buildContent: (tab, closeCurrentTab) =>
        buildWorkspacePaneContentModel({
          tab,
          normalizedServerId: serverId,
          normalizedWorkspaceId: workspaceId,
          host: "sheet",
          onOpenTab: open,
          onOpenPreferredTarget: open,
          onCloseCurrentTab: closeCurrentTab,
          onRetargetCurrentTab: open,
          onSetCurrentTabState: (value) =>
            useWorkspaceLayoutStore.getState().setTabState(workspaceKey, tab.tabId, value),
          onOpenWorkspaceFile: openFile,
          onOpenImportSheet: () => onOpenAgent(agentId),
        }),
    };
  }, [serverId, workspaceId, active, open, openFile, onOpenAgent, agentId]);
  return (
    <RetainedPanel active={active}>
      <AgentChatEnvironment host={sheetHost}>
        <WorkspacePaneContent
          content={content}
          isWorkspaceFocused={active}
          isPaneFocused={active && focused}
        />
      </AgentChatEnvironment>
    </RetainedPanel>
  );
}
