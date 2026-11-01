import type { PluginSurfaceProps } from "@mixer/plugin/client";
import type { NavigateToWorkspaceInput } from "@/stores/navigation-active-workspace-store";
import { isHttpUrl } from "@/utils/http-url";

interface HostNavigationOwner {
  browserAvailable: boolean;
  openAgent(input: { serverId: string; agentId: string }): void;
  openWorkspace(input: NavigateToWorkspaceInput): void;
  resolveWorkspace(input: { serverId: string; workspaceId: string }): string | null;
  createBrowser(input: { initialUrl: string }): { browserId: string };
}

export function createPluginHostNavigation(
  serverId: string,
  owner: HostNavigationOwner,
): NonNullable<PluginSurfaceProps["navigation"]> {
  return {
    openFile: ({ workspaceId, path: filePath, lineStart, serverId: targetServerId }) => {
      const path = filePath.replace(/\\/g, "/");
      const invalidPath =
        !path.trim() ||
        path.startsWith("/") ||
        /^[a-z][a-z0-9+.-]*:/i.test(path) ||
        path.split("/").includes("..");
      if (invalidPath) throw new Error("A workspace-relative file path is required.");
      if (lineStart !== undefined && (!Number.isInteger(lineStart) || lineStart < 1))
        throw new Error("lineStart must be a positive integer.");
      const destinationServerId = targetServerId ?? serverId;
      const destinationWorkspaceId = owner.resolveWorkspace({
        serverId: destinationServerId,
        workspaceId,
      });
      if (!destinationWorkspaceId)
        throw new Error("Workspace is unavailable on the requested host.");
      owner.openWorkspace({
        serverId: destinationServerId,
        workspaceId: destinationWorkspaceId,
        target: { kind: "file", path, ...(lineStart ? { lineStart } : {}) },
      });
    },
    openAgent: ({ agentId, serverId: targetServerId }) =>
      owner.openAgent({ serverId: targetServerId ?? serverId, agentId }),
    openWorkspace: ({ workspaceId, serverId: targetServerId }) =>
      owner.openWorkspace({ serverId: targetServerId ?? serverId, workspaceId }),
    openBrowser: owner.browserAvailable
      ? ({ url, workspaceId, serverId: targetServerId }) => {
          if (!isHttpUrl(url)) throw new Error("Only absolute HTTP(S) URLs are supported.");
          if (!workspaceId.trim()) throw new Error("workspaceId is required.");
          const destinationServerId = targetServerId ?? serverId;
          const destinationWorkspaceId = owner.resolveWorkspace({
            serverId: destinationServerId,
            workspaceId,
          });
          if (!destinationWorkspaceId)
            throw new Error("Workspace is unavailable on the requested host.");
          const { browserId } = owner.createBrowser({ initialUrl: url });
          owner.openWorkspace({
            serverId: destinationServerId,
            workspaceId: destinationWorkspaceId,
            target: { kind: "browser", browserId },
          });
        }
      : undefined,
  };
}
