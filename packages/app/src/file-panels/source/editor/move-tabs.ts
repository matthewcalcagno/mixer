import { useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import { buildWorkspaceTabPersistenceKey } from "@/workspace-tabs/model";
import { resolveWorkspaceFilePaths } from "@/workspace/file-open";

export function retargetFileTabs(input: {
  serverId: string;
  workspaceId: string;
  root: string;
  from: string;
  to: string;
}) {
  const key = buildWorkspaceTabPersistenceKey(input);
  if (!key) return;
  const layout = useWorkspaceLayoutStore.getState();
  for (const tab of layout.getWorkspaceTabs(key)) {
    if (tab.target.kind !== "file") continue;
    const resolved = resolveWorkspaceFilePaths({
      path: tab.target.path,
      workspaceRoot: input.root,
    });
    if (resolved?.absolutePath === input.from)
      layout.replaceTab(
        key,
        tab.tabId,
        { ...tab.target, path: input.to.slice(input.root.length + 1) },
        tab.state,
      );
  }
}
