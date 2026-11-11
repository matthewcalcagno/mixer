import { WORKSPACE_ISLAND_GAP } from "@/styles/workspace-islands";
import { WORKSPACE_STATUS_BAR_HEIGHT } from "@/constants/layout";
import { useCallback, useMemo, useSyncExternalStore } from "react";
import { View } from "react-native";
import { GitBranch } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useAppSettings } from "@/hooks/use-settings";
import { useHosts } from "@/runtime/host-runtime";
import { usePluginHostNavigation } from "@/plugins/host-navigation";
import { resolvePluginPlatform } from "@/plugins/platform";
import { pluginStatusBarStore } from "@/plugins/status-bar/store";
import { statusItemsForWorkspace } from "@/plugins/status-bar/model";
import { toPluginTheme } from "@/plugins/theme";
import { BranchSwitcher } from "@/components/branch-switcher";
import type { Theme } from "@/styles/theme";
import { StatusEntry } from "./item";
import { PluginStatusItem } from "./plugin-item";
import { StatusBarMenu } from "./menu";
import { StatusBarActions } from "./actions";
import { uniqueStatusChoices, updateHiddenStatusItems, type StatusMenuAction } from "./model";
import { useActiveEditorStatus } from "./active-editor";
import { EditorLanguageStatus } from "./editor-language";

interface WorkspaceStatusBarProps {
  serverId: string;
  workspaceId: string;
  workspaceDirectory: string | null;
  isGitCheckout: boolean;
  branch: string | null;
}
function StatusBar({
  serverId,
  workspaceId,
  workspaceDirectory,
  isGitCheckout,
  branch,
  theme,
}: WorkspaceStatusBarProps & { theme: Theme }) {
  const compact = useIsCompactFormFactor();
  const editor = useActiveEditorStatus(serverId, workspaceId);
  const { t } = useTranslation();
  const { settings, updateSettings } = useAppSettings();
  const entries = useSyncExternalStore(
    pluginStatusBarStore.subscribe,
    pluginStatusBarStore.getSnapshot,
    pluginStatusBarStore.getSnapshot,
  );
  const hosts = useHosts();
  const navigation = usePluginHostNavigation(serverId);
  const current = useMemo(
    () => statusItemsForWorkspace(entries, serverId, workspaceId),
    [entries, serverId, workspaceId],
  );
  const hidden = useMemo(
    () => new Set(settings.hiddenStatusBarItems),
    [settings.hiddenStatusBarItems],
  );
  const hostLabel = hosts.find((host) => host.serverId === serverId)?.label ?? serverId;
  const environment = useMemo(
    () => ({
      workspaceId,
      theme: toPluginTheme(theme),
      host: { id: serverId, label: hostLabel },
      layout: { compact, platform: resolvePluginPlatform() },
      navigation,
    }),
    [workspaceId, theme, serverId, hostLabel, compact, navigation],
  );
  const choices = useMemo(() => {
    const pluginChoices = current.map((entry) => ({
      id: entry.preferenceKey,
      label: entry.name,
      checked: !hidden.has(entry.preferenceKey),
    }));
    if (isGitCheckout)
      pluginChoices.unshift({
        id: "builtin:git-branch",
        label: t("statusBar.branch"),
        checked: !hidden.has("builtin:git-branch"),
      });
    if (editor)
      pluginChoices.push({
        id: "builtin:language-mode",
        label: t("statusBar.languageMode"),
        checked: !hidden.has("builtin:language-mode"),
      });
    return uniqueStatusChoices(pluginChoices);
  }, [current, hidden, isGitCheckout, t, editor]);
  const onAction = useCallback(
    (action: StatusMenuAction) => {
      void updateSettings((previous) => ({
        hiddenStatusBarItems: updateHiddenStatusItems(
          previous.hiddenStatusBarItems,
          action.id,
          action.visible,
        ),
      }));
    },
    [updateSettings],
  );
  const branchIcon = useMemo(
    () => <GitBranch size={14} color={theme.colors.foregroundMuted} />,
    [theme.colors.foregroundMuted],
  );
  const renderBranchTrigger = useCallback(
    (onPress: () => void, pending: boolean) => (
      <StatusEntry
        pending={pending}
        label={branch ?? "HEAD"}
        tooltip={t("branchSwitcher.triggerTooltip")}
        accessibilityLabel={t("branchSwitcher.currentBranch", { branchName: branch ?? "HEAD" })}
        color={theme.colors.foregroundMuted}
        icon={branchIcon}
        onPress={onPress}
        testID="status-bar-branch"
      />
    ),
    [branch, branchIcon, t, theme.colors.foregroundMuted],
  );
  const visible = current.filter((entry) => !hidden.has(entry.preferenceKey));
  if (compact) return null;
  return (
    <StatusBarMenu choices={choices} onAction={onAction}>
      <View
        style={styles.bar}
        testID="workspace-status-bar"
        accessibilityLabel={t("statusBar.title")}
      >
        <View style={styles.left}>
          {visible
            .filter((entry) => entry.alignment === "left" && entry.priority > 1000)
            .map((entry) => (
              <PluginStatusItem key={entry.key} entry={entry} environment={environment} />
            ))}
          {isGitCheckout && !hidden.has("builtin:git-branch") && (
            <BranchSwitcher
              key={`${serverId}:${workspaceId}`}
              currentBranchName={branch}
              serverId={serverId}
              workspaceId={workspaceId}
              workspaceDirectory={workspaceDirectory}
              isGitCheckout={isGitCheckout}
              placement="top-start"
              renderTrigger={renderBranchTrigger}
            />
          )}
          {visible
            .filter((entry) => entry.alignment === "left" && entry.priority <= 1000)
            .map((entry) => (
              <PluginStatusItem key={entry.key} entry={entry} environment={environment} />
            ))}
        </View>
        <View style={styles.right}>
          {visible
            .filter((entry) => entry.alignment === "right")
            .map((entry) => (
              <PluginStatusItem key={entry.key} entry={entry} environment={environment} />
            ))}
          {editor && !hidden.has("builtin:language-mode") && (
            <EditorLanguageStatus key={`${editor.key}:${editor.filename}`} entry={editor} />
          )}
        </View>
        <StatusBarActions />
      </View>
    </StatusBarMenu>
  );
}
export const WorkspaceStatusBar = withUnistyles(StatusBar, (theme) => ({ theme }));
const styles = StyleSheet.create((theme) => ({
  bar: {
    height: WORKSPACE_STATUS_BAR_HEIGHT,
    width: "100%",
    flexShrink: 0,
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: theme.colors.background,
    paddingHorizontal: WORKSPACE_ISLAND_GAP,
  },
  left: {
    flex: 1,
    minWidth: 0,
    height: "100%",
    flexDirection: "row",
    alignItems: "center",
    overflow: "hidden",
  },
  right: {
    flexShrink: 1,
    minWidth: 0,
    maxWidth: "65%",
    height: "100%",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "flex-end",
    overflow: "hidden",
  },
}));

export function EmptyStatusBar() {
  const compact = useIsCompactFormFactor();
  const { t } = useTranslation();
  if (compact) return null;
  return (
    <View
      style={styles.bar}
      testID="workspace-status-bar"
      accessibilityLabel={t("statusBar.title")}
    >
      <View style={styles.left} />
      <StatusBarActions />
    </View>
  );
}
