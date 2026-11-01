import { buildPluginSettingsRoute } from "./settings/routes";
import { router } from "expo-router";
import type { PluginPanelLocation } from "@mixer/plugin/client";
import { navigateToWorkspace } from "@/stores/navigation-active-workspace-store";
import { useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import { buildPluginSurfaceRoute } from "./routes";
import type { PluginNavigation } from "./actions";
import { DEFAULT_PANE_ID } from "@/stores/workspace-layout-store";
import { openWorkspacePreviewInPane } from "@/workspace-tabs/open-beside";

export function createPluginNavigation(input: {
  serverId: string;
  workspaceId: string | null;
}): PluginNavigation {
  const { serverId, workspaceId } = input;
  function placement(location: PluginPanelLocation) {
    if (location !== "explorer") return undefined;
    if (!workspaceId) throw new Error("No active workspace");
    const workspaceKey = `${serverId}:${workspaceId}`;
    const paneId = useWorkspaceLayoutStore.getState().showExplorerSidebar(workspaceKey);
    if (!paneId) throw new Error("Explorer is unavailable");
    return { mode: "pane" as const, paneId };
  }
  return {
    openSettings(pluginId, screenId) {
      router.push(buildPluginSettingsRoute(serverId, pluginId, screenId));
    },
    openSurface(pluginId, surfaceId, params) {
      router.push(
        buildPluginSurfaceRoute(serverId, pluginId, { kind: "surface", id: surfaceId }, params),
      );
    },
    openWorkspacePanel(pluginId, panelId, location, preview) {
      if (!workspaceId) throw new Error("No active workspace");
      const store = useWorkspaceLayoutStore.getState();
      if (preview && location === "workspace" && store.layoutMode !== "compact") {
        const workspaceKey = `${serverId}:${workspaceId}`;
        const paneId = store.layoutByWorkspace[workspaceKey]?.focusedPaneId ?? DEFAULT_PANE_ID;
        openWorkspacePreviewInPane({
          workspaceKey,
          serverId,
          workspaceId,
          paneId,
          target: { kind: "plugin", pluginId, panelId, context: "workspace" },
        });
        navigateToWorkspace({
          serverId,
          workspaceId,
          target: { kind: "plugin", pluginId, panelId, context: "workspace" },
        });
        return;
      }
      navigateToWorkspace({
        serverId,
        workspaceId,
        target: { kind: "plugin", pluginId, panelId, context: "workspace" },
        placement: placement(location),
      });
    },
    openAgentPanel(pluginId, panelId, agentId, location) {
      if (!workspaceId) throw new Error("No active workspace");
      navigateToWorkspace({
        serverId,
        workspaceId,
        target: { kind: "plugin", pluginId, panelId, context: "agent", agentId },
        placement: placement(location),
      });
    },
  };
}
