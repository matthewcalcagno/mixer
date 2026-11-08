import { useCallback, useMemo } from "react";
import { Pressable, Text, View } from "react-native";
import { ContextMenu, Icon, type ContextMenuAction } from "@mixer/plugin/client/ui";
import type { PluginTheme } from "@mixer/plugin";
import { FileRow, IconButton } from "./controls.js";
import { getFolderIconSvg } from "./vendor/file-icon-svg.js";
import {
  conflictLabel,
  type Resource,
  type ResourceNode,
  type ResourceGroup,
} from "../shared/resources.js";
import type { DiffSelection } from "./diff-selection.js";
import {
  resourceKey,
  type ResourceOperation,
  type ResourceKeyAction,
  type ResourceSelection,
  type SelectionGesture,
} from "../shared/selection.js";

interface ResourceListProps {
  nodes: ResourceNode[];
  depth?: number;
  staged: boolean;
  merge: boolean;
  filtered?: boolean;
  active: DiffSelection | null;
  group: ResourceGroup;
  selection: ResourceSelection;
  actionCounts: Record<ResourceOperation, number>;
  collapsedFolders: ReadonlySet<string>;
  onToggleFolder(path: string): void;
  disabled: boolean;
  theme: PluginTheme;
  onSelect(file: Resource, gesture: SelectionGesture): void;
  onContextFile(file: Resource): void;
  onKeyAction(file: Resource, action: ResourceKeyAction): void;
  onFocusFile(file: Resource): void;
  onStageFile(file: Resource): void;
  onStageFolder(paths: string[]): void;
  onDiscard(file: Resource): void;
  onOpenFile?: (path: string) => void;
}
interface ResourceEntryProps extends ResourceListProps {
  node: ResourceNode;
}

export function ResourceList(props: ResourceListProps) {
  return (
    <>
      {props.nodes.map((node) => (
        <ResourceEntry
          key={node.kind === "folder" ? node.path : node.file.path}
          {...props}
          node={node}
        />
      ))}
    </>
  );
}

function ResourceEntry(props: ResourceEntryProps) {
  if (props.node.kind === "file") return <ResourceFileRow {...props} file={props.node.file} />;
  return <ResourceFolderRow {...props} folder={props.node} />;
}

function ResourceFileRow(props: ResourceListProps & { file: Resource }) {
  const { file, onSelect, onContextFile, onKeyAction, onFocusFile, onStageFile, onDiscard } = props;
  const { onOpenFile } = props;
  const depth = props.depth ?? 0;
  const select = useCallback(
    (gesture: SelectionGesture) => onSelect(file, gesture),
    [file, onSelect],
  );
  const context = useCallback(() => onContextFile(file), [file, onContextFile]);
  const open = useCallback(() => onKeyAction(file, { kind: "open" }), [file, onKeyAction]);
  const openFile = useCallback(() => onOpenFile?.(file.path), [onOpenFile, file.path]);
  const keyAction = useCallback(
    (action: ResourceKeyAction) => onKeyAction(file, action),
    [file, onKeyAction],
  );
  const stage = useCallback(() => onStageFile(file), [file, onStageFile]);
  const focus = useCallback(() => onFocusFile(file), [file, onFocusFile]);
  const discard = useCallback(() => onDiscard(file), [file, onDiscard]);
  const canDiscard = !props.staged && !props.merge;
  const key = resourceKey(props.group, file.path);
  const selected = props.selection.keys.has(key);
  const operation = props.staged ? "unstage" : "stage";
  const stageCount = selected ? props.actionCounts[operation] : 1;
  const discardCount = selected ? props.actionCounts.discard : 1;
  const name = file.path.split("/").pop() ?? file.path;
  const verb = props.staged ? "Unstage" : "Stage";
  const menuActions = useMemo<ContextMenuAction[]>(() => {
    const actions: ContextMenuAction[] = [
      { id: "open", label: file.index === "?" ? "Open File" : "Open Changes" },
      {
        id: "stage",
        label: stageCount > 1 ? `${verb} ${stageCount} Changes` : `${verb} Changes`,
        disabled: props.disabled,
      },
    ];
    if (canDiscard)
      actions.push({
        id: "discard",
        label: discardActionLabel(file.index === "?", discardCount),
        disabled: props.disabled,
        separatorBefore: true,
      });
    return actions;
  }, [stageCount, verb, props.disabled, canDiscard, discardCount, file.index]);
  const menuSelect = useCallback(
    (id: string) => {
      if (id === "open") open();
      else if (id === "stage") stage();
      else if (id === "discard") discard();
    },
    [open, stage, discard],
  );
  return (
    <ContextMenu actions={menuActions} onOpen={context} onSelect={menuSelect}>
      <FileRow
        path={file.path}
        status={props.staged ? file.index : file.worktree}
        statusLabel={conflictLabel(file) ?? undefined}
        indent={depth * 12}
        hideDirectory={depth > 0}
        staged={props.staged}
        selected={selected}
        active={props.active?.path === file.path && props.active.staged === props.staged}
        focused={props.selection.focus === key}
        onSelect={select}
        onKeyAction={keyAction}
        onRowFocus={focus}
        stageLabel={stageCount > 1 ? `${verb} ${stageCount} selected files` : `${verb} ${name}`}
        discardLabel={
          file.index === "?"
            ? `Move ${name} to Trash`
            : discardActionLabel(false, discardCount, name)
        }
        disabled={props.disabled}
        theme={props.theme}
        onStage={stage}
        onDiscard={canDiscard ? discard : undefined}
        onOpenFile={onOpenFile ? openFile : undefined}
      />
    </ContextMenu>
  );
}

function ResourceFolderRow(
  props: ResourceListProps & { folder: Extract<ResourceNode, { kind: "folder" }> },
) {
  const { folder: node, theme, onToggleFolder, onStageFolder } = props;
  const collapsed = props.collapsedFolders.has(resourceKey(props.group, node.path));
  const depth = props.depth ?? 0;
  const rowStyle = useMemo(
    () => ({
      flexDirection: "row" as const,
      alignItems: "center" as const,
      paddingLeft: depth * 12 + 6,
      minHeight: 22,
    }),
    [depth],
  );
  const textStyle = useMemo(
    () => ({ color: theme.colors.foreground, fontSize: 13 }),
    [theme.colors.foreground],
  );
  const toggle = useCallback(() => onToggleFolder(node.path), [node.path, onToggleFolder]);
  const stage = useCallback(
    () => onStageFolder(node.files.map((file) => file.path)),
    [node.files, onStageFolder],
  );
  const folderName = node.name;
  const icon = useMemo(
    () => ({ svg: getFolderIconSvg({ folderName, expanded: !collapsed }) }),
    [folderName, collapsed],
  );
  const accessibilityState = useMemo(() => ({ expanded: !collapsed }), [collapsed]);
  return (
    <View>
      <View style={rowStyle}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${collapsed ? "Expand" : "Collapse"} ${node.path}`}
          accessibilityState={accessibilityState}
          onPress={toggle}
          style={FOLDER_STYLE}
        >
          <Icon
            name={collapsed ? "ChevronRight" : "ChevronDown"}
            size={14}
            color={theme.colors.foregroundMuted}
          />
          <Icon icon={icon} size={16} />
          <Text numberOfLines={1} style={textStyle}>
            {node.name}
          </Text>
        </Pressable>
        {!props.merge && (
          <IconButton
            icon={props.staged ? "Minus" : "Plus"}
            label={`${props.staged ? "Unstage" : "Stage"} ${props.filtered ? "matching files in " : ""}folder ${node.path}`}
            disabled={props.disabled}
            theme={theme}
            onPress={stage}
          />
        )}
      </View>
      {!collapsed && <ResourceList {...props} nodes={node.children} depth={depth + 1} />}
    </View>
  );
}
const FOLDER_STYLE = {
  flex: 1,
  flexDirection: "row",
  alignItems: "center",
  gap: 5,
  minHeight: 22,
} as const;

function discardActionLabel(untracked: boolean, count: number, name?: string): string {
  if (untracked) return "Move to Trash…";
  if (count > 1) {
    if (name) return `Discard ${count} selected files`;
    return `Discard ${count} Tracked Changes…`;
  }
  if (name) return `Discard ${name}`;
  return "Discard Changes…";
}
