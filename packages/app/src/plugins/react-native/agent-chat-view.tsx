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
  draft,
  active,
  focused = active,
  contextFile,
  onOpenFile,
  onOpenAgent,
}: AgentChatProps) {
  ensurePanelsRegistered();
  const toast = useToast();
  const tabId = `plugin-chat:${agentId ?? draft?.id}`;
  const wasActive = useRef(false);
  const instance = useId();
  const source = `plugin-agent-chat:${instance}`;
  const timeline = useSessionStore((state) => state.sessions[serverId]?.viewedTimelineSync ?? null);
  useLayoutEffect(() => {
    timeline?.replaceVisibleAgentIds(source, active && agentId ? [agentId] : []);
    return () => timeline?.replaceVisibleAgentIds(source, []);
  }, [timeline, source, active, agentId]);
  useEffect(() => {
    if (!active) return;
    const runtime = getHostRuntimeStore();
    const prepare = agentId
      ? Promise.all([
          runtime.prepareAgentRoute(serverId, agentId),
          runtime.prepareAgentTimeline(serverId, agentId),
        ])
      : runtime.prepareWorkspaceRoute(serverId, workspaceId);
    void prepare.catch((error) =>
      toast.error(error instanceof Error ? error.message : "Could not load the conversation."),
    );
  }, [active, serverId, workspaceId, agentId, toast]);
  useEffect(() => {
    const focus = active && !wasActive.current;
    wasActive.current = active;
    if (!active || !contextFile) return;
    void useDraftStore
      .getState()
      .attachWorkspaceFile({
        draftKey: buildDraftStoreKey({ serverId, agentId: agentId ?? tabId, draftId: draft?.id }),
        attachment: createWorkspaceFileAttachment({ path: contextFile }),
        focus,
      })
      .catch((error) =>
        toast.error(error instanceof Error ? error.message : "Could not attach the selected file."),
      );
  }, [active, contextFile, serverId, agentId, tabId, draft?.id, toast]);
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
  const retarget = useCallback(
    (target: WorkspaceTabTarget) => {
      if (draft && target.kind === "agent") draft.onCreated(target.agentId);
      else open(target);
    },
    [draft, open],
  );
  const openConversation = useCallback(() => {
    if (agentId) onOpenAgent(agentId);
  }, [agentId, onOpenAgent]);
  const content = useMemo<WorkspacePaneContentModel>(
    () => ({
      key: `${serverId}:${tabId}`,
      Component: AgentConversationPanel,
      paneContextValue: {
        serverId,
        workspaceId,
        host: "main",
        tabId,
        target: draft ? { kind: "draft", draftId: draft.id } : { kind: "agent", agentId: agentId! },
        draftAgentConfig: draft
          ? { systemPrompt: draft.systemPrompt, title: draft.title }
          : undefined,
        state,
        openTab: open,
        openPreferredTarget: open,
        retargetCurrentTab: retarget,
        setCurrentTabState: setState,
        openFileInWorkspace: openFile,
        closeCurrentTab: openConversation,
        openImportSheet: openConversation,
      },
    }),
    [
      serverId,
      workspaceId,
      agentId,
      tabId,
      draft,
      state,
      open,
      openFile,
      retarget,
      openConversation,
    ],
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
          onOpenImportSheet: openConversation,
        }),
    };
  }, [serverId, workspaceId, active, open, openFile, openConversation]);
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
