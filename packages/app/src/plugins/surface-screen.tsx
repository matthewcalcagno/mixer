import { router, useLocalSearchParams } from "expo-router";
import type { PluginScreenParams, PluginScreenProps } from "@mixer/plugin/client";
import type { PluginTheme } from "@mixer/plugin";
import type { Theme } from "@/styles/theme";
import { useCallback, useMemo, type ComponentType } from "react";
import { Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { HostFilter } from "@/components/hosts/host-filter";
import type { HostPickerHost } from "@/components/hosts/host-picker";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useHostRuntimeClient, useHosts } from "@/runtime/host-runtime";
import { usePluginHostNavigation } from "./host-navigation";
import { toPluginTheme } from "./theme";
import { useInstalledPlugin, usePluginInstallations } from "./registry-state";
import { buildPluginSurfaceRoute, pluginScreenParamsFromRoute } from "./routes";
import {
  legacySidebarItemHostKey,
  pluginScreensHostKey,
  rememberPluginContributionHost,
} from "./contribution-host";
import { SurfaceErrorBoundary } from "./surface-error-boundary";
import { PluginInstallationProvider } from "./installation-provider";
import {
  getPluginSurfaceContributionServerIds,
  resolvePluginSurfaceContribution,
  type PluginSurfaceContributionIdentity,
} from "./surface-contribution";
import { resolvePluginPlatform } from "./platform";
import { MainPanelIsland } from "@/components/main-panel-island";
const pluginThemeMapping = (theme: Theme) => ({
  theme: toPluginTheme(theme),
});

function routeParam(value: string | string[] | undefined): string {
  return typeof value === "string" ? value : "";
}

function SurfaceRenderer({
  Surface,
  plugin,
  layout,
  host,
  params,
  theme,
}: {
  Surface: ComponentType<PluginScreenProps>;
  plugin: NonNullable<ReturnType<typeof useInstalledPlugin>>;
  layout: PluginScreenProps["layout"];
  host: PluginScreenProps["host"];
  params: PluginScreenParams;
  theme: PluginTheme;
}) {
  const navigation = usePluginHostNavigation(host.id);
  return (
    <PluginInstallationProvider plugin={plugin}>
      <Surface theme={theme} host={host} layout={layout} navigation={navigation} params={params} />
    </PluginInstallationProvider>
  );
}

const ThemedSurfaceRenderer = withUnistyles(SurfaceRenderer);

function PluginHostFilter({
  serverId,
  pluginId,
  identity,
  params,
  hosts,
}: {
  serverId: string;
  pluginId: string;
  identity: PluginSurfaceContributionIdentity;
  params: PluginScreenParams;
  hosts: HostPickerHost[];
}) {
  const selectHost = useCallback(
    (nextServerId: string) => {
      // A legacy row remembers its own host; a screen's host carries to all the plugin's items.
      rememberPluginContributionHost(
        identity.kind === "sidebar"
          ? legacySidebarItemHostKey(pluginId, identity.id)
          : pluginScreensHostKey(pluginId),
        nextServerId,
      );
      router.replace(buildPluginSurfaceRoute(nextServerId, pluginId, identity, params));
    },
    [identity, params, pluginId],
  );
  return (
    <HostFilter
      hosts={hosts}
      selectedHost={serverId}
      onSelectHost={selectHost}
      includeAllHost={false}
      triggerTestID="plugin-host-filter-trigger"
    />
  );
}

export function PluginSurfaceScreen() {
  const routeParams = useLocalSearchParams<{
    serverId?: string | string[];
    pluginId?: string | string[];
    contributionKind?: string | string[];
    contributionId?: string | string[];
  }>();
  const serverId = routeParam(routeParams.serverId);
  const pluginId = routeParam(routeParams.pluginId);
  const contributionKind = routeParam(routeParams.contributionKind);
  const contributionId = routeParam(routeParams.contributionId);
  const paramsKey = JSON.stringify(pluginScreenParamsFromRoute(routeParams));
  // Keyed by content: the route hands back a new object on every render.
  const params = useMemo<PluginScreenParams>(() => JSON.parse(paramsKey), [paramsKey]);
  const identity = useMemo<PluginSurfaceContributionIdentity | null>(() => {
    if (contributionKind !== "sidebar" && contributionKind !== "surface") return null;
    return { kind: contributionKind, id: contributionId };
  }, [contributionId, contributionKind]);
  const plugin = useInstalledPlugin(serverId, pluginId);
  const installations = usePluginInstallations(pluginId);
  const hosts = useHosts();
  const client = useHostRuntimeClient(serverId);
  const compact = useIsCompactFormFactor();
  const { surface } = useMemo(
    () => resolvePluginSurfaceContribution(plugin, identity),
    [identity, plugin],
  );
  const hostLabel = hosts.find((host) => host.serverId === serverId)?.label ?? serverId;
  // The hosts this contribution is installed on; the filter shows when there is a choice.
  const filterHosts = useMemo(() => {
    if (!identity) return [];
    const serverIds = getPluginSurfaceContributionServerIds(installations, pluginId, identity);
    return hosts.filter((candidate) => serverIds.includes(candidate.serverId));
  }, [hosts, identity, installations, pluginId]);
  const layout = useMemo(() => ({ compact, platform: resolvePluginPlatform() }), [compact]);
  const host = useMemo(() => ({ id: serverId, label: hostLabel }), [hostLabel, serverId]);
  const hostFilter = useMemo(
    () =>
      identity && filterHosts.length > 1 ? (
        <PluginHostFilter
          serverId={serverId}
          pluginId={pluginId}
          identity={identity}
          params={params}
          hosts={filterHosts}
        />
      ) : null,
    [filterHosts, identity, params, pluginId, serverId],
  );

  return (
    <MainPanelIsland testID="plugin-main-island" framed={surface?.presentation !== "workspace"}>
      <View style={styles.body}>
        {hostFilter ? <View style={styles.hostControls}>{hostFilter}</View> : null}
        {plugin && surface && client ? (
          <SurfaceErrorBoundary
            key={`${serverId}/${pluginId}/${identity?.kind}/${contributionId}`}
            installation={plugin}
            Surface={surface.Component}
          >
            <ThemedSurfaceRenderer
              Surface={surface.Component}
              plugin={plugin}
              host={host}
              layout={layout}
              params={params}
              uniProps={pluginThemeMapping}
            />
          </SurfaceErrorBoundary>
        ) : (
          <Text style={styles.errorText}>
            {plugin && surface ? "Plugin host is offline." : "This plugin surface is unavailable."}
          </Text>
        )}
      </View>
    </MainPanelIsland>
  );
}

const styles = StyleSheet.create((theme) => ({
  body: {
    flex: 1,
    minWidth: 0,
    minHeight: 0,
  },
  hostControls: { alignItems: "flex-end", padding: theme.spacing[3] },
  errorText: {
    color: theme.colors.statusDanger,
    padding: theme.spacing[4],
  },
}));
