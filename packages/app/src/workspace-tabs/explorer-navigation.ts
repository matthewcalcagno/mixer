import type { PluginWorkspaceTabTarget, WorkspaceTabTarget } from "./model";
import { isSourceControlTarget } from "./source-control";

export const SEARCH_TARGET = {
  kind: "plugin",
  pluginId: "search",
  panelId: "search",
  context: "workspace",
} satisfies PluginWorkspaceTabTarget;
export function isSearchTarget(target: WorkspaceTabTarget): boolean {
  return (
    target.kind === "plugin" &&
    target.pluginId === "search" &&
    target.panelId === "search" &&
    target.context === "workspace"
  );
}
export function isFixedExplorerTarget(target: WorkspaceTabTarget): boolean {
  return isSearchTarget(target) || isSourceControlTarget(target);
}

export function isExplorerNavigationTarget(target: WorkspaceTabTarget): boolean {
  return target.kind === "files" || isFixedExplorerTarget(target);
}
