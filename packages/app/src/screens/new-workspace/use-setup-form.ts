import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { useShallow } from "zustand/react/shallow";
import { useTranslation } from "react-i18next";
import { useFetchQuery } from "@/data/query";
import { useQueryClient } from "@tanstack/react-query";
import {
  useHosts,
  useHostRuntimeConnectionStatuses,
  useHostRuntimeClient,
  getHostRuntimeStore,
} from "@/runtime/host-runtime";
import {
  useHostProjects,
  hostProjectFromRoute,
  hostProjectFromWorkspace,
} from "@/projects/host-projects";
import {
  useLastWorkspaceSelection,
  navigateToWorkspace,
} from "@/stores/navigation-active-workspace-store";
import { useWorkspace } from "@/stores/session-store-hooks";
import { normalizeWorkspaceDescriptor, useSessionStore } from "@/stores/session-store";
import { useFormPreferences } from "@/hooks/use-form-preferences";
import { useCheckoutStatusQuery } from "@/git/use-status-query";
import { generateDraftId } from "@/stores/draft-keys";
import { toErrorMessage } from "@/utils/error-messages";
import { inheritNewWorkspaceExplorer } from "./explorer-state";
import { useNewWorkspaceScreenPresence } from "./screen-presence";
import {
  WorkspaceSetupForm,
  type WorkspaceSetupSnapshot,
  type WorkspaceIsolation,
} from "./setup-form-model";

export interface WorkspaceSetupRoute {
  serverId: string;
  sourceDirectory?: string;
  projectId?: string;
  displayName?: string;
  draftId?: string;
}

function useSetupSnapshot(route: WorkspaceSetupRoute): WorkspaceSetupSnapshot {
  const hosts = useHosts();
  const serverIds = useMemo(() => hosts.map((host) => host.serverId), [hosts]);
  const projects = useHostProjects(serverIds);
  const connections = useHostRuntimeConnectionStatuses(serverIds);
  const infos = useSessionStore(
    useShallow((store) => hosts.map((host) => store.sessions[host.serverId]?.serverInfo)),
  );
  const last = useLastWorkspaceSelection();
  const workspace = useWorkspace(last?.serverId ?? null, last?.workspaceId ?? null);
  const { preferences } = useFormPreferences();
  return useMemo(
    () => ({
      hosts: hosts.map((host, index) => ({
        serverId: host.serverId,
        label: host.label,
        connected: connections.get(host.serverId) === "online",
        ready: Boolean(infos[index]),
        supportsLocal: infos[index]?.features?.workspaceMultiplicity === true,
      })),
      projects,
      initialServerId: route.serverId,
      routeProject: hostProjectFromRoute({
        serverId: route.serverId,
        projectId: route.projectId,
        displayName: route.displayName,
        sourceDirectory: route.sourceDirectory,
      }),
      lastProject: last ? hostProjectFromWorkspace({ serverId: last.serverId, workspace }) : null,
      isolation: preferences.isolation ?? "local",
    }),
    [
      hosts,
      infos,
      connections,
      projects,
      route.serverId,
      route.projectId,
      route.displayName,
      route.sourceDirectory,
      last,
      workspace,
      preferences.isolation,
    ],
  );
}

function useBranchSearch(serverId: string, directory: string | null, enabled: boolean) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search.trim()), 150);
    return () => clearTimeout(timer);
  }, [search]);
  const client = useHostRuntimeClient(serverId);
  const query = useFetchQuery({
    queryKey: ["workspace-setup-branches", serverId, directory, debouncedSearch],
    dataShape: "value",
    staleTimeMs: 15_000,
    enabled: open && enabled && Boolean(client),
    queryFn: async () => {
      if (!client || !directory) throw new Error(t("common.errors.daemonClientUnavailable"));
      return client.getBranchSuggestions({
        cwd: directory,
        query: debouncedSearch || undefined,
        limit: 50,
      });
    },
  });
  const names = useMemo(
    () => [
      ...new Set(
        query.data?.branchDetails?.map((branch) => branch.name) ?? query.data?.branches ?? [],
      ),
    ],
    [query.data],
  );
  return {
    open,
    setOpen,
    setSearch,
    search,
    names,
    loading: query.isFetching,
    error: query.error?.message ?? null,
  };
}

export function useWorkspaceSetupForm(route: WorkspaceSetupRoute) {
  const { t } = useTranslation();
  const queries = useQueryClient();
  const snapshot = useSetupSnapshot(route);
  const [model] = useState(
    () => new WorkspaceSetupForm(snapshot, route.draftId ?? generateDraftId()),
  );
  useEffect(() => {
    model.applySnapshot(snapshot);
  }, [model, snapshot]);
  useEffect(() => () => model.close(), [model]);
  const state = useSyncExternalStore(model.subscribe, model.getState, model.getState);
  const { updatePreferences } = useFormPreferences();
  const selectIsolation = useCallback(
    (value: WorkspaceIsolation) => {
      model.selectIsolation(value);
      void updatePreferences({ isolation: value });
    },
    [model, updatePreferences],
  );
  const branchSearch = useBranchSearch(state.serverId, state.directory, state.showBranch);
  const baseSearch = useBranchSearch(state.serverId, state.directory, state.showBaseBranch);
  const { setOpen: setBranchOpen } = branchSearch;
  const { setOpen: setBaseOpen } = baseSearch;
  const { status } = useCheckoutStatusQuery({
    serverId: state.serverId,
    cwd: state.directory ?? "",
  });
  useEffect(() => {
    model.applyCurrentBranch(state.scopeKey, status?.currentBranch ?? null);
  }, [model, state.scopeKey, status?.currentBranch]);
  useEffect(() => {
    model.applyDefaultBranch(state.scopeKey, status?.baseRef ?? null);
  }, [model, state.scopeKey, status?.baseRef]);
  // Typing owns the create row. The daemon remains the atomic name-conflict authority.
  const typedBranch = branchSearch.search.trim();
  const knownExistingBranch =
    branchSearch.names.includes(typedBranch) ||
    (state.branch?.kind === "existing" && state.branch.name === typedBranch);
  const newBranchName = knownExistingBranch ? "" : typedBranch;
  const newBranchOption = useMemo(
    () =>
      newBranchName
        ? {
            id: `new-branch:${newBranchName}`,
            label: t("newWorkspace.refPicker.newBranch", { name: newBranchName }),
          }
        : null,
    [newBranchName, t],
  );
  const branchOptions = useMemo(() => {
    const names = new Set(branchSearch.names);
    if (state.branch?.kind === "existing") names.add(state.branch.name);
    const options = [...names].map((name) => ({ id: name, label: name }));
    if (newBranchOption) options.unshift(newBranchOption);
    if (state.branch?.kind === "new" && !branchSearch.search.trim())
      options.unshift({ id: `new-branch:${state.branch.name}`, label: state.branch.display.label });
    return options;
  }, [branchSearch.names, branchSearch.search, state.branch, newBranchOption]);
  const baseBranch = state.branch?.kind === "new" ? state.branch.base : null;
  const baseOptions = useMemo(() => {
    const names = new Set(baseSearch.names);
    if (baseBranch && !baseSearch.search.trim()) names.add(baseBranch.name);
    return [...names].map((name) => ({ id: name, label: name }));
  }, [baseSearch.names, baseSearch.search, baseBranch]);
  const chooseBranch = useCallback(
    (id: string) => {
      if (state.branch?.kind === "new" && id === `new-branch:${state.branch.name}`) {
        setBranchOpen(false);
        return;
      }
      if (newBranchOption?.id === id)
        model.selectNewBranch(newBranchName, { label: newBranchOption.label });
      else model.selectBranch(id, { label: id });
      setBranchOpen(false);
      setBaseOpen(false);
    },
    [model, newBranchOption, newBranchName, setBranchOpen, setBaseOpen, state.branch],
  );
  const chooseBase = useCallback(
    (name: string) => {
      model.selectBaseBranch(name, { label: name });
      setBaseOpen(false);
    },
    [model, setBaseOpen],
  );
  const isActive = useNewWorkspaceScreenPresence();
  const submit = useCallback(async () => {
    const plan = model.beginSubmission();
    if (!plan) return;
    try {
      const connected = getHostRuntimeStore().getClient(plan.serverId);
      if (!connected?.isConnected) throw new Error(t("newWorkspace.errors.hostDisconnected"));
      const result = await connected.createWorkspace(plan.request);
      if (result.error || !result.workspace)
        throw new Error(result.error ?? t("newWorkspace.errors.createWorktreeFailed"));
      const workspace = normalizeWorkspaceDescriptor(result.workspace);
      inheritNewWorkspaceExplorer(plan.serverId, workspace.id);
      getHostRuntimeStore().acceptWorkspaceSnapshots(plan.serverId, [workspace]);
      if (isActive()) navigateToWorkspace({ serverId: plan.serverId, workspaceId: workspace.id });
      model.complete();
    } catch (error) {
      model.fail(toErrorMessage(error));
    } finally {
      void queries.invalidateQueries({ queryKey: ["workspace-setup-branches", plan.serverId] });
    }
  }, [model, isActive, t, queries]);
  return {
    state,
    model,
    selectIsolation,
    branchPicker: {
      ...branchSearch,
      options: branchOptions,
      choose: chooseBranch,
      value:
        state.branch?.kind === "new"
          ? `new-branch:${state.branch.name}`
          : (state.branch?.name ?? ""),
      display: state.branch?.display ?? null,
    },
    basePicker: {
      ...baseSearch,
      options: baseOptions,
      choose: chooseBase,
      value: baseBranch?.name ?? "",
      display: baseBranch?.display ?? null,
    },
    submit,
  };
}
