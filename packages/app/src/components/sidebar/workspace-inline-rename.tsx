import {
  createContext,
  useContext,
  useCallback,
  useLayoutEffect,
  type ReactNode,
  type CSSProperties,
} from "react";
import { InlineRename } from "@/components/ui/inline-rename";
import { useTranslation } from "react-i18next";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
interface RenamableWorkspace {
  serverId: string;
  workspaceId: string;
  name: string;
  title?: string | null;
}

const renameTargets = new Map<string, Set<() => void>>();
export function beginWorkspaceInlineRename(serverId: string, workspaceId: string): boolean {
  const targets = renameTargets.get(`${serverId}:${workspaceId}`);
  const begin = targets?.values().next().value;
  if (!begin) return false;
  begin();
  return true;
}

interface RenameContext {
  open: boolean;
  begin: () => void;
  close: () => void;
}
const Context = createContext<RenameContext | null>(null);
const nameStyle: CSSProperties = { minWidth: 0, flexShrink: 1 };
export const WorkspaceInlineRenameProvider = Context.Provider;
export function useWorkspaceInlineRename() {
  return useContext(Context);
}

export function WorkspaceInlineName({
  workspace,
  children,
}: {
  workspace: RenamableWorkspace;
  children: ReactNode;
}) {
  const rename = useWorkspaceInlineRename();
  useLayoutEffect(() => {
    if (!rename) return;
    const key = `${workspace.serverId}:${workspace.workspaceId}`;
    const targets = renameTargets.get(key) ?? new Set<() => void>();
    targets.add(rename.begin);
    renameTargets.set(key, targets);
    return () => {
      targets.delete(rename.begin);
      if (targets.size === 0) renameTargets.delete(key);
    };
  }, [rename, workspace.serverId, workspace.workspaceId]);
  const begin = useCallback(
    (event: React.MouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      rename?.begin();
    },
    [rename],
  );
  if (rename?.open)
    return (
      <WorkspaceNameField
        key={`${workspace.serverId}:${workspace.workspaceId}`}
        workspace={workspace}
        close={rename.close}
      />
    );
  return (
    <div onDoubleClick={begin} style={nameStyle}>
      {children}
    </div>
  );
}

function WorkspaceNameField({
  workspace,
  close,
}: {
  workspace: RenamableWorkspace;
  close: () => void;
}) {
  const { t } = useTranslation();
  const submit = useCallback(
    async (title: string) => {
      const client = getHostRuntimeStore().getClient(workspace.serverId);
      if (!client) throw new Error(t("sidebar.workspace.toasts.hostDisconnected"));
      await client.setWorkspaceTitle(workspace.workspaceId, title || null);
    },
    [workspace.serverId, workspace.workspaceId, t],
  );
  return (
    <InlineRename
      initialValue={workspace.title ?? workspace.name}
      label={t("sidebar.workspace.rename.title")}
      testID={`sidebar-workspace-rename-input-${workspace.serverId}:${workspace.workspaceId}`}
      onSubmit={submit}
      onClose={close}
      allowEmpty
    />
  );
}
