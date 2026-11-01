import type { PluginWorkspaceTabTarget, WorkspaceTabTarget } from "./model";

export const SOURCE_CONTROL_TARGET = {
  kind: "plugin",
  pluginId: "source-control",
  panelId: "source-control",
  context: "workspace",
} satisfies PluginWorkspaceTabTarget;

export function isSourceControlTarget(target: WorkspaceTabTarget): boolean {
  return (
    target.kind === "plugin" &&
    target.pluginId === SOURCE_CONTROL_TARGET.pluginId &&
    target.panelId === SOURCE_CONTROL_TARGET.panelId &&
    target.context === "workspace"
  );
}
