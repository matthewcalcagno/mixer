import { useCallback, useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import {
  useSessionStore,
  type AgentFileExplorerState,
  type ExplorerDirectory,
} from "@/stores/session-store";
import { usePanelStore } from "@/stores/panel-store";
import { revealExplorerDirectory } from "@/file-explorer/tree";
import { parentExplorerPath } from "@/utils/explorer-paths";
import { renameWithReview } from "@/file-panels/source/editor/explorer-refactoring";

function createExplorerState(): AgentFileExplorerState {
  return {
    directories: new Map(),
    requests: new Map(),
    selectedEntryPath: null,
  };
}

export interface FileExplorerWorkspaceScope {
  workspaceId?: string | null;
  workspaceRoot?: string | null;
}

function normalizeWorkspaceValue(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function buildWorkspaceExplorerStateKey(scope: FileExplorerWorkspaceScope): string | null {
  const normalizedWorkspaceId = normalizeWorkspaceValue(scope.workspaceId);
  if (normalizedWorkspaceId) {
    return `workspace:${normalizedWorkspaceId}`;
  }
  const normalizedWorkspaceRoot = normalizeWorkspaceValue(scope.workspaceRoot);
  if (!normalizedWorkspaceRoot) {
    return null;
  }
  return `root:${normalizedWorkspaceRoot}`;
}

export function useFileExplorerActions(params: { serverId: string } & FileExplorerWorkspaceScope) {
  const queryClient = useQueryClient();
  const { t } = useTranslation();
  const { serverId, workspaceId, workspaceRoot } = params;
  const client = useSessionStore((state) => state.sessions[serverId]?.client ?? null);
  const setFileExplorer = useSessionStore((state) => state.setFileExplorer);
  const normalizedWorkspaceRoot = useMemo(
    () => normalizeWorkspaceValue(workspaceRoot),
    [workspaceRoot],
  );
  const workspaceStateKey = useMemo(
    () =>
      buildWorkspaceExplorerStateKey({
        workspaceId,
        workspaceRoot: normalizedWorkspaceRoot,
      }),
    [workspaceId, normalizedWorkspaceRoot],
  );

  const updateExplorerState = useCallback(
    (updater: (prev: AgentFileExplorerState) => AgentFileExplorerState) => {
      if (!workspaceStateKey) {
        return;
      }
      setFileExplorer(serverId, (prev) => {
        const next = new Map(prev);
        const current = next.get(workspaceStateKey) ?? createExplorerState();
        next.set(workspaceStateKey, updater(current));
        return next;
      });
    },
    [serverId, setFileExplorer, workspaceStateKey],
  );

  const requestDirectoryListing = useCallback(
    async function readDirectory(
      path: string,
      options?: { preferCache?: boolean },
    ): Promise<ExplorerDirectory | null> {
      if (!workspaceStateKey) {
        return null;
      }
      const normalizedPath = path && path.length > 0 ? path : ".";
      const queryKey = ["fileExplorerDirectory", serverId, normalizedWorkspaceRoot, normalizedPath];
      const cached = useSessionStore
        .getState()
        .sessions[serverId]?.fileExplorer.get(workspaceStateKey)
        ?.directories.get(normalizedPath);
      if (options?.preferCache && cached) {
        const query = queryClient.getQueryState(queryKey);
        const stale = !query || Date.now() - query.dataUpdatedAt > 30_000;
        if (stale && query?.fetchStatus !== "fetching") void readDirectory(normalizedPath);
        return cached;
      }
      updateExplorerState((state) => {
        const requests = new Map(state.requests).set(normalizedPath, { status: "loading" });
        return { ...state, requests };
      });
      try {
        if (!normalizedWorkspaceRoot)
          throw new Error(t("workspace.fileExplorer.states.unavailable"));
        if (!client) throw new Error(t("workspace.terminal.hostDisconnected"));
        const directory = await queryClient.fetchQuery({
          queryKey,
          queryFn: () => client.listDirectory(normalizedWorkspaceRoot, normalizedPath),
          staleTime: 0,
          retry: false,
        });
        updateExplorerState((state) => {
          const requests = new Map(state.requests);
          requests.delete(normalizedPath);
          let directories = state.directories;
          if (directories.get(directory.path) !== directory) {
            directories = new Map(directories).set(directory.path, directory);
          }
          return { ...state, requests, directories };
        });
        return directory;
      } catch (error) {
        updateExplorerState((state) => {
          const message =
            error instanceof Error
              ? error.message
              : t("workspace.fileExplorer.errors.failedToListDirectory");
          const requests = new Map(state.requests).set(normalizedPath, {
            status: "error",
            message,
          });
          return { ...state, requests };
        });
        return null;
      }
    },
    [
      client,
      normalizedWorkspaceRoot,
      t,
      updateExplorerState,
      workspaceStateKey,
      serverId,
      queryClient,
    ],
  );

  const revealDirectory = useCallback(
    async (directoryPath: string) => {
      if (!workspaceStateKey) return;
      await revealExplorerDirectory({
        directoryPath,
        requestDirectoryListing: (path) => requestDirectoryListing(path, { preferCache: true }),
        showHiddenFiles: () => {
          const panel = usePanelStore.getState();
          if (!panel.explorerShowHiddenFiles) panel.toggleExplorerShowHiddenFiles();
        },
        expandPaths: (paths) =>
          usePanelStore
            .getState()
            .setExpandedPathsForWorkspace(workspaceStateKey, (current) =>
              Array.from(new Set([...current, ...paths])),
            ),
      });
    },
    [requestDirectoryListing, workspaceStateKey],
  );

  const requestFileDownloadToken = useCallback(
    async (path: string) => {
      if (!normalizedWorkspaceRoot) {
        throw new Error(t("workspace.fileExplorer.states.unavailable"));
      }
      if (!client) {
        throw new Error(t("workspace.terminal.hostDisconnected"));
      }
      const payload = await client.requestDownloadToken(normalizedWorkspaceRoot, path);
      if (payload.error) {
        throw new Error(payload.error);
      }
      return payload;
    },
    [client, normalizedWorkspaceRoot, t],
  );

  const requestFileBytes = useCallback(
    async (path: string, maxBytes: number) => {
      if (!normalizedWorkspaceRoot) {
        throw new Error(t("workspace.fileExplorer.states.unavailable"));
      }
      if (!client) {
        throw new Error(t("workspace.terminal.hostDisconnected"));
      }
      // No request timeout: a large file over a slow relay legitimately takes longer than the
      // 60 s default, and a dead connection still rejects on disconnect.
      return client.readFile(normalizedWorkspaceRoot, path, undefined, maxBytes, 0);
    },
    [client, normalizedWorkspaceRoot, t],
  );

  const createEntry = useCallback(
    async (input: { parentPath: string; name: string; kind: "file" | "directory" }) => {
      if (!client || !normalizedWorkspaceRoot) {
        return null;
      }
      const payload = await client.createFileEntry({
        cwd: normalizedWorkspaceRoot,
        ...input,
      });
      if (payload.success) {
        await requestDirectoryListing(input.parentPath);
      }
      return payload;
    },
    [client, normalizedWorkspaceRoot, requestDirectoryListing],
  );

  const renameEntry = useCallback(
    async (input: { path: string; name: string; kind: "file" | "directory" }) => {
      if (!client || !normalizedWorkspaceRoot) {
        return null;
      }
      const reviewed = await renameWithReview({
        ...input,
        serverId,
        workspaceId,
        root: normalizedWorkspaceRoot,
      });
      if (reviewed !== undefined) {
        if (reviewed) await requestDirectoryListing(parentExplorerPath(input.path));
        return reviewed;
      }
      const payload = await client.renameFileEntry({
        cwd: normalizedWorkspaceRoot,
        ...input,
      });
      if (payload.success) {
        await requestDirectoryListing(parentExplorerPath(input.path));
      }
      return payload;
    },
    [client, normalizedWorkspaceRoot, requestDirectoryListing, serverId, workspaceId],
  );

  const duplicateEntry = useCallback(
    async (path: string) => {
      if (!client || !normalizedWorkspaceRoot) {
        return null;
      }
      const payload = await client.duplicateFileEntry({ cwd: normalizedWorkspaceRoot, path });
      if (payload.success) {
        await requestDirectoryListing(parentExplorerPath(path));
      }
      return payload;
    },
    [client, normalizedWorkspaceRoot, requestDirectoryListing],
  );

  const deleteEntry = useCallback(
    async (path: string) => {
      if (!client || !normalizedWorkspaceRoot) {
        return null;
      }
      const payload = await client.deleteFileEntry({ cwd: normalizedWorkspaceRoot, path });
      if (payload.success) {
        await requestDirectoryListing(parentExplorerPath(path));
      }
      return payload;
    },
    [client, normalizedWorkspaceRoot, requestDirectoryListing],
  );

  const selectExplorerEntry = useCallback(
    (path: string | null) => {
      updateExplorerState((state) => ({
        ...state,
        selectedEntryPath: path,
      }));
    },
    [updateExplorerState],
  );

  return {
    workspaceStateKey,
    revealDirectory,
    requestDirectoryListing,
    requestFileDownloadToken,
    requestFileBytes,
    createEntry,
    renameEntry,
    duplicateEntry,
    deleteEntry,
    selectExplorerEntry,
  };
}
