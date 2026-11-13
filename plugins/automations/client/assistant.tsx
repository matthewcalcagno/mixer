import { useCallback, useEffect, useMemo } from "react";
import { Text, View } from "react-native";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMixer, useRpc, useSettings, type PluginScreenProps } from "@mixer/plugin/client";
import { Button, FloatingAgentChat, SettingsSelect, useToast } from "@mixer/plugin/client/ui";
import { automationFileId, automationSettings, chatRpc } from "../shared/contracts.js";
import { useConfiguration } from "./configuration.js";

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
  const chat = useRpc(chatRpc);
  const query = useQueryClient();
  const toast = useToast();
  const configuration = useConfiguration();
  const configured = !!configuration.data?.agentProvider;
  const start = useMutation({ mutationFn: () => chat({}) });
  const { mutate, isIdle, data } = start;
  useEffect(() => {
    if (visible && configured && isIdle) mutate();
  }, [visible, configured, isIdle, mutate]);
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
    (agentId: string) => {
      openConversation(agentId);
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
      if (data)
        navigation?.openFile?.({ path: file, workspaceId: data.workspaceId, serverId: host.id });
    },
    [selectFile, dirty, toast, data, navigation, host.id],
  );
  const retry = useCallback(() => mutate(), [mutate]);
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
      conversation={data ?? null}
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
        {!configured && <AssistantAgentPicker host={host} theme={theme} visible={visible} />}
        <Text style={styles.text}>
          {start.isPending
            ? "Starting agent…"
            : "Choose an agent to start a conversation about your workflows."}
        </Text>
        {start.error && (
          <>
            <Text accessibilityRole="alert" style={styles.error}>
              {start.error.message}
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

function AssistantAgentPicker({
  host,
  theme,
  visible,
}: Pick<PluginScreenProps, "host" | "theme"> & { visible: boolean }) {
  const mixer = useMixer();
  const settings = useSettings(automationSettings);
  const providers = useQuery({
    queryKey: ["automations", host.id, "assistant-providers"],
    queryFn: () => mixer.providers.listAvailable(),
    enabled: visible,
    staleTime: 30_000,
  });
  const selected = settings.status === "ready" ? settings.values.agentProvider : "";
  const options = useMemo(() => {
    const values =
      providers.data?.providers
        .filter((provider) => provider.available)
        .map((provider) => ({ value: provider.provider, label: provider.provider })) ?? [];
    if (selected && !values.some((option) => option.value === selected))
      values.unshift({ value: selected, label: selected });
    return [{ value: "", label: "Choose an agent" }, ...values];
  }, [providers.data, selected]);
  const change = useCallback(
    (provider: string) => {
      if (settings.status === "ready")
        void settings.save({ ...settings.values, agentProvider: provider }, settings.revision);
    },
    [settings],
  );
  const errorStyle = useMemo(() => ({ color: theme.colors.statusDanger }), [theme]);
  const noteStyle = useMemo(() => ({ color: theme.colors.foregroundMuted }), [theme]);
  if (settings.status !== "ready")
    return (
      <Text style={noteStyle}>
        {"error" in settings ? settings.error : "Loading agent settings…"}
      </Text>
    );
  return (
    <View>
      <SettingsSelect
        label="Ask AI agent"
        value={selected}
        options={options}
        onValueChange={change}
        disabled={settings.saving}
      />
      {settings.saveError && (
        <Text accessibilityRole="alert" style={errorStyle}>
          {settings.saveError}
        </Text>
      )}
      {providers.error && (
        <Text accessibilityRole="alert" style={errorStyle}>
          {providers.error.message}
        </Text>
      )}
    </View>
  );
}
