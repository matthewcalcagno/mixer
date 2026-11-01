import type { WorkspaceTabTarget } from "./model";
import { SOURCE_CONTROL_TARGET } from "./source-control";

/** Source Control's non-root panels are file comparisons, including restored legacy diff slots. */
export function usesFileTabLabel(target: WorkspaceTabTarget): boolean {
  if (target.kind === "file") return true;
  if (target.kind !== "plugin") return false;
  return (
    target.pluginId === SOURCE_CONTROL_TARGET.pluginId &&
    target.context === "workspace" &&
    target.panelId !== SOURCE_CONTROL_TARGET.panelId
  );
}
