import { useMemo } from "react";
import { useFetchQuery } from "@/data/query";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { useRetainedPanelActive } from "@/components/retained-panel";
import { decorationsRpc } from "../../../../plugins/source-control/shared/git";
import { buildGitDecorations } from "./git-decorations";

export function useGitDecorations(
  serverId: string,
  workspaceId: string | null | undefined,
  projectId: string | null | undefined,
  root: string,
) {
  const client = useHostRuntimeClient(serverId);
  const connected = useHostRuntimeIsConnected(serverId);
  const active = useRetainedPanelActive();
  const query = useFetchQuery({
    dataShape: "list",
    staleTimeMs: 3000,
    queryKey: ["fileExplorerGitDecorations", serverId, root, workspaceId, projectId],
    queryFn: async () =>
      decorationsRpc.output.parse(
        await client!.invokePluginRpc(
          "source-control",
          decorationsRpc.name,
          workspaceId ? { workspaceId } : { projectId },
        ),
      ),
    enabled: !!client && connected && active && !!root && !!(workspaceId || projectId),
    refetchInterval: 3000,
    retry: false,
  });
  return useMemo(
    () => buildGitDecorations(query.isError ? [] : (query.data ?? [])),
    [query.data, query.isError],
  );
}
