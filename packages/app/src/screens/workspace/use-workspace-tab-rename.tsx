import { createContext, useContext, useCallback, useState, type ReactNode } from "react";
import { type QueryClient } from "@tanstack/react-query";
import type { DaemonClient } from "@mixer/client/internal/daemon-client";
import type { ListTerminalsResponse } from "@mixer/protocol/messages";
import { useTranslation } from "react-i18next";
import { InlineRename } from "@/components/ui/inline-rename";
import { useSessionStore } from "@/stores/session-store";
import type { WorkspaceTabDescriptor } from "@/screens/workspace/workspace-tabs-types";

interface RenamingTabState {
  key: string;
  kind: "terminal" | "agent";
  id: string;
  currentTitle: string;
}

interface UseWorkspaceTabRenameInput {
  client: DaemonClient | null;
  normalizedServerId: string;
  queryClient: QueryClient;
  terminalsData: ListTerminalsResponse["payload"] | undefined;
  terminalsQueryKey: readonly unknown[];
}

interface UseWorkspaceTabRenameResult {
  renamingTab: RenamingTabState | null;
  handleRenameTab: (tab: WorkspaceTabDescriptor) => void;
  handleRenameSubmit: (nextTitle: string) => Promise<void>;
  handleRenameClose: () => void;
}

export function useWorkspaceTabRename(
  input: UseWorkspaceTabRenameInput,
): UseWorkspaceTabRenameResult {
  const { client, normalizedServerId, queryClient, terminalsData, terminalsQueryKey } = input;
  const { t } = useTranslation();
  const [renamingTab, setRenamingTab] = useState<RenamingTabState | null>(null);

  const handleRenameTab = useCallback(
    (tab: WorkspaceTabDescriptor) => {
      if (tab.target.kind === "terminal") {
        const { terminalId } = tab.target;
        const terminal = terminalsData?.terminals.find((entry) => entry.id === terminalId) ?? null;
        const currentTitle = terminal?.title ?? terminal?.name ?? "";
        setRenamingTab({ key: tab.key, kind: "terminal", id: terminalId, currentTitle });
        return;
      }
      if (tab.target.kind === "agent") {
        const { agentId } = tab.target;
        const agent =
          useSessionStore.getState().sessions[normalizedServerId]?.agents?.get(agentId) ?? null;
        const currentTitle = agent?.title ?? "";
        setRenamingTab({ key: tab.key, kind: "agent", id: agentId, currentTitle });
      }
    },
    [normalizedServerId, terminalsData],
  );

  const handleRenameSubmit = useCallback(
    async (nextTitle: string) => {
      if (!renamingTab) return;
      if (!client) {
        throw new Error(t("workspace.terminal.hostDisconnected"));
      }
      const trimmed = nextTitle.trim();
      if (renamingTab.kind === "terminal") {
        const result = await client.renameTerminal({
          terminalId: renamingTab.id,
          title: trimmed,
        });
        if (!result.success) {
          throw new Error(result.error ?? "Failed to rename terminal");
        }
        void queryClient.invalidateQueries({ queryKey: terminalsQueryKey });
        return;
      }
      await client.updateAgent(renamingTab.id, { name: trimmed });
      void queryClient.invalidateQueries({
        queryKey: ["sidebarAgentsList", normalizedServerId],
      });
      void queryClient.invalidateQueries({
        queryKey: ["allAgents", normalizedServerId],
      });
    },
    [client, normalizedServerId, queryClient, renamingTab, terminalsQueryKey, t],
  );

  const handleRenameClose = useCallback(() => {
    setRenamingTab(null);
  }, []);

  return {
    renamingTab,
    handleRenameTab,
    handleRenameSubmit,
    handleRenameClose,
  };
}

const RenameContext = createContext<UseWorkspaceTabRenameResult | null>(null);
export const WorkspaceTabRenameProvider = RenameContext.Provider;
export function useWorkspaceTabRenameContext() {
  return useContext(RenameContext);
}
export function useIsTabRenaming(key: string): boolean {
  return useContext(RenameContext)?.renamingTab?.key === key;
}
export function WorkspaceTabInlineName({
  tab,
  children,
}: {
  tab: WorkspaceTabDescriptor;
  children: ReactNode;
}) {
  const rename = useContext(RenameContext);
  const { t } = useTranslation();
  const begin = useCallback(
    (event: React.MouseEvent) => {
      if (tab.kind !== "agent" && tab.kind !== "terminal") return;
      event.preventDefault();
      event.stopPropagation();
      rename?.handleRenameTab(tab);
    },
    [rename, tab],
  );
  const renamingTab = rename?.renamingTab;
  if (!rename || !renamingTab || renamingTab.key !== tab.key)
    return (
      <span
        data-inline-tab-rename={tab.kind === "agent" || tab.kind === "terminal"}
        onDoubleClick={begin}
      >
        {children}
      </span>
    );
  const title =
    renamingTab.kind === "terminal"
      ? t("workspace.tabs.menu.renameTerminal")
      : t("workspace.tabs.menu.renameAgent");
  return (
    <InlineRename
      key={renamingTab.key}
      label={title}
      initialValue={renamingTab.currentTitle}
      maxLength={200}
      onClose={rename.handleRenameClose}
      onSubmit={rename.handleRenameSubmit}
      testID={`workspace-tab-rename-input-${renamingTab.kind}-${renamingTab.id}`}
    />
  );
}
