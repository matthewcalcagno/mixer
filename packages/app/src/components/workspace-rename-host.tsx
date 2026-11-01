import { useCallback } from "react";
import { beginWorkspaceInlineRename } from "@/components/sidebar/workspace-inline-rename";
import { useKeyboardActionHandler } from "@/hooks/use-keyboard-action-handler";
import type { KeyboardActionId } from "@/keyboard/keyboard-action-dispatcher";
import { useActiveWorkspaceSelection } from "@/stores/navigation-active-workspace-store";
import { useToast } from "@/contexts/toast-context";

const WORKSPACE_RENAME_ACTIONS: readonly KeyboardActionId[] = ["workspace.rename"];

export function WorkspaceRenameHost() {
  const selection = useActiveWorkspaceSelection();
  const toast = useToast();
  const handle = useCallback(() => {
    if (!selection) return false;
    const opened = beginWorkspaceInlineRename(selection.serverId, selection.workspaceId);
    if (!opened) toast.error("Show the workspace in the sidebar to rename it.");
    return true;
  }, [selection, toast]);
  useKeyboardActionHandler({
    handlerId: "workspace-rename-global",
    actions: WORKSPACE_RENAME_ACTIONS,
    enabled: selection !== null,
    priority: 0,
    handle,
  });
  return null;
}
