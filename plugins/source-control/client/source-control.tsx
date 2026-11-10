import { primaryRemoteAction } from "./primary-remote-action.js";
import type { PluginTheme } from "@mixer/plugin";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Platform, Pressable, Text, TextInput, View } from "react-native";
import {
  Icon,
  PaneHeader,
  PaneHeaderAction,
  ScrollView,
  trashFiles,
} from "@mixer/plugin/client/ui";
import { useIsMutating, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRpc, type PluginWorkspacePanelProps } from "@mixer/plugin/client";
import type { RpcInput, RpcOutput } from "@mixer/plugin";
import {
  actionRpc,
  GitActionError,
  autoFetchRpc,
  statusRpc,
  prepareTrashRpc,
  gitScopeKey,
  type GitScope,
} from "../shared/git.js";
import { optimisticStatus } from "../shared/optimistic.js";
import {
  CommitDropdown,
  commitOptions,
  IconButton,
  NativeActionSelector,
  type CommitOption,
  type NativeSelectorOption,
} from "./controls.js";
import { useDiffSelection, type DiffSelection } from "./diff-selection.js";
import { confirmAction, resizeCommitInput, commitMessagePlaceholder } from "./web.js";
import { z } from "zod";
import {
  resourceGroups,
  resourceTree,
  visibleResources,
  type ResourceGroup,
  type Resource,
} from "../shared/resources.js";
import { ResourceList } from "./resource-list.js";
import {
  actionResources,
  emptySelection,
  resourceKey,
  retainSelection,
  selectAllResources,
  selectResource,
  visibleResourceItems,
  type ResourceItem,
  type ResourceKeyAction,
  type ResourceOperation,
  type SelectionGesture,
} from "../shared/selection.js";

const EMPTY_FILES: Resource[] = [];

const preferences = z.object({
  message: z.string().default(""),
  view: z.enum(["list", "tree"]).default("list"),
  sort: z.enum(["path", "name", "status"]).default("path"),
});

type Action = RpcInput<typeof actionRpc>["action"];

function describeGitError(error: Error | null) {
  if (!error || (error instanceof GitActionError && error.conflict)) return null;
  const firstLine = error.message.split("\n")[0];
  const summary = /^(?:Request failed|Git exited|fatal:|error:)/i.test(firstLine)
    ? "Git operation failed."
    : firstLine;
  return { summary, details: error.message };
}

export function SourceControlPanel({
  scope,
  host,
  theme,
  tab,
  onOpenDiff,
  onOpenFile,
}: Pick<PluginWorkspacePanelProps, "theme" | "tab" | "host"> & {
  scope: GitScope;
  onOpenDiff(selection: DiffSelection): void;
  onOpenFile?: (path: string) => void;
}) {
  const workspaceId = gitScopeKey(scope);
  const readStatus = useRpc(statusRpc);
  const runAction = useRpc(actionRpc);
  const validateTrash = useRpc(prepareTrashRpc);
  const fetchRemote = useRpc(autoFetchRpc);
  const queries = useQueryClient();
  const [saved] = useState(() => {
    const result = preferences.safeParse(tab?.state ?? {});
    return result.success ? result.data : preferences.parse({});
  });
  const draftMessage = useRef(saved.message);
  const [messageResetVersion, setMessageResetVersion] = useState(0);
  const [view, setView] = useState(saved.view);
  const [sort, setSort] = useState(saved.sort);
  const [filter, setFilter] = useState("");
  const [filterVisible, setFilterVisible] = useState(false);
  const persist = useRef(tab?.setState);
  persist.current = tab?.setState;
  useEffect(() => {
    persist.current?.({ message: draftMessage.current, view, sort });
  }, [view, sort]);
  const saveMessage = useCallback(
    (value: string) => {
      draftMessage.current = value;
      persist.current?.({ message: value, view, sort });
    },
    [view, sort],
  );
  const selected = useDiffSelection(workspaceId);
  const [collapsed, setCollapsed] = useState<Record<ResourceGroup, boolean>>({
    merge: false,
    staged: false,
    changes: false,
  });
  const [selection, setSelection] = useState(emptySelection);
  const [collapsedFolders, setCollapsedFolders] = useState<ReadonlySet<string>>(() => new Set());
  const [commitFlowOption, setCommitFlowOption] = useState<CommitOption | null>(null);
  const commitFlowPending = commitFlowOption !== null;
  const [showErrorDetails, setShowErrorDetails] = useState(false);
  const [commitFlowError, setCommitFlowError] = useState<Error | null>(null);
  const key = ["source-control", workspaceId];
  const mutating = useIsMutating({ mutationKey: key }) > 0 || commitFlowPending;
  const state = useQuery({
    queryKey: key,
    queryFn: () => readStatus(scope),
    refetchInterval: 5000,
    enabled: !mutating,
  });
  useQuery({
    queryKey: ["source-control-remote", workspaceId],
    queryFn: async () => {
      const result = await fetchRemote(scope);
      if (!queries.isMutating({ mutationKey: key }))
        await queries.invalidateQueries({ queryKey: key });
      return result;
    },
    enabled: !!state.data?.hasRemote && !mutating,
    refetchInterval: 180_000,
    staleTime: 180_000,
  });
  const action = useMutation({
    mutationKey: key,
    onMutate: async (operation: Action & { expectedRevision?: string }) => {
      setCommitFlowError(null);
      setShowErrorDetails(false);
      await queries.cancelQueries({ queryKey: key });
      const previous = queries.getQueryData<RpcOutput<typeof statusRpc>>(key);
      if (previous) queries.setQueryData(key, optimisticStatus(previous, operation));
      return { previous };
    },
    mutationFn: (operation: Action & { expectedRevision?: string }) => {
      if (!state.data) throw new Error("Refresh the repository first");
      return runAction({
        ...scope,
        revision: operation.expectedRevision ?? state.data.revision,
        action: operation,
      }).then((result) => {
        if (result.error) throw new GitActionError(result.error.message, result.error.conflict);
        return result;
      });
    },
    onSuccess: (_result, operation) => {
      if (["commit", "amend", "continue", "abort"].includes(operation.kind)) {
        saveMessage("");
        setMessageResetVersion((version) => version + 1);
      }
    },
    onError: (_error, _operation, context) => {
      if (context?.previous) queries.setQueryData(key, context.previous);
    },
    onSettled: async () => {
      await queries.fetchQuery({
        queryKey: key,
        queryFn: () => readStatus(scope),
        staleTime: 0,
      });
      await queries.invalidateQueries({ queryKey: [...key, "editor-diff"] });
    },
  });
  const trash = useMutation({
    mutationFn: async (path: string) => {
      if (!state.data) throw new Error("Refresh the repository first");
      const accepted = await confirmAction(
        "Move untracked file to Trash?",
        `Delete '${path}'? You can restore this file from the Trash.`,
        "Move to Trash",
      );
      if (!accepted) return;
      const paths = await validateTrash({ ...scope, paths: [path], revision: state.data.revision });
      await trashFiles(host.id, paths);
    },
    onSettled: () => queries.invalidateQueries({ queryKey: key }),
  });
  const pending = action.isPending || commitFlowPending || trash.isPending;
  const pushing =
    action.isPending &&
    (action.variables.kind === "push" ||
      action.variables.kind === "publish" ||
      action.variables.kind === "pull" ||
      action.variables.kind === "sync");
  const primaryBusy =
    commitFlowPending ||
    pushing ||
    (action.isPending && ["continue", "abort"].includes(action.variables.kind));
  const c = theme.colors;
  const text = { color: c.foreground, fontSize: 13 };
  const files = state.data?.files ?? EMPTY_FILES;
  const groups = resourceGroups(files);
  const tracked = groups.changes.filter((file) => file.index !== "?");
  const untracked = groups.changes.filter((file) => file.index === "?");
  const staged = groups.staged;
  const sections = useMemo(() => {
    const grouped = resourceGroups(files);
    return (
      [
        { id: "merge", title: "Merge Changes", files: grouped.merge, staged: false },
        { id: "staged", title: "Staged Changes", files: grouped.staged, staged: true },
        { id: "changes", title: "Changes", files: grouped.changes, staged: false },
      ] satisfies { id: ResourceGroup; title: string; files: Resource[]; staged: boolean }[]
    )
      .filter((group) => group.files.length > 0 || (group.id === "changes" && files.length > 0))
      .map((group) => {
        const matching = visibleResources(group.files, filter, sort, group.staged);
        const nodes =
          view === "tree"
            ? resourceTree(matching)
            : matching.map((file) => ({ kind: "file" as const, file }));
        return {
          id: group.id,
          title: group.title,
          files: group.files,
          staged: group.staged,
          matching,
          nodes,
        };
      });
  }, [files, filter, sort, view]);
  const resources = useMemo(
    () => sections.flatMap((group) => group.matching.map((file) => ({ group: group.id, file }))),
    [sections],
  );
  const availableKeys = useMemo(
    () => new Set(resources.map((item) => resourceKey(item.group, item.file.path))),
    [resources],
  );
  const visibleOrder = useMemo(
    () =>
      sections.flatMap((group) =>
        collapsed[group.id]
          ? []
          : visibleResourceItems({ nodes: group.nodes, group: group.id, collapsedFolders }).map(
              (item) => resourceKey(item.group, item.file.path),
            ),
      ),
    [sections, collapsed, collapsedFolders],
  );
  const currentSelection = retainSelection(selection, availableKeys);
  useEffect(() => {
    if (!pending) setSelection((current) => retainSelection(current, availableKeys));
  }, [availableKeys, pending]);
  const stageSelection = actionResources({
    selection: currentSelection,
    resources,
    operation: "stage",
  });
  const unstageSelection = actionResources({
    selection: currentSelection,
    resources,
    operation: "unstage",
  });
  const discardSelection = actionResources({
    selection: currentSelection,
    resources,
    operation: "discard",
  });
  const actionCounts = useMemo(
    () => ({
      stage: stageSelection.length,
      unstage: unstageSelection.length,
      discard: discardSelection.length,
    }),
    [stageSelection.length, unstageSelection.length, discardSelection.length],
  );

  function openResource(group: ResourceGroup, file: Resource) {
    if ((file.index === "?" || group === "merge") && onOpenFile) {
      onOpenFile(file.path);
      return;
    }
    onOpenDiff({ path: file.path, staged: group === "staged" });
  }
  function selectFile(group: ResourceGroup, file: Resource, gesture: SelectionGesture) {
    const actual = gesture;
    setSelection((current) =>
      selectResource({
        selection: current,
        key: resourceKey(group, file.path),
        order: visibleOrder,
        gesture: actual,
      }),
    );
    if (actual === "replace") openResource(group, file);
  }
  function selectKey(group: ResourceGroup, file: Resource, input: ResourceKeyAction) {
    const entryKey = resourceKey(group, file.path);
    switch (input.kind) {
      case "all":
        setSelection((current) => selectAllResources(visibleOrder, current));
        break;
      case "clear":
        setSelection({ keys: new Set(), anchor: entryKey, focus: entryKey });
        break;
      case "toggle":
        selectFile(group, file, "toggle");
        break;
      case "open":
        openResource(group, file);
        break;
      case "navigate": {
        let index = visibleOrder.indexOf(entryKey);
        if (input.direction === "first") index = 0;
        else if (input.direction === "last") index = visibleOrder.length - 1;
        else index += input.direction === "next" ? 1 : -1;
        const target = visibleOrder[Math.max(0, Math.min(visibleOrder.length - 1, index))];
        if (!target) return;
        setSelection((current) => {
          if (input.additive && !input.extend) return { ...current, focus: target };
          let gesture: SelectionGesture = "replace";
          if (input.extend) gesture = input.additive ? "add-range" : "range";
          return selectResource({ selection: current, key: target, order: visibleOrder, gesture });
        });
        break;
      }
    }
  }
  function operateSelection(operation: ResourceOperation, context?: ResourceItem) {
    if (pending) return;
    const entries = actionResources({ selection: currentSelection, resources, operation, context });
    const paths = [...new Set(entries.map((entry) => entry.file.path))];
    if (!paths.length) return;
    if (operation === "discard") void confirm({ kind: operation, paths });
    else action.mutate({ kind: operation, paths });
  }
  const hasConflicts = groups.merge.length > 0;
  const gitOperation = state.data?.operation;
  const operationLabel = gitOperation
    ? { merge: "Merge", rebase: "Rebase", "cherry-pick": "Cherry-Pick", revert: "Revert" }[
        gitOperation.kind
      ]
    : "";
  const canCommit =
    (staged.length > 0 || !!gitOperation) && !hasConflicts && !pending && !state.isPending;
  const canAmend = !gitOperation && !hasConflicts && !pending && !!state.data;
  const remoteAction = primaryRemoteAction({ status: state.data, commitFlowPending, pushing });
  let primaryLabel = gitOperation ? "Continue" : (remoteAction?.label ?? "Commit");
  if (commitFlowOption)
    primaryLabel = commitOptions.find((option) => option.value === commitFlowOption)!.label;
  const gitError = describeGitError(state.error || commitFlowError || action.error || trash.error);
  async function commit(message: string, option: CommitOption) {
    if (!message.trim() || !(option === "amend" ? canAmend : canCommit) || !state.data) return;
    const snapshot = state.data;
    if (snapshot.operation) {
      try {
        await action.mutateAsync({
          kind: "continue",
          message,
          expectedRevision: snapshot.revision,
        });
      } catch (error) {
        setCommitFlowError(error instanceof Error ? error : new Error("Unable to continue."));
      }
      return;
    }
    const hasRemoteStep = option === "commit-push" || option === "commit-sync";
    if (hasRemoteStep && (!snapshot.hasRemote || !snapshot.upstream)) return;
    setCommitFlowOption(option);
    setCommitFlowError(null);
    try {
      if (option === "amend" || option === "commit-sync") {
        const descriptions = {
          amend:
            "Replace the latest commit with the staged changes and this message? This rewrites the latest commit.",
          "commit-sync":
            "Commit staged changes, pull remote changes using the repository’s merge or rebase settings, then push? Conflicts stop the sync before pushing.",
        };
        const description = descriptions[option];
        if (
          !(await confirmAction(
            "Commit options",
            description,
            option === "amend" ? "Amend" : "Continue",
          ))
        )
          return;
      }
      await action.mutateAsync({
        kind: option === "amend" ? "amend" : "commit",
        message,
        expectedRevision: snapshot.revision,
      });
      if (hasRemoteStep) {
        const current = await readStatus(scope);
        await action.mutateAsync({
          kind: option === "commit-sync" ? "sync" : "push",
          expectedRevision: current.revision,
        });
      }
    } catch (error) {
      setCommitFlowError(error instanceof Error ? error : new Error("Commit action failed"));
    } finally {
      setCommitFlowOption(null);
    }
  }
  async function confirm(operation: Action) {
    if (!state.data) return;
    const request = { ...operation, expectedRevision: state.data.revision };
    const discard =
      operation.kind === "discard" || (operation.kind === "patch" && operation.discard);
    let title = discard ? "Discard changes?" : `Run ${operation.kind}?`;
    let description = discard
      ? `Permanently discard ${operation.kind === "discard" ? operation.paths.length : 1} tracked file(s)? This cannot be undone. Untracked files are preserved.`
      : `Run ${operation.kind} on ${state.data.branch}?`;
    if (
      operation.kind === "stage" &&
      operation.paths.some((path) => groups.merge.some((file) => file.path === path))
    ) {
      title = "Mark merge files resolved?";
      description = `Stage ${operation.paths.length} selected file(s)? Staging merge files marks their conflicts resolved. Review their contents first.`;
    }
    const accepted = await confirmAction(title, description, discard ? "Discard" : "Confirm");
    if (accepted) action.mutate(request);
  }
  function toolbar(icon: string, label: string, onPress: () => void, disabled = false) {
    return (
      <IconButton
        icon={icon}
        label={label}
        onPress={onPress}
        disabled={disabled || pending || !state.data}
        theme={theme}
      />
    );
  }
  const remoteActionsDisabled = !state.data?.hasRemote || !!gitOperation;
  const actionOptions: NativeSelectorOption[] = [
    ...(gitOperation ? [{ value: "abort", label: `Abort ${operationLabel}…` }] : []),
    { value: "fetch", label: "Fetch", disabled: remoteActionsDisabled },
    { value: "pull", label: "Pull (fast-forward only)", disabled: remoteActionsDisabled },
    { value: "push", label: "Push", disabled: remoteActionsDisabled },
    { value: "sync", label: "Sync Changes", disabled: remoteActionsDisabled },
    ...(["path", "name", "status"] as const).map((value) => ({
      value: `sort-${value}`,
      label: `Sort by ${value}${sort === value ? " ✓" : ""}`,
    })),
    {
      value: "stage-all",
      label: "Stage all changes",
      disabled: groups.changes.length === 0,
    },
    { value: "unstage-all", label: "Unstage all changes", disabled: staged.length === 0 },
    {
      value: "stage-tracked",
      label: "Stage all tracked changes",
      disabled: tracked.length === 0,
    },
    {
      value: "stage-untracked",
      label: "Stage all untracked changes",
      disabled: untracked.length === 0,
    },
    {
      value: "discard-tracked",
      label: "Discard all tracked changes…",
      disabled: tracked.length === 0,
    },
  ];
  function selectAction(value: string) {
    switch (value) {
      case "abort":
        void (async () => {
          if (
            await confirmAction(
              `Abort ${operationLabel}?`,
              "Discard the conflict resolutions for this operation?",
              "Abort",
            )
          )
            action.mutate({ kind: "abort" });
        })();
        break;
      case "stage-all":
        action.mutate({
          kind: "stage",
          paths: groups.changes.map((file) => file.path),
        });
        break;
      case "unstage-all":
        action.mutate({ kind: "unstage", paths: staged.map((file) => file.path) });
        break;
      case "fetch":
        action.mutate({ kind: "fetch" });
        break;
      case "push":
        action.mutate({ kind: "push" });
        break;
      case "pull":
      case "sync":
        void confirm({ kind: value });
        break;
      case "sort-path":
        setSort("path");
        break;
      case "sort-name":
        setSort("name");
        break;
      case "sort-status":
        setSort("status");
        break;
      case "stage-tracked":
        action.mutate({ kind: "stage", paths: tracked.map((file) => file.path) });
        break;
      case "stage-untracked":
        action.mutate({ kind: "stage", paths: untracked.map((file) => file.path) });
        break;
      case "discard-tracked":
        void confirm({ kind: "discard", paths: tracked.map((file) => file.path) });
        break;
    }
  }
  return (
    <View testID="source-control-panel" style={{ flex: 1 }}>
      <PaneHeader
        title="Source Control"
        testID="source-control-pane-header"
        titleTestID="source-control-pane-title"
      >
        {gitOperation && (
          <PaneHeaderAction
            icon="X"
            label={`Abort ${operationLabel}`}
            testID="source-control-abort"
            disabled={pending}
            onPress={() => selectAction("abort")}
          />
        )}
        <PaneHeaderAction
          icon="Filter"
          label="Filter changes"
          testID="source-control-filter"
          selected={filterVisible}
          onPress={() => {
            setFilterVisible(!filterVisible);
            setFilter("");
          }}
        />
        <PaneHeaderAction
          icon={view === "list" ? "ListTree" : "List"}
          label={view === "list" ? "View as Tree" : "View as List"}
          testID="source-control-view"
          onPress={() => setView(view === "list" ? "tree" : "list")}
        />
        <PaneHeaderAction
          icon="RotateCw"
          label="Refresh"
          testID="source-control-refresh"
          disabled={pending}
          onPress={() => {
            void queries.invalidateQueries({ queryKey: key });
          }}
        />
        <NativeActionSelector
          label="Source Control actions"
          disabled={pending || !state.data}
          color={c.foregroundMuted}
          options={actionOptions}
          onSelect={selectAction}
        />
      </PaneHeader>
      {filterVisible && (
        <View
          style={{
            paddingHorizontal: 10,
            paddingBottom: 6,
            flexDirection: "row",
            alignItems: "center",
            gap: 4,
          }}
        >
          <TextInput
            accessibilityLabel="Filter changed files"
            placeholder="Filter by file name or path"
            placeholderTextColor={c.foregroundMuted}
            value={filter}
            onChangeText={setFilter}
            style={{
              ...text,
              flex: 1,
              borderWidth: 1,
              borderColor: c.border,
              borderRadius: 3,
              paddingHorizontal: 6,
              paddingVertical: 4,
              backgroundColor: c.surface1,
            }}
          />
          <IconButton icon="X" label="Clear filter" theme={theme} onPress={() => setFilter("")} />
        </View>
      )}
      <ScrollView contentContainerStyle={{ paddingBottom: 8 }}>
        <CommitForm
          theme={theme}
          branch={state.data?.branch ?? ""}
          initialMessage={saved.message}
          resetVersion={messageResetVersion}
          commitAllowed={canCommit}
          amendAllowed={canAmend}
          disabled={pending || !state.data}
          remoteDisabled={!state.data?.hasRemote || !state.data.upstream}
          operation={gitOperation}
          showRemoteAction={remoteAction !== null}
          remoteIcon={remoteAction?.icon ?? "ArrowUp"}
          remoteAccessibilityLabel={remoteAction?.accessibilityLabel ?? ""}
          remoteEnabled={!pending}
          primaryBusy={primaryBusy}
          primaryLabel={primaryLabel}
          onMessage={saveMessage}
          onCommit={commit}
          onRemoteAction={() => {
            if (remoteAction) action.mutate({ kind: remoteAction.kind });
          }}
        />
        {gitError && (
          <View style={{ marginHorizontal: 10, marginBottom: 8, gap: 4 }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
              <Icon name="AlertCircle" size={14} color={c.statusDanger} />
              <Text
                accessibilityRole="alert"
                numberOfLines={2}
                style={{ ...text, flex: 1, color: c.statusDanger }}
              >
                {gitError.summary}
              </Text>
              <IconButton
                icon="Info"
                label={showErrorDetails ? "Hide Git error details" : "Show Git error details"}
                theme={theme}
                onPress={() => setShowErrorDetails(!showErrorDetails)}
              />
              <IconButton
                icon="X"
                label="Dismiss Git error"
                theme={theme}
                onPress={() => {
                  action.reset();
                  trash.reset();
                  setCommitFlowError(null);
                  if (state.error) void state.refetch();
                }}
              />
            </View>
            {showErrorDetails && (
              <Text selectable style={{ ...text, color: c.foregroundMuted }}>
                {gitError.details}
              </Text>
            )}
          </View>
        )}
        {sections.map((group) => (
          <View key={group.id} style={{ marginBottom: 4 }}>
            <View
              style={{
                flexDirection: "row",
                alignItems: "center",
                paddingHorizontal: 4,
                minHeight: 26,
                gap: 3,
                zIndex: 10,
              }}
            >
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`${collapsed[group.id] ? "Expand" : "Collapse"} ${group.title}`}
                accessibilityState={{ expanded: !collapsed[group.id] }}
                onPress={() => setCollapsed({ ...collapsed, [group.id]: !collapsed[group.id] })}
                style={{
                  flex: 1,
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 4,
                  minHeight: 26,
                }}
              >
                <Icon
                  name={collapsed[group.id] ? "ChevronRight" : "ChevronDown"}
                  size={16}
                  color={c.foregroundMuted}
                />
                <Text numberOfLines={1} style={{ ...text, fontWeight: "600", flexShrink: 1 }}>
                  {group.title}
                </Text>
              </Pressable>
              {group.id === "changes" &&
                toolbar(
                  "Undo2",
                  "Discard all changes",
                  () => {
                    void confirm({ kind: "discard", paths: tracked.map((file) => file.path) });
                  },
                  tracked.length === 0,
                )}
              {group.id !== "merge" &&
                toolbar(
                  group.staged ? "Minus" : "Plus",
                  group.staged ? "Unstage all changes" : "Stage all changes",
                  () =>
                    action.mutate({
                      kind: group.staged ? "unstage" : "stage",
                      paths: group.files.map((file) => file.path),
                    }),
                  group.files.length === 0,
                )}
              <View
                style={{
                  minWidth: 20,
                  height: 20,
                  borderRadius: 10,
                  backgroundColor: c.surface2,
                  justifyContent: "center",
                  alignItems: "center",
                  paddingHorizontal: 5,
                  marginRight: 4,
                }}
              >
                <Text style={{ color: c.foreground, fontSize: 11, fontWeight: "600" }}>
                  {group.files.length}
                </Text>
              </View>
            </View>
            {!collapsed[group.id] && (
              <ResourceList
                nodes={group.nodes}
                group={group.id}
                actionCounts={actionCounts}
                selection={currentSelection}
                collapsedFolders={collapsedFolders}
                onToggleFolder={(path) =>
                  setCollapsedFolders((current) => {
                    const next = new Set(current);
                    const folderKey = resourceKey(group.id, path);
                    if (next.has(folderKey)) next.delete(folderKey);
                    else next.add(folderKey);
                    return next;
                  })
                }
                staged={group.staged}
                merge={group.id === "merge"}
                filtered={!!filter.trim()}
                active={selected}
                disabled={pending}
                theme={theme}
                onSelect={(file, gesture) => selectFile(group.id, file, gesture)}
                onContextFile={(file) =>
                  setSelection((current) => {
                    const contextKey = resourceKey(group.id, file.path);
                    if (current.keys.has(contextKey)) return { ...current, focus: contextKey };
                    return selectResource({
                      selection: current,
                      key: contextKey,
                      order: visibleOrder,
                      gesture: "replace",
                    });
                  })
                }
                onKeyAction={(file, input) => selectKey(group.id, file, input)}
                onOpenFile={onOpenFile}
                onFocusFile={(file) =>
                  setSelection((current) => {
                    const focusedKey = resourceKey(group.id, file.path);
                    if (current.focus === focusedKey) return current;
                    return { ...current, focus: focusedKey, anchor: current.anchor ?? focusedKey };
                  })
                }
                onStageFile={(file) =>
                  operateSelection(group.staged ? "unstage" : "stage", { group: group.id, file })
                }
                onStageFolder={(paths) => {
                  if (group.id === "merge") void confirm({ kind: "stage", paths });
                  else action.mutate({ kind: group.staged ? "unstage" : "stage", paths });
                }}
                onDiscard={(file) => {
                  if (file.index === "?") trash.mutate(file.path);
                  else operateSelection("discard", { group: group.id, file });
                }}
              />
            )}
          </View>
        ))}
        {!!filter &&
          files.length > 0 &&
          visibleResources(files, filter, sort, false).length === 0 && (
            <Text style={{ color: c.foregroundMuted, fontSize: 12, padding: 16 }}>
              No matching changes.
            </Text>
          )}
      </ScrollView>
    </View>
  );
}

interface CommitFormProps {
  branch: string;
  theme: PluginTheme;
  initialMessage: string;
  resetVersion: number;
  commitAllowed: boolean;
  amendAllowed: boolean;
  disabled: boolean;
  remoteDisabled: boolean;
  operation: RpcOutput<typeof statusRpc>["operation"];
  showRemoteAction: boolean;
  remoteIcon: "ArrowDown" | "ArrowUp" | "RefreshCw";
  remoteAccessibilityLabel: string;
  remoteEnabled: boolean;
  primaryBusy: boolean;
  primaryLabel: string;
  onMessage(message: string): void;
  onCommit(message: string, option: CommitOption): Promise<void>;
  onRemoteAction(): void;
}

// Keep keystrokes and input measurement out of the repository resource tree.
function CommitForm({
  branch,
  theme,
  initialMessage,
  resetVersion,
  commitAllowed,
  amendAllowed,
  disabled,
  remoteDisabled,
  operation,
  showRemoteAction,
  remoteIcon,
  remoteAccessibilityLabel,
  remoteEnabled,
  primaryBusy,
  primaryLabel,
  onMessage,
  onCommit,
  onRemoteAction,
}: CommitFormProps) {
  const [message, setMessage] = useState(initialMessage);
  const [messageHeight, setMessageHeight] = useState(28);
  const [inputFocused, setInputFocused] = useState(false);
  const messageInput = useRef<TextInput>(null);
  const resizeMessage = useCallback(() => {
    const height = resizeCommitInput(messageInput.current);
    if (height !== null) setMessageHeight(height);
  }, []);
  useLayoutEffect(resizeMessage, [message, resizeMessage]);
  useEffect(() => {
    if (resetVersion > 0) setMessage("");
  }, [resetVersion]);
  useEffect(() => {
    const timer = setTimeout(() => onMessage(message), 300);
    return () => clearTimeout(timer);
  }, [message, onMessage]);
  const latestDraft = useRef({ message, onMessage });
  latestDraft.current = { message, onMessage };
  useEffect(
    () => () => {
      latestDraft.current.onMessage(latestDraft.current.message);
    },
    [],
  );
  const previousTemplate = useRef({ id: "", message: "" });
  useEffect(() => {
    const id = operation?.id ?? "";
    if (previousTemplate.current.id === id) return;
    const previous = previousTemplate.current.message;
    previousTemplate.current = { id, message: operation?.message ?? "" };
    if (operation)
      setMessage((current) =>
        !current.trim() || current === previous ? operation.message : current,
      );
  }, [operation]);
  const canCommit = !!message.trim() && commitAllowed;
  const canAmend = !!message.trim() && amendAllowed;
  const primaryEnabled = showRemoteAction ? remoteEnabled : canCommit;
  const remoteLabel = primaryLabel === "Publish branch" ? primaryLabel : remoteAccessibilityLabel;
  let primaryAccessibilityLabel = primaryBusy ? primaryLabel : "Commit staged changes";
  if (operation)
    primaryAccessibilityLabel = `Continue ${{ merge: "Merge", rebase: "Rebase", "cherry-pick": "Cherry-Pick", revert: "Revert" }[operation.kind]}`;
  const c = theme.colors;
  const text = { color: c.foreground, fontSize: 13 };
  return (
    <View style={{ paddingHorizontal: 10, paddingTop: 2, paddingBottom: 6, gap: 10 }}>
      <View>
        <TextInput
          ref={messageInput}
          accessibilityLabel="Commit message"
          testID="source-control-commit-message"
          multiline
          numberOfLines={1}
          value={message}
          onChangeText={setMessage}
          onKeyPress={(event) => {
            const native = event.nativeEvent;
            const control = "ctrlKey" in native && native.ctrlKey === true;
            const meta = "metaKey" in native && native.metaKey === true;
            if (native.key === "Enter" && (control || meta)) {
              event.preventDefault();
              void onCommit(message, "commit");
            }
          }}
          onLayout={resizeMessage}
          onFocus={() => setInputFocused(true)}
          onBlur={() => setInputFocused(false)}
          onContentSizeChange={(event) => {
            if (Platform.OS !== "web")
              setMessageHeight(Math.min(140, Math.max(28, event.nativeEvent.contentSize.height)));
          }}
          style={{
            ...text,
            fontSize: 12,
            lineHeight: 16,
            height: messageHeight,
            borderWidth: 0,
            borderRadius: 4,
            backgroundColor: c.surface2,
            paddingHorizontal: 8,
            paddingVertical: 6,
            textAlignVertical: "top",
            outlineStyle: "solid",
            outlineColor: c.inputFocus,
            outlineWidth: inputFocused ? 2 : 0,
            outlineOffset: -2,
          }}
        />
        {!message && (
          <View pointerEvents="none" style={{ position: "absolute", top: 6, left: 8, right: 8 }}>
            <Text
              numberOfLines={1}
              ellipsizeMode="tail"
              style={{ color: c.foregroundMuted, fontSize: 12, lineHeight: 16 }}
              testID="source-control-commit-placeholder"
            >
              {commitMessagePlaceholder(branch)}
            </Text>
          </View>
        )}
      </View>
      <View
        style={{
          flexDirection: "row",
          minHeight: 26,
          borderRadius: 4,
          overflow: "hidden",
          backgroundColor: "#187a34",
          opacity: primaryEnabled ? 1 : 0.5,
        }}
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={showRemoteAction ? remoteLabel : primaryAccessibilityLabel}
          accessibilityState={{ disabled: !primaryEnabled, busy: primaryBusy }}
          aria-busy={primaryBusy || undefined}
          disabled={!primaryEnabled}
          onPress={() => {
            if (showRemoteAction) onRemoteAction();
            else void onCommit(message, "commit");
          }}
          style={({ pressed }) => ({
            flex: 1,
            minHeight: 26,
            backgroundColor: "#187a34",
            opacity: pressed ? 0.85 : 1,
            flexDirection: "row",
            gap: 6,
            alignItems: "center",
            justifyContent: "center",
            paddingHorizontal: 8,
          })}
        >
          {primaryBusy ? (
            <ActivityIndicator size="small" color="#ffffff" />
          ) : (
            <Icon name={showRemoteAction ? remoteIcon : "Check"} size={16} color="#ffffff" />
          )}
          <Text
            numberOfLines={1}
            style={{
              color: "#ffffff",
              fontSize: 13,
              fontWeight: "600",
            }}
          >
            {primaryLabel}
          </Text>
        </Pressable>
        {!showRemoteAction && !operation && (
          <CommitDropdown
            disabled={disabled}
            canCommit={canCommit}
            canAmend={canAmend}
            remoteDisabled={remoteDisabled}
            color="#ffffff"
            onSelect={(option) => {
              void onCommit(message, option);
            }}
          />
        )}
      </View>
    </View>
  );
}
