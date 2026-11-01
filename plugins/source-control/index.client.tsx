import type { PluginClientContext, PluginWorkspacePanelProps } from "@mixer/plugin/client";
import type { ComponentProps } from "react";
import type { RpcInput } from "@mixer/plugin";
import { SourceControlActivityIcon } from "./client/activity-icon.js";
import { statusRpc } from "./shared/git.js";
import { SourceControlPanel } from "./client/source-control.js";
import { ProjectSourceControlPanel } from "./client/project-panel.js";
import { SourceControlDiffPanel } from "./client/diff-panel.js";
import { selectDiff, type DiffSelection } from "./client/diff-selection.js";
import { getFileIconSvg } from "./client/vendor/file-icon-svg.js";
import { rememberedDiffs, rememberedDiffTabs, rememberDiff } from "./client/web.js";

export default function contribute(client: PluginClientContext) {
  const readStatus = (input: RpcInput<typeof statusRpc>) => client.rpc(statusRpc, input);
  function SourceControlIcon(
    props: Omit<ComponentProps<typeof SourceControlActivityIcon>, "readStatus">,
  ) {
    return <SourceControlActivityIcon {...props} readStatus={readStatus} />;
  }
  const diffPanels = new Map<string, string>();
  const cleanups: (() => void)[] = [];
  function registerDiff(selection: DiffSelection, restoredPanelId?: string) {
    const key = JSON.stringify(selection);
    let panelId = restoredPanelId ?? diffPanels.get(key);
    if (!panelId || restoredPanelId) {
      panelId =
        restoredPanelId ??
        `file-diff-${Array.from(key, (character) => character.codePointAt(0)?.toString(16) ?? "").join("-")}`;
      const name = selection.path.split("/").pop() ?? selection.path;
      function FileDiffPanel(props: PluginWorkspacePanelProps) {
        return (
          <SourceControlDiffPanel
            {...props}
            scope={{ workspaceId: props.workspaceId }}
            selection={selection}
            onKeepOpen={props.tab.keepOpen}
          />
        );
      }
      cleanups.push(
        client.addWorkspacePanel({
          id: panelId,
          title: `${name} (${selection.staged ? "Index" : "Working Tree"})`,
          icon: { svg: getFileIconSvg(name) },
          context: "workspace",
          locations: ["workspace"],
          Component: FileDiffPanel,
        }),
      );
      diffPanels.set(key, panelId);
    }
    return panelId;
  }
  // COMPAT(sourceControlDiffSlots): added in v0.14.0, remove after 2027-04-29.
  // Keep already-restored slot IDs resolvable; all new opens use host-owned preview tabs.
  for (const tab of rememberedDiffTabs()) registerDiff(tab.selection, tab.id);
  for (const selection of rememberedDiffs()) registerDiff(selection);
  function openDiff(workspaceId: string, selection: DiffSelection) {
    rememberDiff(selection);
    const panelId = registerDiff(selection);
    selectDiff(workspaceId, selection);
    client.openPanel(panelId, { workspaceId, location: "workspace", preview: true });
  }
  function SourceControlWorkspacePanel(props: PluginWorkspacePanelProps) {
    const openFile = props.navigation?.openFile;
    return (
      <SourceControlPanel
        {...props}
        scope={{ workspaceId: props.workspaceId }}
        onOpenFile={
          openFile ? (path) => openFile({ workspaceId: props.workspaceId, path }) : undefined
        }
        onOpenDiff={(selection) => openDiff(props.workspaceId, selection)}
      />
    );
  }
  client.addWorkspacePanel({
    id: "source-control",
    title: "Source Control",
    icon: SourceControlIcon,
    context: "workspace",
    locations: ["explorer", "workspace"],
    Component: SourceControlWorkspacePanel,
    ProjectComponent: ProjectSourceControlPanel,
  });
  client.addCommandCenterItem({
    id: "open-source-control",
    title: "Open Source Control",
    icon: "GitBranch",
    context: "workspace",
    onSelect({ openPanel }) {
      openPanel("source-control");
    },
  });
  return () => {
    for (const cleanup of cleanups) cleanup();
  };
}
