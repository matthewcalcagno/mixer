import type { PluginSurfaceProps } from "@mixer/plugin/client";
import { useSessionStore } from "@/stores/session-store";
import { resolveWorkspaceMapKeyByIdentity } from "@/utils/workspace-identity";
import { useMemo } from "react";
import { navigateToWorkspace } from "@/stores/navigation-active-workspace-store";
import { navigateToAgent } from "@/utils/navigate-to-agent";

import { getIsElectron } from "@/constants/platform";
import { createWorkspaceBrowser } from "@/desktop/browser/store";
import { createPluginHostNavigation } from "./host-navigation-model";
import { DEFAULT_PANE_ID, useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import { openWorkspacePreviewInPane } from "@/workspace-tabs/open-beside";

function navigatePluginWorkspace(input: Parameters<typeof navigateToWorkspace>[0]): void {
  if (input.target?.kind === "file") {
    const store = useWorkspaceLayoutStore.getState();
    if (store.layoutMode !== "compact") {
      const workspaceKey = `${input.serverId}:${input.workspaceId}`;
      openWorkspacePreviewInPane({
        workspaceKey,
        serverId: input.serverId,
        workspaceId: input.workspaceId,
        paneId: store.layoutByWorkspace[workspaceKey]?.focusedPaneId ?? DEFAULT_PANE_ID,
        target: input.target,
      });
    }
  }
  navigateToWorkspace(input);
}

export function usePluginHostNavigation(
  serverId: string,
): NonNullable<PluginSurfaceProps["navigation"]> {
  return useMemo(
    () =>
      createPluginHostNavigation(serverId, {
        browserAvailable: getIsElectron(),
        openAgent: navigateToAgent,
        openWorkspace: navigatePluginWorkspace,
        createBrowser: createWorkspaceBrowser,
        resolveWorkspace: ({ serverId: targetServerId, workspaceId }) =>
          resolveWorkspaceMapKeyByIdentity({
            workspaces: useSessionStore.getState().sessions[targetServerId]?.workspaces,
            workspaceId,
          }),
      }),
    [serverId],
  );
}
