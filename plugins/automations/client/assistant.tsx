import { useCallback, useEffect, useMemo, useState } from "react";
import { Text, View } from "react-native";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMixer, useRpc, type PluginScreenProps } from "@mixer/plugin/client";
import { Button, FloatingAgentChat, useToast } from "@mixer/plugin/client/ui";
import { automationFileId, prepareChatRpc } from "../shared/contracts.js";

export function AutomationAssistant({
  theme,
  host,
  navigation,
  path,
  dirty,
  visible,
  launcherVisible,
  onOpenChange,
  selectFile,
  openConversation,
}: Pick<PluginScreenProps, "theme" | "host" | "navigation"> & {
  path: string;
  dirty: boolean;
  visible: boolean;
  launcherVisible: boolean;
  onOpenChange(open: boolean): void;
  selectFile(path: string): void;
  openConversation(agentId: string): void;
}) {
  const mixer = useMixer();
  const prepare = useRpc(prepareChatRpc);
  const query = useQueryClient();
  const toast = useToast();
  const [agentId, setAgentId] = useState<string>();
  const [draftId] = useState(() => globalThis.crypto.randomUUID());
  const {
    data: workspace,
    error,
    refetch,
  } = useQuery({
    queryKey: ["automations", host.id, "assistant-workspace-v2"],
    queryFn: () => prepare({}),
    enabled: visible,
    staleTime: Infinity,
    retry: false,
  });
  const data = useMemo(
    () => (agentId && workspace ? { agentId, workspaceId: workspace.workspaceId } : null),
    [agentId, workspace],
  );
  const draft = useMemo(
    () => (workspace ? { ...workspace, id: draftId, onCreated: setAgentId } : undefined),
    [draftId, workspace],
  );
  useEffect(() => {
    if (!data) return;
    let disposed = false;
    const observation = mixer.agents.ref(data.agentId).timeline.subscribe(({ event }) => {
      if (
        ["turn_completed", "turn_failed", "turn_canceled", "subscription_restored"].includes(
          event.type,
        )
      )
        void query.invalidateQueries({ queryKey: ["automations"] });
    });
    void observation.ready.catch(() => {
      if (!disposed)
        toast.error("Could not observe workflow changes. Use Refresh after the agent finishes.");
    });
    return () => {
      disposed = true;
      void observation();
    };
  }, [mixer, data, query, toast]);
  const openAgent = useCallback(
    (id: string) => {
      openConversation(id);
    },
    [openConversation],
  );
  const openFile = useCallback(
    (file: string) => {
      if (automationFileId.safeParse(file).success) {
        selectFile(file);
        return;
      }
      if (dirty) {
        toast.error("Save your workflow drafts before leaving Automations.");
        return;
      }
      if (workspace)
        navigation?.openFile?.({
          path: file,
          workspaceId: workspace.workspaceId,
          serverId: host.id,
        });
    },
    [selectFile, dirty, toast, workspace, navigation, host.id],
  );
  const retry = useCallback(() => {
    void refetch();
  }, [refetch]);
  const styles = useMemo(
    () => ({
      bootstrap: { padding: 16, gap: 12 },
      text: { color: theme.colors.foregroundMuted, fontSize: theme.typography?.chrome ?? 13 },
      error: { color: theme.colors.statusDanger, fontSize: theme.typography?.chrome ?? 13 },
    }),
    [theme],
  );
  return (
    <FloatingAgentChat
      serverId={host.id}
      conversation={data}
      draft={draft}
      open={visible}
      launcherVisible={launcherVisible}
      onOpenChange={onOpenChange}
      contextFile={path || undefined}
      title="Automations AI"
      testID="automations-assistant"
      accessibilityLabel="Ask Automations AI"
      notice={dirty ? "Save your draft before asking AI to change files." : undefined}
      onOpenAgent={openAgent}
      onOpenFile={openFile}
    >
      <View style={styles.bootstrap}>
        {!error && <Text style={styles.text}>Opening composer…</Text>}
        {error && (
          <>
            <Text accessibilityRole="alert" style={styles.error}>
              {error.message}
            </Text>
            <Button size="sm" variant="outline" onPress={retry}>
              Retry
            </Button>
          </>
        )}
      </View>
    </FloatingAgentChat>
  );
}
