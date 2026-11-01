import { useCallback, useRef, useState } from "react";
import { View } from "react-native";
import { CircleGauge, Server } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { router } from "expo-router";
import { ToolbarButton } from "@/components/ui/pane-content-toolbar";
import { HostPicker } from "@/components/hosts/host-picker";
import { useHosts } from "@/runtime/host-runtime";
import { UsageSidebarRoot, useOpenSidebarUsage } from "@/usage";
import { buildSettingsAddHostRoute } from "@/utils/host-routes";
import { openHostOverview } from "@/navigation/settings-navigation";
import { builtinSidebarNavLabelKey } from "@/sidebar-nav/model";

const UsageIcon = withUnistyles(CircleGauge, (theme) => ({ color: theme.colors.foregroundMuted }));
const HostsIcon = withUnistyles(Server, (theme) => ({ color: theme.colors.foregroundMuted }));

export function StatusBarActions() {
  return (
    <UsageSidebarRoot>
      <Actions />
    </UsageSidebarRoot>
  );
}
function Actions() {
  const { t } = useTranslation();
  const openUsage = useOpenSidebarUsage();
  const hosts = useHosts();
  const anchor = useRef<View | null>(null);
  const [hostsOpen, setHostsOpen] = useState(false);
  const showHosts = useCallback(() => setHostsOpen(true), []);
  const addHost = useCallback(() => router.push(buildSettingsAddHostRoute(Date.now())), []);
  return (
    <View style={styles.actions} testID="status-bar-global-actions">
      <ToolbarButton
        label={t(builtinSidebarNavLabelKey("usage"))}
        onPress={openUsage}
        tooltipSide="top"
        testID="sidebar-usage-icon"
      >
        <UsageIcon size={16} />
      </ToolbarButton>
      <HostPicker
        hosts={hosts}
        value=""
        onSelect={openHostOverview}
        open={hostsOpen}
        onOpenChange={setHostsOpen}
        anchorRef={anchor}
        includeAddHost
        onAddHost={addHost}
        showActiveConnection
        onOpenHostSettings={openHostOverview}
        searchable
        desktopPlacement="top-start"
        desktopMinWidth={240}
        addHostTestID="sidebar-host-add"
        hostOptionTestID={hostOptionTestID}
      >
        <View ref={anchor} collapsable={false}>
          <ToolbarButton
            label={t("sidebar.actions.hosts")}
            onPress={showHosts}
            tooltipSide="top"
            testID="sidebar-hosts-trigger"
          >
            <HostsIcon size={15} />
          </ToolbarButton>
        </View>
      </HostPicker>
    </View>
  );
}
function hostOptionTestID(serverId: string) {
  return `sidebar-host-row-${serverId}`;
}
const styles = StyleSheet.create((theme) => ({
  actions: {
    flexDirection: "row",
    alignItems: "center",
    flexShrink: 0,
    gap: theme.spacing[1],
    marginLeft: theme.spacing[2],
    marginRight: theme.spacing[2],
  },
}));
