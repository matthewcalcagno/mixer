import { useGitDecorations } from "@/file-explorer/use-git-decorations";
import type { GitDecoration } from "@/file-explorer/git-decorations";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  memo,
  type ReactElement,
  type ReactNode,
  type RefObject,
} from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import {
  FlatList,
  ListRenderItemInfo,
  Pressable,
  Text,
  View,
  type NativeSyntheticEvent,
  type PressableStateCallbackType,
  type TextInputKeyPressEventData,
} from "react-native";
import { EditingTextInput as TextInput } from "@/components/ui/text-input";
import { StyleSheet, useUnistyles, withUnistyles } from "react-native-unistyles";
import { useIsCompactFormFactor } from "@/constants/layout";
import { isWeb } from "@/constants/platform";
import * as Clipboard from "expo-clipboard";
import { Eye, EyeOff, FilePlus, FolderPlus, RotateCw } from "lucide-react-native";
import { MaterialFileIcon, MaterialFolderIcon } from "@/components/material-file-icon";
import {
  TreeChevron,
  workspaceTreeRowStyles,
  WORKSPACE_TREE_ICON_LABEL_GAP,
  WORKSPACE_TREE_ICON_SIZE,
  WORKSPACE_TREE_LOADING_ICON_SIZE,
} from "@/components/tree-primitives";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import {
  PaneHeader,
  paneContentToolbarIconSize,
  ToolbarButton,
} from "@/components/ui/pane-content-toolbar";
import {
  useOverlayFlatListScrollbar,
  type OverlayFlatListScrollbar,
} from "@/components/ui/overlay-scrollbar/use-overlay-flat-list-scrollbar";
import type { Theme } from "@/styles/theme";
import type {
  AgentFileExplorerState,
  ExplorerEntry,
  ExplorerDirectoryRequestState,
} from "@/stores/session-store";
import { useSessionStore } from "@/stores/session-store";
import { FileActionsContextMenuContent } from "@/components/file-actions-menu";
import { ContextMenu, ContextMenuTrigger, useContextMenu } from "@/components/ui/context-menu";
import { useFileDownload } from "@/hooks/use-file-download";
import { useFileExplorerActions } from "@/hooks/use-file-explorer-actions";
import { useIsLocalDaemon } from "@/hooks/use-is-local-daemon";
import { buildWorkspaceExplorerStateKey } from "@/hooks/use-file-explorer-actions";
import { usePanelStore, type ExpandedPathsUpdate } from "@/stores/panel-store";
import { buildAbsoluteExplorerPath } from "@/utils/explorer-paths";
import { isHiddenExplorerPath } from "@/file-explorer/visibility";
import {
  fileExplorerRevealOffset,
  fileExplorerRowMetrics,
  fileExplorerRowPaddingLeft,
} from "@/file-explorer/geometry";
import {
  flattenExplorerTree,
  restoreExpandedDirectories,
  setExpandedDirectoryPath,
  showHiddenFilesAndRestoreExpandedDirectories,
  type ExplorerTreeRow,
} from "@/file-explorer/tree";
import { useWorkspaceFileDragSource } from "@/attachments/use-workspace-file-drag-source";
import { confirmDialog } from "@/utils/confirm-dialog";
import { useToast } from "@/contexts/toast-context";
import { openDesktopTarget, useDesktopOpenTargets } from "@/workspace/desktop-open-targets";
import { useWorkspaceFields } from "@/stores/session-store-hooks";
import { useOpenDirectoryInEditor } from "@/workspace/open-in-editor/directory";
const ThemedLoadingSpinner = withUnistyles(LoadingSpinner);
const foregroundMutedColorMapping = (theme: Theme) => ({
  color: theme.colors.foregroundMuted,
});
function DirectoryChevronIcon({ loading, expanded }: { loading: boolean; expanded: boolean }) {
  const [delayedLoading, setDelayedLoading] = useState(false);
  useEffect(() => {
    setDelayedLoading(false);
    if (!loading) return;
    const timer = setTimeout(() => setDelayedLoading(true), 200);
    return () => clearTimeout(timer);
  }, [loading]);
  if (loading && expanded && delayedLoading) {
    return (
      <ThemedLoadingSpinner
        size={WORKSPACE_TREE_LOADING_ICON_SIZE}
        uniProps={foregroundMutedColorMapping}
      />
    );
  }
  return <TreeChevron expanded={expanded} />;
}
interface TreeRowItemProps {
  gitDecoration?: GitDecoration;
  serverId: string;
  workspaceId?: string | null;
  entry: ExplorerEntry;
  depth: number;
  isExpanded: boolean;
  isSelected: boolean;
  loading: boolean;
  onEntryPress: (entry: ExplorerEntry) => void;
  onSelectEntry: (entry: ExplorerEntry) => void;
  onCopyPath: (path: string) => void;
  onCopyRelativePath: (path: string) => void;
  onOpenInEditor?: (entry: ExplorerEntry) => void;
  editorTargetName?: string;
  onRevealEntry?: (entry: ExplorerEntry) => void;
  revealTargetName?: string;
  onDownloadEntry: (entry: ExplorerEntry) => void;
  onAddToChat?: (path: string) => void;
  onOpenFileToSide?: (path: string) => void;
  onNewEntry?: (parentPath: string, kind: "file" | "directory") => void;
  onCollapseDirectory?: (path: string) => void;
  onRenameEntry?: (entry: ExplorerEntry) => void;
  onDuplicateEntry?: (entry: ExplorerEntry) => void;
  onDeleteEntry?: (entry: ExplorerEntry) => void;
  testID?: string;
}
type ExplorerListRow =
  | {
      type: "entry";
      row: ExplorerTreeRow;
    }
  | {
      type: "draft";
      parentPath: string;
      kind: "file" | "directory";
      depth: number;
    }
  | {
      type: "rename";
      entry: ExplorerEntry;
      depth: number;
    };
type ExplorerPendingEdit =
  | {
      type: "create";
      parentPath: string;
      kind: "file" | "directory";
    }
  | {
      type: "rename";
      entry: ExplorerEntry;
    };
function listRowKeyExtractor(row: ExplorerListRow) {
  if (row.type === "entry") {
    return row.row.entry.path;
  }
  return row.type === "rename" ? `rename:${row.entry.path}` : `draft:${row.parentPath}:${row.kind}`;
}
interface EntryNameInputRowProps {
  accessibilityLabel?: string;
  editable?: boolean;
  depth: number;
  kind: "file" | "directory";
  initialName?: string;
  onCommit: (name: string) => void;
  onCancel: () => void;
}
export function EntryNameInputRow({
  accessibilityLabel,
  editable,
  depth,
  kind,
  initialName = "",
  onCommit,
  onCancel,
}: EntryNameInputRowProps) {
  const { t } = useTranslation();
  const [name, setName] = useState(initialName);
  const settledRef = useRef(false);
  const commit = useCallback(() => {
    if (settledRef.current) {
      return;
    }
    settledRef.current = true;
    const trimmed = name.trim();
    if (!trimmed) {
      onCancel();
      return;
    }
    onCommit(trimmed);
  }, [name, onCancel, onCommit]);
  const handleKeyPress = useCallback(
    (event: NativeSyntheticEvent<TextInputKeyPressEventData>) => {
      if (event.nativeEvent.key === "Escape") {
        settledRef.current = true;
        onCancel();
      }
    },
    [onCancel],
  );
  return (
    <View
      style={[
        workspaceTreeRowStyles.row,
        styles.desktopRow,
        { paddingLeft: fileExplorerRowPaddingLeft(depth) },
      ]}
    >
      <View style={styles.entryInfo}>
        <View style={styles.entryIcon}>
          {kind === "directory" && <TreeChevron expanded={false} />}
        </View>
        <View style={styles.entryIcon}>
          {kind === "directory" ? (
            <MaterialFolderIcon
              folderName={name || "untitled"}
              expanded={false}
              size={WORKSPACE_TREE_ICON_SIZE}
            />
          ) : (
            <MaterialFileIcon fileName={name || "untitled"} size={WORKSPACE_TREE_ICON_SIZE} />
          )}
        </View>
        <TextInput
          accessibilityLabel={accessibilityLabel}
          editable={editable}
          autoFocus
          initialValue={name}
          onChangeText={setName}
          onSubmitEditing={commit}
          onBlur={commit}
          onKeyPress={handleKeyPress}
          placeholder={
            kind === "directory"
              ? t("workspace.fileExplorer.draft.folderPlaceholder")
              : t("workspace.fileExplorer.draft.filePlaceholder")
          }
          autoCapitalize="none"
          autoCorrect={false}
          placeholderTextColor={styles.draftPlaceholder.color}
          style={styles.draftInput}
          selectTextOnFocus={Boolean(initialName)}
          testID="file-explorer-name-input"
        />
      </View>
    </View>
  );
}
const ENTRY_DRAG_SELECTION = { file: undefined, directory: { kind: "whole_folder" } } as const;

function gitDecorationTone(status: GitDecoration) {
  if (status === "U" || status === "A") return "added";
  if (status === "D" || status === "!") return "deleted";
  return "modified";
}

function gitDecorationColors(theme: Theme) {
  return {
    added: theme.colors.statusSuccess,
    modified: theme.colors.statusDotRunning,
    deleted: theme.colors.statusDanger,
  };
}

function gitDecorationStyle(status?: GitDecoration, ignored?: boolean) {
  if (!status || ignored) return undefined;
  return styles.gitLabel(gitDecorationTone(status));
}
function GitStatusBadge({
  status,
  ignored,
  directory,
  testID,
}: {
  status?: GitDecoration;
  ignored?: boolean;
  directory: boolean;
  testID?: string;
}) {
  if (!status || ignored) return null;
  if (directory)
    return (
      <View
        testID={testID ? `${testID}-git-status` : undefined}
        accessibilityLabel="Contains Git changes"
        style={[styles.gitFolderDot, styles.gitDotColor(gitDecorationTone(status))]}
      />
    );
  return (
    <Text
      testID={testID ? `${testID}-git-status` : undefined}
      accessibilityLabel={`Git status ${status}`}
      style={[styles.gitBadge, gitDecorationStyle(status)]}
    >
      {status}
    </Text>
  );
}
const TreeRowItem = memo(function TreeRowItem({
  gitDecoration,
  serverId,
  workspaceId,
  entry,
  depth,
  isExpanded,
  isSelected,
  loading,
  onEntryPress,
  onSelectEntry,
  onCopyPath,
  onCopyRelativePath,
  onOpenInEditor,
  editorTargetName,
  onRevealEntry,
  revealTargetName,
  onDownloadEntry,
  onAddToChat,
  onOpenFileToSide,
  onNewEntry,
  onCollapseDirectory,
  onRenameEntry,
  onDuplicateEntry,
  onDeleteEntry,
  testID,
}: TreeRowItemProps) {
  const [isHovered, setHovered] = useState(false);
  const handlePointerEnter = useCallback(() => setHovered(true), []);
  const handlePointerLeave = useCallback(() => setHovered(false), []);
  const isDirectory = entry.kind === "directory";
  const dragSourceRef = useWorkspaceFileDragSource({
    enabled: true,
    selection: ENTRY_DRAG_SELECTION[entry.kind],
    serverId,
    workspaceId,
    path: entry.path,
  });
  const handlePress = useCallback(() => {
    const selection = window.getSelection();
    if (selection && !selection.isCollapsed && selection.toString().length > 0) {
      return;
    }
    onEntryPress(entry);
  }, [onEntryPress, entry]);
  const handleSelect = useCallback(() => {
    onSelectEntry(entry);
  }, [entry, onSelectEntry]);
  const accessibilityState = useMemo(
    () => ({ selected: isSelected, expanded: isDirectory ? isExpanded : undefined, busy: loading }),
    [isSelected, isDirectory, isExpanded, loading],
  );
  const pressableStyle = useCallback(
    ({
      hovered,
      pressed,
    }: PressableStateCallbackType & {
      hovered?: boolean;
    }) => [
      workspaceTreeRowStyles.row,
      styles.desktopRow,
      { paddingLeft: fileExplorerRowPaddingLeft(depth) },
      (Boolean(hovered) || pressed || isSelected) && workspaceTreeRowStyles.active,
    ],
    [depth, isSelected],
  );
  const handleCopy = useCallback(() => {
    onCopyPath(entry.path);
  }, [onCopyPath, entry.path]);
  const handleCopyRelativePath = useCallback(() => {
    onCopyRelativePath(entry.path);
  }, [onCopyRelativePath, entry.path]);
  const handleOpenInEditor = useCallback(() => {
    onOpenInEditor?.(entry);
  }, [entry, onOpenInEditor]);
  const handleReveal = useCallback(() => {
    onRevealEntry?.(entry);
  }, [onRevealEntry, entry]);
  const handleDownload = useCallback(() => {
    onDownloadEntry(entry);
  }, [onDownloadEntry, entry]);
  const handleAddToChat = useCallback(() => {
    onAddToChat?.(entry.path);
  }, [onAddToChat, entry.path]);
  const handleOpenToSide = useCallback(() => {
    onOpenFileToSide?.(entry.path);
  }, [entry.path, onOpenFileToSide]);
  const handleNewFile = useCallback(() => {
    onNewEntry?.(entry.path, "file");
  }, [onNewEntry, entry.path]);
  const handleNewFolder = useCallback(() => {
    onNewEntry?.(entry.path, "directory");
  }, [onNewEntry, entry.path]);
  const handleCollapseDirectory = useCallback(() => {
    onCollapseDirectory?.(entry.path);
  }, [entry.path, onCollapseDirectory]);
  const handleRename = useCallback(() => {
    onRenameEntry?.(entry);
  }, [onRenameEntry, entry]);
  const handleDuplicate = useCallback(() => {
    onDuplicateEntry?.(entry);
  }, [entry, onDuplicateEntry]);
  const handleDelete = useCallback(() => {
    onDeleteEntry?.(entry);
  }, [onDeleteEntry, entry]);
  const labelStyle = useMemo(
    () => [
      styles.entryName,
      !gitDecoration && !entry.gitIgnored && workspaceTreeRowStyles.name,
      gitDecorationStyle(gitDecoration, entry.gitIgnored),
      entry.gitIgnored && styles.ignoredEntryName,
      (isHovered || isSelected) && workspaceTreeRowStyles.nameHovered,
    ],
    [gitDecoration, entry.gitIgnored, isHovered, isSelected],
  );
  return (
    <View
      style={styles.rowHoverTarget}
      onPointerEnter={handlePointerEnter}
      onPointerLeave={handlePointerLeave}
    >
      <ContextMenu>
        <ContextMenuTrigger
          onPress={handlePress}
          onLongPress={handleSelect}
          onContextMenu={handleSelect}
          style={pressableStyle}
          accessibilityState={accessibilityState}
          aria-selected={isSelected}
          aria-expanded={isDirectory ? isExpanded : undefined}
          aria-busy={loading}
          testID={testID}
        >
          <View ref={dragSourceRef} style={styles.entryInfo}>
            <View style={styles.entryIcon}>
              {isDirectory && <DirectoryChevronIcon loading={loading} expanded={isExpanded} />}
            </View>
            <View style={styles.entryIcon}>
              {isDirectory ? (
                <MaterialFolderIcon
                  folderName={entry.name}
                  expanded={isExpanded}
                  size={WORKSPACE_TREE_ICON_SIZE}
                />
              ) : (
                <MaterialFileIcon fileName={entry.path} size={WORKSPACE_TREE_ICON_SIZE} />
              )}
            </View>
            <Text
              style={labelStyle}
              numberOfLines={1}
              testID={testID ? `${testID}-name` : undefined}
            >
              {entry.name}
            </Text>
            <GitStatusBadge
              status={gitDecoration}
              ignored={entry.gitIgnored}
              directory={isDirectory}
              testID={testID}
            />
          </View>
        </ContextMenuTrigger>
        <FileActionsContextMenuContent
          fileKind={entry.kind}
          onOpenInEditor={isDirectory && onOpenInEditor ? handleOpenInEditor : undefined}
          editorTargetName={editorTargetName}
          onCopyPath={handleCopy}
          onCopyRelativePath={handleCopyRelativePath}
          onReveal={onRevealEntry ? handleReveal : undefined}
          revealTargetName={revealTargetName}
          onDownload={handleDownload}
          onAddToChat={onAddToChat ? handleAddToChat : undefined}
          onOpenToSide={!isDirectory && onOpenFileToSide ? handleOpenToSide : undefined}
          onNewFile={onNewEntry ? handleNewFile : undefined}
          onNewFolder={onNewEntry ? handleNewFolder : undefined}
          onCollapseFolder={isDirectory && isExpanded ? handleCollapseDirectory : undefined}
          onRename={onRenameEntry ? handleRename : undefined}
          onDuplicate={onDuplicateEntry ? handleDuplicate : undefined}
          onDelete={onDeleteEntry ? handleDelete : undefined}
          testIDPrefix={testID}
        />
      </ContextMenu>
    </View>
  );
});
function revealExplorerRow(list: FlatList<ExplorerListRow>, index: number) {
  if (isWeb) {
    const viewport: unknown = list.getScrollableNode();
    if (viewport instanceof HTMLElement) {
      const row = viewport.querySelector(`[data-testid="file-explorer-row-${index}"]`);
      if (row) {
        // Viewability callbacks can lag behind selection and list-data changes.
        // Read the current geometry before deciding whether scrolling is necessary.
        const bounds = viewport.getBoundingClientRect();
        const rowBounds = row.getBoundingClientRect();
        const offset = fileExplorerRevealOffset({
          rowTop: rowBounds.top,
          rowBottom: rowBounds.bottom,
          viewportTop: bounds.top,
          viewportBottom: bounds.top + viewport.clientHeight,
          scrollOffset: viewport.scrollTop,
        });
        if (offset !== viewport.scrollTop) list.scrollToOffset({ offset, animated: false });
        return;
      }
    }
  }
  // Rows outside the virtualized render window have no DOM geometry yet.
  list.scrollToIndex({ index, animated: false });
}

interface FileExplorerPaneProps {
  serverId: string;
  workspaceId?: string | null;
  workspaceRoot: string;
  onOpenFile?: (filePath: string) => void;
  onOpenFileToSide?: (filePath: string) => void;
  onAddToChat?: (path: string) => void;
}
export function FileExplorerPane({
  serverId,
  workspaceId,
  workspaceRoot,
  onOpenFile,
  onOpenFileToSide,
  onAddToChat,
}: FileExplorerPaneProps) {
  const { t } = useTranslation();
  const isCompact = useIsCompactFormFactor();
  const normalizedWorkspaceRoot = useMemo(() => workspaceRoot.trim(), [workspaceRoot]);
  const workspaceStateKey = useMemo(
    () =>
      buildWorkspaceExplorerStateKey({
        workspaceId,
        workspaceRoot: normalizedWorkspaceRoot,
      }),
    [normalizedWorkspaceRoot, workspaceId],
  );
  const hasWorkspaceScope = Boolean(workspaceStateKey && normalizedWorkspaceRoot);
  const explorerState = useSessionStore((state) =>
    workspaceStateKey && state.sessions[serverId]
      ? state.sessions[serverId]?.fileExplorer.get(workspaceStateKey)
      : undefined,
  );
  const {
    requestDirectoryListing,
    createEntry,
    renameEntry,
    duplicateEntry,
    deleteEntry,
    selectExplorerEntry,
  } = useFileExplorerActions({
    serverId,
    workspaceId,
    workspaceRoot: normalizedWorkspaceRoot,
  });
  const toast = useToast();
  const isLocalDaemon = useIsLocalDaemon(serverId);
  const { targets: desktopOpenTargets } = useDesktopOpenTargets({
    isLocalExecution: isLocalDaemon,
  });
  const fileManagerTarget = desktopOpenTargets.find((target) => target.kind === "file-manager");
  const projectId = useWorkspaceFields(
    serverId,
    workspaceId ?? null,
    (workspace) => workspace.projectId,
  );
  const gitDecorations = useGitDecorations(
    serverId,
    workspaceId,
    projectId,
    normalizedWorkspaceRoot,
  );
  const openDirectoryInEditor = useOpenDirectoryInEditor({
    serverId,
    workspaceDirectory: normalizedWorkspaceRoot,
    projectId,
  });
  // COMPAT(fsEntryOps): added in v0.3.0, remove gate after 2027-02-08.
  const fsEntryOpsEnabled = useSessionStore(
    (state) => state.sessions[serverId]?.serverInfo?.features?.fsEntryOps === true,
  );
  // COMPAT(fsEntryDuplicate): added in v0.3.0, remove gate after 2027-02-09.
  const fsEntryDuplicateEnabled = useSessionStore(
    (state) => state.sessions[serverId]?.serverInfo?.features?.fsEntryDuplicate === true,
  );
  const [pendingEdit, setPendingEdit] = useState<ExplorerPendingEdit | null>(null);
  const downloadFile = useFileDownload({
    serverId,
    workspaceId,
    workspaceRoot: normalizedWorkspaceRoot,
  });
  const showHiddenFiles = usePanelStore((state) => state.explorerShowHiddenFiles);
  const toggleExplorerShowHiddenFiles = usePanelStore(
    (state) => state.toggleExplorerShowHiddenFiles,
  );
  const expandedPathsArray = usePanelStore((state) =>
    workspaceStateKey ? state.expandedPathsByWorkspace[workspaceStateKey] : undefined,
  );
  const setExpandedPathsForWorkspace = usePanelStore((state) => state.setExpandedPathsForWorkspace);
  const expandedPaths = useMemo(
    () => new Set(expandedPathsArray && expandedPathsArray.length > 0 ? expandedPathsArray : ["."]),
    [expandedPathsArray],
  );
  const explorerDerived = useMemo(() => deriveExplorerFields(explorerState), [explorerState]);
  const { directories, requests, error, selectedEntryPath, errorPath } = explorerDerived;
  const isDirectoryLoading = useCallback(
    (path: string) => requests.get(path)?.status === "loading" && !directories.has(path),
    [requests, directories],
  );
  const treeListRef = useRef<FlatList<ExplorerListRow>>(null);
  const scrollbar = useOverlayFlatListScrollbar(treeListRef, { enabled: !isCompact });
  const hasInitializedRef = useRef(false);
  useEffect(() => {
    hasInitializedRef.current = false;
  }, [workspaceStateKey]);
  useEffect(() => {
    void initializeExplorer({
      hasWorkspaceScope,
      hasInitializedRef,
      workspaceStateKey,
      persistedExpandedPaths: expandedPaths,
      showHiddenFiles,
      requestDirectoryListing,
    });
  }, [
    expandedPaths,
    hasWorkspaceScope,
    requestDirectoryListing,
    showHiddenFiles,
    workspaceStateKey,
  ]);
  const handleToggleDirectory = useCallback(
    (entry: ExplorerEntry) =>
      toggleDirectory({
        entry,
        workspaceStateKey,
        requestDirectoryListing,
        setExpandedPathsForWorkspace,
      }),
    [workspaceStateKey, requestDirectoryListing, setExpandedPathsForWorkspace],
  );
  // Selection is intentionally separate from opening/expansion so future keyboard actions
  // (for example, pressing R to rename) have one stable file-or-folder target.
  const handleSelectEntry = useCallback(
    (entry: ExplorerEntry) => {
      if (hasWorkspaceScope) {
        selectExplorerEntry(entry.path);
      }
    },
    [hasWorkspaceScope, selectExplorerEntry],
  );
  const handleOpenFile = useCallback(
    (entry: ExplorerEntry) => {
      if (!hasWorkspaceScope) {
        return;
      }
      onOpenFile?.(entry.path);
    },
    [hasWorkspaceScope, onOpenFile],
  );
  const handleEntryPress = useCallback(
    (entry: ExplorerEntry) => {
      handleSelectEntry(entry);
      if (entry.kind === "directory") {
        handleToggleDirectory(entry);
        return;
      }
      handleOpenFile(entry);
    },
    [handleOpenFile, handleSelectEntry, handleToggleDirectory],
  );
  const handleCollapseDirectory = useCallback(
    (path: string) => {
      if (!workspaceStateKey) {
        return;
      }
      setExpandedPathsForWorkspace(workspaceStateKey, (currentPaths) =>
        currentPaths.filter((expandedPath) => !isExplorerPathWithin(expandedPath, path)),
      );
    },
    [setExpandedPathsForWorkspace, workspaceStateKey],
  );
  const handleCopyPath = useCallback(
    async (path: string) => {
      await Clipboard.setStringAsync(
        buildAbsoluteExplorerPath({
          workspaceRoot: normalizedWorkspaceRoot,
          entryPath: path,
        }),
      );
    },
    [normalizedWorkspaceRoot],
  );
  const handleCopyRelativePath = useCallback(async (path: string) => {
    await Clipboard.setStringAsync(path);
  }, []);
  const handleRevealEntry = useCallback(
    async (entry: ExplorerEntry) => {
      if (!fileManagerTarget) {
        return;
      }
      try {
        await openDesktopTarget({
          editorId: fileManagerTarget.id,
          workspacePath: normalizedWorkspaceRoot,
          filePath: buildAbsoluteExplorerPath({
            workspaceRoot: normalizedWorkspaceRoot,
            entryPath: entry.path,
          }),
        });
      } catch (cause) {
        toast.error(
          cause instanceof Error ? cause.message : t("workspace.fileExplorer.errors.revealFailed"),
        );
      }
    },
    [fileManagerTarget, normalizedWorkspaceRoot, t, toast],
  );
  const handleOpenDirectoryInEditor = useCallback(
    (entry: ExplorerEntry) => openDirectoryInEditor?.open(entry.path),
    [openDirectoryInEditor],
  );
  const handleDownloadEntry = useCallback(
    (entry: ExplorerEntry) => {
      if (entry.kind !== "file") {
        return;
      }
      downloadFile({ fileName: entry.name, path: entry.path });
    },
    [downloadFile],
  );
  const handleNewEntry = useCallback(
    (parentPath: string, kind: "file" | "directory") => {
      if (!workspaceStateKey) {
        return;
      }
      if (parentPath !== ".") {
        setExpandedPathsForWorkspace(workspaceStateKey, (currentPaths) =>
          setExpandedDirectoryPath({
            currentExpandedPaths: currentPaths,
            directoryPath: parentPath,
            expanded: true,
          }),
        );
        void requestDirectoryListing(parentPath, { preferCache: true });
      }
      setPendingEdit({ type: "create", parentPath, kind });
    },
    [requestDirectoryListing, setExpandedPathsForWorkspace, workspaceStateKey],
  );
  const handleEditCancel = useCallback(() => {
    setPendingEdit(null);
  }, []);
  const handleRenameEntry = useCallback((entry: ExplorerEntry) => {
    setPendingEdit({ type: "rename", entry });
  }, []);
  const handleDraftCommit = useCallback(
    async (name: string) => {
      const edit = pendingEdit;
      setPendingEdit(null);
      if (edit?.type !== "create") {
        return;
      }
      try {
        const payload = await createEntry({
          parentPath: edit.parentPath,
          name,
          kind: edit.kind,
        });
        if (!payload) {
          return;
        }
        if (!payload.success) {
          toast.error(payload.error ?? t("workspace.fileExplorer.errors.createFailed"));
          return;
        }
        if (edit.kind === "file" && payload.path) {
          selectExplorerEntry(payload.path);
          onOpenFile?.(payload.path);
        }
      } catch (cause) {
        toast.error(cause instanceof Error ? cause.message : String(cause));
      }
    },
    [createEntry, onOpenFile, pendingEdit, selectExplorerEntry, t, toast],
  );
  const handleRenameCommit = useCallback(
    async (name: string) => {
      const edit = pendingEdit;
      setPendingEdit(null);
      if (edit?.type !== "rename" || name === edit.entry.name) {
        return;
      }
      const { entry } = edit;
      try {
        const payload = await renameEntry({
          path: entry.path,
          name,
          kind: entry.kind,
        });
        if (!payload) {
          return;
        }
        if (!payload.success || !payload.renamedPath) {
          toast.error(payload.error ?? t("workspace.fileExplorer.errors.renameFailed"));
          return;
        }
        const renamedPath = payload.renamedPath;
        if (workspaceStateKey && entry.kind === "directory") {
          const expandedRenamedPaths = Array.from(expandedPaths)
            .filter((expandedPath) => isExplorerPathWithin(expandedPath, entry.path))
            .map((expandedPath) =>
              replaceExplorerPathPrefix(expandedPath, entry.path, renamedPath),
            );
          setExpandedPathsForWorkspace(workspaceStateKey, (currentPaths) =>
            currentPaths.map((currentPath) =>
              isExplorerPathWithin(currentPath, entry.path)
                ? replaceExplorerPathPrefix(currentPath, entry.path, renamedPath)
                : currentPath,
            ),
          );
          await Promise.all(
            expandedRenamedPaths.map((expandedPath) => requestDirectoryListing(expandedPath)),
          );
        }
        if (selectedEntryPath && isExplorerPathWithin(selectedEntryPath, entry.path)) {
          const renamedSelection = replaceExplorerPathPrefix(
            selectedEntryPath,
            entry.path,
            renamedPath,
          );
          selectExplorerEntry(renamedSelection);
          if (entry.kind === "file") {
            onOpenFile?.(renamedSelection);
          }
        }
      } catch (cause) {
        toast.error(cause instanceof Error ? cause.message : String(cause));
      }
    },
    [
      expandedPaths,
      onOpenFile,
      pendingEdit,
      requestDirectoryListing,
      renameEntry,
      selectExplorerEntry,
      selectedEntryPath,
      setExpandedPathsForWorkspace,
      t,
      toast,
      workspaceStateKey,
    ],
  );
  const handleDuplicateEntry = useCallback(
    async (entry: ExplorerEntry) => {
      try {
        const payload = await duplicateEntry(entry.path);
        if (!payload) {
          return;
        }
        if (!payload.success || !payload.duplicatedPath) {
          toast.error(payload.error ?? t("workspace.fileExplorer.errors.duplicateFailed"));
          return;
        }
        selectExplorerEntry(payload.duplicatedPath);
      } catch (cause) {
        toast.error(cause instanceof Error ? cause.message : String(cause));
      }
    },
    [duplicateEntry, selectExplorerEntry, t, toast],
  );
  const handleDeleteEntry = useCallback(
    async (entry: ExplorerEntry) => {
      const confirmed = await confirmDialog({
        title:
          entry.kind === "directory"
            ? t("workspace.fileActions.confirmDelete.folderTitle")
            : t("workspace.fileActions.confirmDelete.fileTitle"),
        message: t("workspace.fileActions.confirmDelete.message", { name: entry.name }),
        confirmLabel: t("workspace.fileActions.confirmDelete.confirm"),
        cancelLabel: t("workspace.fileActions.confirmDelete.cancel"),
        destructive: true,
      });
      if (!confirmed) {
        return;
      }
      try {
        const payload = await deleteEntry(entry.path);
        if (!payload) {
          return;
        }
        if (!payload.success) {
          toast.error(payload.error ?? t("workspace.fileExplorer.errors.deleteFailed"));
          return;
        }
        if (selectedEntryPath === entry.path) {
          selectExplorerEntry(null);
        }
      } catch (cause) {
        toast.error(cause instanceof Error ? cause.message : String(cause));
      }
    },
    [deleteEntry, selectExplorerEntry, selectedEntryPath, t, toast],
  );
  const handleToggleHiddenFiles = useCallback(() => {
    const willShow = !usePanelStore.getState().explorerShowHiddenFiles;
    if (!willShow) {
      toggleExplorerShowHiddenFiles();
      return;
    }
    const rootDirectory = directories.get(".");
    if (!rootDirectory || !workspaceStateKey) {
      toggleExplorerShowHiddenFiles();
      return;
    }
    void showHiddenFilesAndRestoreExpandedDirectories({
      rootDirectory,
      persistedExpandedPaths: expandedPaths,
      showHiddenFiles: toggleExplorerShowHiddenFiles,
      requestDirectoryListing: (path) => requestDirectoryListing(path, { preferCache: true }),
    });
  }, [
    directories,
    expandedPaths,
    requestDirectoryListing,
    toggleExplorerShowHiddenFiles,
    workspaceStateKey,
  ]);
  const refreshExplorer = useCallback(
    () =>
      refreshExplorerDirectories({
        hasWorkspaceScope,
        expandedPaths,
        requestDirectoryListing,
      }),
    [expandedPaths, hasWorkspaceScope, requestDirectoryListing],
  );
  const { refetch: refetchExplorer, isFetching: isRefreshFetching } = useQuery({
    queryKey: ["fileExplorerRefresh", serverId, workspaceStateKey],
    queryFn: refreshExplorer,
    enabled: false,
  });
  const handleRefresh = useCallback(() => {
    void refetchExplorer();
  }, [refetchExplorer]);
  const treeRows = useMemo(
    () => flattenExplorerTree({ directories, expandedPaths, sortOption: "name", showHiddenFiles }),
    [directories, expandedPaths, showHiddenFiles],
  );
  const listRows = useMemo<ExplorerListRow[]>(() => {
    const rows: ExplorerListRow[] = treeRows.map((row) =>
      pendingEdit?.type === "rename" && pendingEdit.entry.path === row.entry.path
        ? { type: "rename", entry: row.entry, depth: row.depth }
        : { type: "entry", row },
    );
    if (pendingEdit?.type !== "create") {
      return rows;
    }
    let insertionIndex = 0;
    let depth = 0;
    if (pendingEdit.parentPath !== ".") {
      const parentIndex = treeRows.findIndex((row) => row.entry.path === pendingEdit.parentPath);
      if (parentIndex >= 0) {
        insertionIndex = parentIndex + 1;
        depth = treeRows[parentIndex].depth + 1;
      }
    }
    rows.splice(insertionIndex, 0, {
      type: "draft",
      parentPath: pendingEdit.parentPath,
      kind: pendingEdit.kind,
      depth,
    });
    return rows;
  }, [pendingEdit, treeRows]);
  const showInitialLoading = !directories.has(".") && requests.get(".")?.status === "loading";
  const revealRequest = explorerState?.revealRequest;
  const lastRevealRequest = useRef<typeof revealRequest>(undefined);
  useEffect(() => {
    if (!revealRequest || revealRequest === lastRevealRequest.current || !treeListRef.current)
      return;
    const index = listRows.findIndex(
      (row) => row.type === "entry" && row.row.entry.path === revealRequest.path,
    );
    if (index < 0) return;
    lastRevealRequest.current = revealRequest;
    revealExplorerRow(treeListRef.current, index);
  }, [listRows, revealRequest]);
  const showBackFromError = Boolean(error && selectedEntryPath);
  const renderTreeRow = useCallback(
    (info: ListRenderItemInfo<ExplorerListRow>) => {
      if (info.item.type === "draft") {
        return (
          <EntryNameInputRow
            depth={info.item.depth}
            kind={info.item.kind}
            onCommit={handleDraftCommit}
            onCancel={handleEditCancel}
          />
        );
      }
      if (info.item.type === "rename") {
        return (
          <EntryNameInputRow
            depth={info.item.depth}
            kind={info.item.entry.kind}
            initialName={info.item.entry.name}
            onCommit={handleRenameCommit}
            onCancel={handleEditCancel}
          />
        );
      }
      return (
        <TreeRowDispatcher
          serverId={serverId}
          workspaceId={workspaceId}
          row={info.item.row}
          gitDecoration={gitDecorations.get(info.item.row.entry.path)}
          index={info.index}
          expandedPaths={expandedPaths}
          selectedEntryPath={selectedEntryPath}
          isDirectoryLoading={isDirectoryLoading}
          onEntryPress={handleEntryPress}
          onSelectEntry={handleSelectEntry}
          onCopyPath={handleCopyPath}
          onCopyRelativePath={handleCopyRelativePath}
          onOpenInEditor={openDirectoryInEditor ? handleOpenDirectoryInEditor : undefined}
          editorTargetName={openDirectoryInEditor?.targetName}
          onRevealEntry={fileManagerTarget ? handleRevealEntry : undefined}
          revealTargetName={fileManagerTarget?.label}
          onDownloadEntry={handleDownloadEntry}
          onAddToChat={onAddToChat}
          onOpenFileToSide={onOpenFileToSide}
          onNewEntry={fsEntryOpsEnabled ? handleNewEntry : undefined}
          onCollapseDirectory={handleCollapseDirectory}
          onRenameEntry={fsEntryOpsEnabled ? handleRenameEntry : undefined}
          onDuplicateEntry={fsEntryDuplicateEnabled ? handleDuplicateEntry : undefined}
          onDeleteEntry={fsEntryOpsEnabled ? handleDeleteEntry : undefined}
        />
      );
    },
    [
      expandedPaths,
      gitDecorations,
      fsEntryDuplicateEnabled,
      fsEntryOpsEnabled,
      handleCollapseDirectory,
      handleCopyPath,
      handleCopyRelativePath,
      handleOpenDirectoryInEditor,
      handleDeleteEntry,
      handleDownloadEntry,
      handleDraftCommit,
      handleDuplicateEntry,
      handleEditCancel,
      handleEntryPress,
      handleNewEntry,
      handleRenameCommit,
      handleRenameEntry,
      handleRevealEntry,
      handleSelectEntry,
      isDirectoryLoading,
      fileManagerTarget,
      openDirectoryInEditor,
      selectedEntryPath,
      onAddToChat,
      onOpenFileToSide,
      serverId,
      workspaceId,
    ],
  );
  const handleBackFromError = useCallback(() => {
    if (!hasWorkspaceScope) {
      return;
    }
    selectExplorerEntry(null);
    void requestDirectoryListing(".");
  }, [hasWorkspaceScope, requestDirectoryListing, selectExplorerEntry]);
  const handleRetry = useCallback(() => {
    void requestDirectoryListing(errorPath).then((directory) => {
      if (!directory || !workspaceStateKey) return;
      const panel = usePanelStore.getState();
      return restoreExpandedDirectories({
        rootDirectory: directory,
        persistedExpandedPaths: new Set(panel.expandedPathsByWorkspace[workspaceStateKey]),
        showHiddenFiles: panel.explorerShowHiddenFiles,
        requestDirectoryListing: (path) => requestDirectoryListing(path, { preferCache: true }),
      });
    });
  }, [requestDirectoryListing, errorPath, workspaceStateKey]);
  if (!hasWorkspaceScope) {
    return (
      <View style={styles.centerState}>
        <Text style={styles.errorText}>{t("workspace.fileExplorer.states.unavailable")}</Text>
      </View>
    );
  }
  return (
    <View
      {...{
        onContextMenu: (event: { preventDefault?: () => void }) => event.preventDefault?.(),
      }}
      style={styles.container}
    >
      <FileExplorerRefactoringHost
        serverId={serverId}
        workspaceId={workspaceId}
        root={normalizedWorkspaceRoot}
      />
      <FileExplorerPaneContent
        workspaceRoot={normalizedWorkspaceRoot}
        error={error}
        hasRoot={directories.has(".")}
        isCompact={isCompact}
        showInitialLoading={showInitialLoading}
        showBackFromError={showBackFromError}
        listRows={listRows}
        onNewEntryAtRoot={fsEntryOpsEnabled ? handleNewEntry : undefined}
        isRefreshFetching={isRefreshFetching}
        treeListRef={treeListRef}
        scrollbar={scrollbar}
        renderTreeRow={renderTreeRow}
        handleToggleHiddenFiles={handleToggleHiddenFiles}
        handleRefresh={handleRefresh}
        handleBackFromError={handleBackFromError}
        handleRetry={handleRetry}
      />
    </View>
  );
}
interface WebContextMenuEvent {
  nativeEvent: {
    pageX: number;
    pageY: number;
  };
  target: unknown;
  preventDefault(): void;
  stopPropagation(): void;
}
function isFileExplorerRowTarget(target: unknown): boolean {
  if (typeof Element === "undefined" || !(target instanceof Element)) {
    return false;
  }
  return target.closest('[data-testid^="file-explorer-row-"]') !== null;
}
function RootCreationContextTarget({
  children,
  enabled,
}: {
  children: ReactNode;
  enabled: boolean;
}) {
  const contextMenu = useContextMenu();
  const handleContextMenu = useCallback(
    (event: WebContextMenuEvent) => {
      if (!enabled || isFileExplorerRowTarget(event.target)) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      contextMenu.setAnchorRect({
        x: event.nativeEvent.pageX,
        y: event.nativeEvent.pageY,
        width: 0,
        height: 0,
      });
      contextMenu.setOpen(true);
    },
    [contextMenu, enabled],
  );
  return (
    <View
      {...{ onContextMenu: handleContextMenu }}
      style={styles.rootContextTarget}
      testID="files-empty-area"
    >
      {children}
    </View>
  );
}
interface FileExplorerPaneContentProps {
  workspaceRoot: string;
  error: string | null;
  hasRoot: boolean;
  isCompact: boolean;
  showInitialLoading: boolean;
  showBackFromError: boolean;
  listRows: ExplorerListRow[];
  onNewEntryAtRoot?: (parentPath: string, kind: "file" | "directory") => void;
  isRefreshFetching: boolean;
  treeListRef: RefObject<FlatList<ExplorerListRow> | null>;
  scrollbar: OverlayFlatListScrollbar;
  renderTreeRow: (info: ListRenderItemInfo<ExplorerListRow>) => ReactElement;
  handleToggleHiddenFiles: () => void;
  handleRefresh: () => void;
  handleBackFromError: () => void;
  handleRetry: () => void;
}
function FileExplorerPaneContent(props: FileExplorerPaneContentProps) {
  const { theme } = useUnistyles();
  const { t } = useTranslation();
  const {
    workspaceRoot,
    error,
    hasRoot,
    isCompact,
    showInitialLoading,
    showBackFromError,
    listRows,
    onNewEntryAtRoot,
    isRefreshFetching,
    treeListRef,
    scrollbar,
    renderTreeRow,
    handleToggleHiddenFiles,
    handleRefresh,
    handleBackFromError,
    handleRetry,
  } = props;
  const showHiddenFiles = usePanelStore((state) => state.explorerShowHiddenFiles);
  const handleNewFileAtRoot = useCallback(() => {
    onNewEntryAtRoot?.(".", "file");
  }, [onNewEntryAtRoot]);
  const handleNewFolderAtRoot = useCallback(() => {
    onNewEntryAtRoot?.(".", "directory");
  }, [onNewEntryAtRoot]);
  const handleScrollToIndexFailed = useCallback(
    ({ index, averageItemLength }: { index: number; averageItemLength: number }) => {
      treeListRef.current?.scrollToOffset({ offset: index * averageItemLength, animated: false });
    },
    [treeListRef],
  );
  const hiddenFilesToggleAccessibilityLabel = showHiddenFiles
    ? t("workspace.fileExplorer.actions.hideHiddenFiles")
    : t("workspace.fileExplorer.actions.showHiddenFiles");
  const emptyLabel = showHiddenFiles
    ? t("workspace.fileExplorer.empty.noFiles")
    : t("workspace.fileExplorer.empty.noVisibleFiles");
  if (error && !hasRoot) {
    return (
      <View style={styles.centerState}>
        <Text accessibilityRole="alert" testID="file-explorer-error" style={styles.errorText}>
          {error}
        </Text>
        <View style={styles.errorActions}>
          {showBackFromError ? (
            <Pressable style={styles.retryButton} onPress={handleBackFromError}>
              <Text style={styles.retryButtonText}>{t("workspace.fileExplorer.actions.back")}</Text>
            </Pressable>
          ) : null}
          <Pressable style={styles.retryButton} onPress={handleRetry}>
            <Text style={styles.retryButtonText}>{t("workspace.fileExplorer.actions.retry")}</Text>
          </Pressable>
        </View>
      </View>
    );
  }
  if (showInitialLoading) {
    return (
      <View style={styles.centerState}>
        <ThemedLoadingSpinner size="small" uniProps={foregroundMutedColorMapping} />
        <Text style={styles.loadingText}>{t("workspace.fileExplorer.states.loading")}</Text>
      </View>
    );
  }
  return (
    <View style={[styles.treePane, styles.treePaneFill]}>
      <PaneHeader
        testID="files-pane-header"
        titleTestID="files-root-folder-name"
        title={
          workspaceRoot
            .replace(/[\\/]+$/, "")
            .split(/[\\/]/)
            .pop() || workspaceRoot
        }
      >
        {onNewEntryAtRoot ? (
          <>
            <ToolbarButton
              label={t("workspace.fileActions.newFile")}
              compact={isCompact}
              hitSlop={8}
              testID="files-new-file"
              onPress={handleNewFileAtRoot}
            >
              <FilePlus
                size={paneContentToolbarIconSize(isCompact)}
                color={theme.colors.foregroundExtraMuted}
              />
            </ToolbarButton>
            <ToolbarButton
              label={t("workspace.fileActions.newFolder")}
              compact={isCompact}
              hitSlop={8}
              testID="files-new-folder"
              onPress={handleNewFolderAtRoot}
            >
              <FolderPlus
                size={paneContentToolbarIconSize(isCompact)}
                color={theme.colors.foregroundExtraMuted}
              />
            </ToolbarButton>
          </>
        ) : null}
        <ToolbarButton
          label={hiddenFilesToggleAccessibilityLabel}
          selected={!showHiddenFiles}
          compact={isCompact}
          hitSlop={8}
          testID="files-hidden-toggle"
          onPress={handleToggleHiddenFiles}
        >
          {showHiddenFiles ? (
            <Eye
              size={paneContentToolbarIconSize(isCompact)}
              color={theme.colors.foregroundExtraMuted}
            />
          ) : (
            <EyeOff
              size={paneContentToolbarIconSize(isCompact)}
              color={theme.colors.foregroundExtraMuted}
            />
          )}
        </ToolbarButton>
        <ToolbarButton
          label={
            isRefreshFetching
              ? t("workspace.fileExplorer.actions.refreshing")
              : t("workspace.fileExplorer.actions.refresh")
          }
          compact={isCompact}
          disabled={isRefreshFetching}
          hitSlop={8}
          testID="files-refresh"
          onPress={handleRefresh}
        >
          <View style={styles.refreshIcon}>
            {isRefreshFetching ? (
              <LoadingSpinner
                size={paneContentToolbarIconSize(isCompact)}
                color={theme.colors.foregroundExtraMuted}
              />
            ) : (
              <RotateCw
                size={paneContentToolbarIconSize(isCompact)}
                color={theme.colors.foregroundExtraMuted}
              />
            )}
          </View>
        </ToolbarButton>
      </PaneHeader>
      {error ? (
        <View style={styles.errorActions}>
          <Text accessibilityRole="alert" testID="file-explorer-error" style={styles.errorText}>
            {error}
          </Text>
          <Pressable style={styles.retryButton} onPress={handleRetry}>
            <Text style={styles.retryButtonText}>{t("workspace.fileExplorer.actions.retry")}</Text>
          </Pressable>
        </View>
      ) : null}
      <ContextMenu>
        <RootCreationContextTarget enabled={Boolean(onNewEntryAtRoot)}>
          {listRows.length === 0 ? (
            <View style={styles.centerState}>
              <Text style={styles.emptyText}>{emptyLabel}</Text>
            </View>
          ) : (
            <FlatList
              ref={treeListRef}
              style={styles.treeList}
              data={listRows}
              renderItem={renderTreeRow}
              keyExtractor={listRowKeyExtractor}
              onScrollToIndexFailed={handleScrollToIndexFailed}
              testID="file-explorer-tree-scroll"
              contentContainerStyle={styles.entriesContent}
              onLayout={scrollbar.onLayout}
              onScroll={scrollbar.onScroll}
              onContentSizeChange={scrollbar.onContentSizeChange}
              scrollEventThrottle={16}
              showsVerticalScrollIndicator={!scrollbar.enabled}
              initialNumToRender={24}
              maxToRenderPerBatch={40}
              windowSize={12}
            />
          )}
          {listRows.length > 0 ? scrollbar.overlay : null}
        </RootCreationContextTarget>
        {onNewEntryAtRoot ? (
          <FileActionsContextMenuContent
            fileKind="directory"
            onNewFile={handleNewFileAtRoot}
            onNewFolder={handleNewFolderAtRoot}
            testIDPrefix="files-empty-area"
          />
        ) : null}
      </ContextMenu>
    </View>
  );
}
function deriveExplorerFields(state: AgentFileExplorerState | undefined) {
  const requests = state?.requests ?? new Map<string, ExplorerDirectoryRequestState>();
  let error: string | null = null;
  let errorPath = ".";
  for (const [path, request] of requests) {
    if (request.status === "error") {
      error = `${path}: ${request.message}`;
      errorPath = path;
    }
  }
  return {
    directories:
      state?.directories ??
      new Map<
        string,
        {
          path: string;
          entries: ExplorerEntry[];
        }
      >(),
    requests,
    error,
    errorPath,
    selectedEntryPath: state?.selectedEntryPath ?? null,
  };
}
type RequestDirectoryListing = ReturnType<typeof useFileExplorerActions>["requestDirectoryListing"];
function toggleDirectory({
  entry,
  workspaceStateKey,
  requestDirectoryListing,
  setExpandedPathsForWorkspace,
}: {
  entry: ExplorerEntry;
  workspaceStateKey: string | null;
  requestDirectoryListing: RequestDirectoryListing;
  setExpandedPathsForWorkspace: (workspaceStateKey: string, paths: ExpandedPathsUpdate) => void;
}): void {
  if (!workspaceStateKey) {
    return;
  }
  let expanding = false;
  setExpandedPathsForWorkspace(workspaceStateKey, (currentPaths) => {
    expanding = !currentPaths.includes(entry.path);
    return setExpandedDirectoryPath({
      currentExpandedPaths: currentPaths,
      directoryPath: entry.path,
      expanded: expanding,
    });
  });
  if (expanding) {
    void requestDirectoryListing(entry.path, { preferCache: true }).then((directory) => {
      const panel = usePanelStore.getState();
      const currentPaths = new Set(panel.expandedPathsByWorkspace[workspaceStateKey]);
      if (!directory || !currentPaths.has(entry.path)) return;
      return restoreExpandedDirectories({
        rootDirectory: directory,
        persistedExpandedPaths: currentPaths,
        showHiddenFiles: panel.explorerShowHiddenFiles,
        requestDirectoryListing: (path) => requestDirectoryListing(path, { preferCache: true }),
      });
    });
  }
}
function TreeRowDispatcher({
  serverId,
  workspaceId,
  row,
  gitDecoration,
  index,
  expandedPaths,
  selectedEntryPath,
  isDirectoryLoading,
  onEntryPress,
  onSelectEntry,
  onCopyPath,
  onCopyRelativePath,
  onOpenInEditor,
  editorTargetName,
  onRevealEntry,
  revealTargetName,
  onDownloadEntry,
  onAddToChat,
  onOpenFileToSide,
  onNewEntry,
  onCollapseDirectory,
  onRenameEntry,
  onDuplicateEntry,
  onDeleteEntry,
}: {
  serverId: string;
  workspaceId?: string | null;
  gitDecoration?: GitDecoration;
  row: ExplorerTreeRow;
  index: number;
  expandedPaths: Set<string>;
  selectedEntryPath: string | null;
  isDirectoryLoading: (path: string) => boolean;
  onEntryPress: (entry: ExplorerEntry) => void;
  onSelectEntry: (entry: ExplorerEntry) => void;
  onCopyPath: (path: string) => void | Promise<void>;
  onCopyRelativePath: (path: string) => void | Promise<void>;
  onOpenInEditor?: (entry: ExplorerEntry) => void;
  editorTargetName?: string;
  onRevealEntry?: (entry: ExplorerEntry) => void;
  revealTargetName?: string;
  onDownloadEntry: (entry: ExplorerEntry) => void;
  onAddToChat?: (path: string) => void;
  onOpenFileToSide?: (path: string) => void;
  onNewEntry?: (parentPath: string, kind: "file" | "directory") => void;
  onCollapseDirectory?: (path: string) => void;
  onRenameEntry?: (entry: ExplorerEntry) => void;
  onDuplicateEntry?: (entry: ExplorerEntry) => void;
  onDeleteEntry?: (entry: ExplorerEntry) => void;
}) {
  const entry = row.entry;
  const depth = row.depth;
  const isDirectory = entry.kind === "directory";
  const isExpanded = isDirectory && expandedPaths.has(entry.path);
  const isSelected = selectedEntryPath === entry.path;
  const loading = isDirectory && isDirectoryLoading(entry.path);
  return (
    <TreeRowItem
      serverId={serverId}
      workspaceId={workspaceId}
      entry={entry}
      gitDecoration={gitDecoration}
      depth={depth}
      isExpanded={isExpanded}
      isSelected={isSelected}
      loading={loading}
      onEntryPress={onEntryPress}
      onSelectEntry={onSelectEntry}
      onCopyPath={onCopyPath}
      onCopyRelativePath={onCopyRelativePath}
      onOpenInEditor={onOpenInEditor}
      editorTargetName={editorTargetName}
      onRevealEntry={onRevealEntry}
      revealTargetName={revealTargetName}
      onDownloadEntry={onDownloadEntry}
      onAddToChat={onAddToChat}
      onOpenFileToSide={onOpenFileToSide}
      onNewEntry={onNewEntry}
      onCollapseDirectory={onCollapseDirectory}
      onRenameEntry={onRenameEntry}
      onDuplicateEntry={onDuplicateEntry}
      onDeleteEntry={onDeleteEntry}
      testID={`file-explorer-row-${index}`}
    />
  );
}
function isExplorerPathWithin(candidatePath: string, parentPath: string): boolean {
  return candidatePath === parentPath || candidatePath.startsWith(`${parentPath}/`);
}
function replaceExplorerPathPrefix(
  candidatePath: string,
  previousPrefix: string,
  nextPrefix: string,
): string {
  return `${nextPrefix}${candidatePath.slice(previousPrefix.length)}`;
}
async function initializeExplorer({
  hasWorkspaceScope,
  hasInitializedRef,
  workspaceStateKey,
  persistedExpandedPaths,
  showHiddenFiles,
  requestDirectoryListing,
}: {
  hasWorkspaceScope: boolean;
  hasInitializedRef: RefObject<boolean>;
  workspaceStateKey: string | null;
  persistedExpandedPaths: ReadonlySet<string>;
  showHiddenFiles: boolean;
  requestDirectoryListing: RequestDirectoryListing;
}): Promise<void> {
  if (!hasWorkspaceScope || hasInitializedRef.current) {
    return;
  }
  hasInitializedRef.current = true;
  const rootDirectory = await requestDirectoryListing(".", { preferCache: true });
  if (!rootDirectory) {
    hasInitializedRef.current = false;
    return;
  }
  if (!workspaceStateKey) {
    return;
  }
  await restoreExpandedDirectories({
    rootDirectory,
    persistedExpandedPaths,
    showHiddenFiles,
    requestDirectoryListing: (path) => requestDirectoryListing(path, { preferCache: true }),
  });
}
async function refreshExplorerDirectories({
  hasWorkspaceScope,
  expandedPaths,
  requestDirectoryListing,
}: {
  hasWorkspaceScope: boolean;
  expandedPaths: Set<string>;
  requestDirectoryListing: RequestDirectoryListing;
}): Promise<null> {
  if (!hasWorkspaceScope) {
    return null;
  }
  const showHiddenFiles = usePanelStore.getState().explorerShowHiddenFiles;
  const directoryPaths = Array.from(expandedPaths).filter(
    (path) => showHiddenFiles || !isHiddenExplorerPath(path),
  );
  if (!directoryPaths.includes(".")) {
    directoryPaths.unshift(".");
  }
  await Promise.all(directoryPaths.map((path) => requestDirectoryListing(path)));
  return null;
}
const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
  },
  desktopSplit: {
    flex: 1,
    flexDirection: "row",
    minHeight: 0,
  },
  treePane: {
    minWidth: 0,
    position: "relative",
  },
  treePaneFill: {
    flex: 1,
  },
  treePaneWithPreview: {
    flex: 0,
    flexGrow: 0,
    flexShrink: 0,
    borderLeftWidth: 1,
    borderLeftColor: theme.colors.border,
  },
  splitResizeHandle: {
    position: "absolute",
    left: -5,
    top: 0,
    bottom: 0,
    width: 10,
    zIndex: 20,
  },
  previewPane: {
    flex: 1,
    minWidth: 0,
  },
  treeList: {
    flex: 1,
    minHeight: 0,
  },
  entriesContent: {
    flexGrow: 1,
    paddingTop: theme.spacing[1],
    paddingBottom: theme.spacing[4],
  },
  rootContextTarget: {
    flex: 1,
    minHeight: 0,
  },
  centerState: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[2],
    padding: theme.spacing[4],
  },
  loadingText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.chrome,
  },
  errorText: {
    color: theme.colors.destructive,
    fontSize: theme.fontSize.chrome,
    textAlign: "center",
  },
  retryButton: {
    borderRadius: theme.borderRadius.full,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[1],
  },
  retryButtonText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.chrome,
    fontWeight: theme.fontWeight.semibold,
  },
  errorActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  emptyText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.chrome,
    textAlign: "center",
  },
  binaryMetaText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.chrome,
  },
  entryInfo: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: WORKSPACE_TREE_ICON_LABEL_GAP,
    minWidth: 0,
  },
  entryIcon: {
    width: WORKSPACE_TREE_ICON_SIZE,
    height: WORKSPACE_TREE_ICON_SIZE,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  entryName: {
    flex: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.chrome,
    fontFamily: theme.fontFamily.ui,
    fontWeight: theme.fontWeight.medium,
    lineHeight: fileExplorerRowMetrics(theme.fontSize.chrome).lineHeight,
    userSelect: "none",
  },
  gitLabel: (tone: ReturnType<typeof gitDecorationTone>) => {
    const color = gitDecorationColors(theme)[tone];
    return {
      color:
        tone === "deleted" ? color : `color-mix(in srgb, ${color} 80%, ${theme.colors.foreground})`,
    };
  },
  gitDotColor: (tone: ReturnType<typeof gitDecorationTone>) => ({
    backgroundColor: gitDecorationColors(theme)[tone],
  }),
  gitFolderDot: {
    width: 5,
    height: 5,
    borderRadius: 3,
    marginLeft: "auto",
    marginRight: 3,
    opacity: 0.45,
  },
  gitBadge: { marginLeft: "auto", paddingLeft: 8, fontSize: theme.fontSize.xs, fontWeight: "600" },
  ignoredEntryName: {
    color: theme.colors.foregroundExtraMuted,
  },
  rowHoverTarget: { position: "relative" },
  desktopRow: { minHeight: fileExplorerRowMetrics(theme.fontSize.chrome).minHeight },
  draftInput: {
    flex: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.chrome,
    lineHeight: fileExplorerRowMetrics(theme.fontSize.chrome).lineHeight,
    paddingVertical: 0,
    paddingHorizontal: 0,
  },
  draftPlaceholder: {
    color: theme.colors.foregroundExtraMuted,
  },
  previewHeaderText: {
    flex: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.chrome,
    fontWeight: theme.fontWeight.normal,
  },
  refreshIcon: {
    width: 16,
    height: 16,
    alignItems: "center",
    justifyContent: "center",
  },
  previewContent: {
    flex: 1,
  },
  previewScrollContainer: {
    flex: 1,
    minHeight: 0,
    position: "relative",
  },
  previewCodeScrollContent: {
    paddingTop: theme.spacing[3],
    paddingHorizontal: theme.spacing[3],
    paddingBottom: theme.spacing[3] + theme.spacing[2],
  },
  codeText: {
    color: theme.colors.foreground,
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.code,
    flexShrink: 0,
  },
  previewImageScrollContent: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: theme.spacing[3],
  },
  previewImage: {
    width: "100%",
    aspectRatio: 1,
  },
  sheetBackground: {
    backgroundColor: theme.colors.surface2,
  },
  handleIndicator: {
    backgroundColor: theme.colors.palette.zinc[600],
  },
  sheetHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[3],
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: theme.colors.border,
  },
  sheetTitle: {
    fontSize: theme.fontSize.chrome,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foreground,
    flex: 1,
  },
  sheetCloseButton: {
    padding: theme.spacing[2],
  },
  sheetCenterState: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[2],
    padding: theme.spacing[4],
  },
}));
import { FileExplorerRefactoringHost } from "@/file-panels/source/editor/explorer-refactoring";
