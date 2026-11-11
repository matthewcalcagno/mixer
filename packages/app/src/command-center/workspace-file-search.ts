import { useCallback, useEffect, useMemo, useState } from "react";
import { openWorkspaceFileFromExplorer } from "@/screens/workspace/workspace-file-open-command";
import { useActiveWorkspaceSelection } from "@/stores/navigation-active-workspace-store";
import { revealWorkspaceTab } from "@/workspace-tabs/navigation";
import { useSessionStore } from "@/stores/session-store";
import { useWorkspaceDirectory } from "@/stores/session-store-hooks";
import { collectAllTabs } from "@/stores/workspace-layout-actions";
import { useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import { clearCommandCenterFocusRestoreElement } from "@/utils/command-center-focus-restore";
import { buildWorkspaceTabPersistenceKey } from "@/workspace-tabs/model";
import {
  describeWorkspaceFilePath,
  type WorkspaceFileSearchEntry,
} from "./workspace-file-search-model";

interface DirectorySuggestionEntry {
  path: string;
}

const FILE_SEARCH_DEBOUNCE_MS = 100;
const FILE_SEARCH_LIMIT = 100;

interface WorkspaceFileSearchState {
  sourceKey: string | null;
  requestKey: string | null;
  entries: readonly WorkspaceFileSearchEntry[];
  loading: boolean;
  error: string | null;
}

const EMPTY_STATE: WorkspaceFileSearchState = {
  sourceKey: null,
  requestKey: null,
  entries: [],
  loading: false,
  error: null,
};

function errorMessage(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  if (error.name !== "DaemonRpcError") return error.message;
  return error.message.replace(/ requestType=\S+(?: code=\S+)?$/, "");
}

function describeFileEntries(
  entries: readonly DirectorySuggestionEntry[],
): WorkspaceFileSearchEntry[] {
  return entries.map(({ path }) => describeWorkspaceFilePath(path));
}

export function useWorkspaceFileSearch(input: {
  enabled: boolean;
  query: string;
  limit?: number;
}): {
  entries: readonly WorkspaceFileSearchEntry[];
  loading: boolean;
  error: string | null;
  openFile(path: string, lineStart?: number): void;
} {
  const selection = useActiveWorkspaceSelection();
  const serverId = selection?.serverId ?? null;
  const workspaceId = selection?.workspaceId ?? null;
  const cwd = useWorkspaceDirectory(serverId, workspaceId);
  const layoutKey =
    serverId && workspaceId ? buildWorkspaceTabPersistenceKey({ serverId, workspaceId }) : null;
  const layout = useWorkspaceLayoutStore((state) =>
    layoutKey ? state.layoutByWorkspace[layoutKey] : undefined,
  );
  const limit = input.limit ?? FILE_SEARCH_LIMIT;
  const blankQuery = !input.query.trim();
  const openFiles = useMemo(() => {
    if (!layout || !input.enabled || !blankQuery) return [];
    const tabs = collectAllTabs(layout.root).sort(
      (left, right) => right.createdAt - left.createdAt,
    );
    return [...new Set(tabs.flatMap(({ target }) => (target.kind === "file" ? [target.path] : [])))]
      .slice(0, limit)
      .map(describeWorkspaceFilePath);
  }, [blankQuery, input.enabled, layout, limit]);
  const client = useSessionStore((state) =>
    serverId ? (state.sessions[serverId]?.client ?? null) : null,
  );
  const [state, setState] = useState<WorkspaceFileSearchState>(EMPTY_STATE);
  const sourceKey = useMemo(
    () => (serverId && workspaceId && cwd && client ? `${serverId}\0${workspaceId}\0${cwd}` : null),
    [client, cwd, serverId, workspaceId],
  );
  const requestKey = useMemo(
    () => (input.enabled && sourceKey ? `${sourceKey}\0${input.query}` : null),
    [input.enabled, input.query, sourceKey],
  );

  useEffect(() => {
    if (!requestKey || !client || !cwd) {
      setState(EMPTY_STATE);
      return;
    }
    const activeClient = client;
    const activeCwd = cwd;

    let cancelled = false;
    setState((previous) => ({
      sourceKey,
      requestKey,
      entries: previous.sourceKey === sourceKey ? previous.entries : [],
      loading: true,
      error: null,
    }));
    async function search(): Promise<void> {
      try {
        const payload = await activeClient.getDirectorySuggestions({
          cwd: activeCwd,
          query: input.query,
          includeFiles: true,
          includeDirectories: false,
          limit,
        });
        if (cancelled) return;
        setState({
          sourceKey,
          requestKey,
          entries: payload.error ? [] : describeFileEntries(payload.entries),
          loading: false,
          error: payload.error ?? null,
        });
      } catch (error) {
        if (!cancelled) {
          setState({
            sourceKey,
            requestKey,
            entries: [],
            loading: false,
            error: errorMessage(error),
          });
        }
      }
    }

    const timer = setTimeout(() => void search(), input.query.trim() ? FILE_SEARCH_DEBOUNCE_MS : 0);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [client, cwd, input.query, limit, requestKey, sourceKey]);

  const openFile = useCallback(
    (path: string, lineStart?: number) => {
      if (!serverId || !workspaceId) return;
      clearCommandCenterFocusRestoreElement();
      openWorkspaceFileFromExplorer({
        filePath: path,
        lineStart,
        persistenceKey: buildWorkspaceTabPersistenceKey({ serverId, workspaceId }),
        openWorkspaceTabInFocusedPane: (workspaceKey, target, placement) =>
          useWorkspaceLayoutStore.getState().openTab({
            workspaceKey,
            target,
            intent: "reveal",
            placement,
          }),
        revealWorkspaceTab,
      });
    },
    [serverId, workspaceId],
  );

  const entries = useMemo(() => {
    const matches = requestKey && state.sourceKey === sourceKey ? state.entries : [];
    if (!openFiles.length) return matches;
    const paths = new Set(openFiles.map(({ path }) => path));
    return [...openFiles, ...matches.filter(({ path }) => !paths.has(path))].slice(0, limit);
  }, [limit, openFiles, requestKey, sourceKey, state.entries, state.sourceKey]);

  return {
    entries,
    loading: Boolean(requestKey) && (state.requestKey !== requestKey || state.loading),
    error: state.requestKey === requestKey ? state.error : null,
    openFile,
  };
}
