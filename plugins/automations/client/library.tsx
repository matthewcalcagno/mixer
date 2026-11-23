import { useCallback, useEffect, useMemo, useState } from "react";
import { Text, View } from "react-native";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRpc, type PluginScreenProps } from "@mixer/plugin/client";
import {
  ContextMenu,
  confirmDialog,
  copyText,
  FileTreeRow,
  TreeDragSource,
  TreeDropTarget,
  useToast,
  TreeNameInput,
  PaneHeader,
  PaneHeaderAction,
  SearchField,
  ScrollView,
  type ContextMenuAction,
} from "@mixer/plugin/client/ui";
import {
  automationDirectoryId,
  automationFileId,
  createDirectoryRpc,
  createRpc,
  listRpc,
  readWorkflowRpc,
  moveWorkflowRpc,
  deleteWorkflowRpc,
  duplicateWorkflowRpc,
  readDirectoryRpc,
  moveDirectoryRpc,
  deleteDirectoryRpc,
  workflowId,
} from "../shared/contracts.js";

interface Creation {
  kind: "file" | "folder";
  parent: string;
}
interface Entry {
  path: string;
  kind: "file" | "folder";
}
interface Editing {
  entry: Entry;
  operation: "rename" | "duplicate";
}
interface Props extends Pick<PluginScreenProps, "theme" | "host"> {
  dirtyPaths: ReadonlySet<string>;
  moved(from: string, to: string): void;
  removed(path: string): void;
  selected: string;
  select(path: string): void;
}
const noop = () => {};
const createActions: readonly ContextMenuAction[] = [
  { id: "file", label: "New file" },
  { id: "folder", label: "New folder" },
];
const fileActions: readonly ContextMenuAction[] = [
  { id: "open", label: "Open" },
  { id: "file", label: "New file", separatorBefore: true },
  { id: "folder", label: "New folder" },
  { id: "copy-path", label: "Copy relative path", separatorBefore: true },
  { id: "rename", label: "Rename", separatorBefore: true },
  { id: "duplicate", label: "Duplicate" },
  { id: "delete", label: "Delete", separatorBefore: true },
];
const folderActions: readonly ContextMenuAction[] = [
  ...createActions,
  { id: "collapse", label: "Collapse folder", separatorBefore: true },
  { id: "copy-path", label: "Copy relative path", separatorBefore: true },
  { id: "rename", label: "Rename", separatorBefore: true },
  { id: "delete", label: "Delete", separatorBefore: true },
];
const rootActions: readonly ContextMenuAction[] = [
  ...createActions,
  { id: "collapse-all", label: "Collapse all", separatorBefore: true },
];

function useStyles(theme: Props["theme"]) {
  return useMemo(
    () => ({
      fill: { flex: 1, minHeight: 0 },
      content: { flexGrow: 1, paddingBottom: 16 },
      filter: {
        flexDirection: "row" as const,
        marginHorizontal: 8,
        marginTop: 4,
        marginBottom: 10,
      },
      muted: { color: theme.colors.foregroundMuted, fontSize: 12, padding: 8 },
      error: { color: theme.colors.statusDanger, fontSize: 12, padding: 8 },
    }),
    [theme],
  );
}
type Styles = ReturnType<typeof useStyles>;

export function WorkflowLibrary({
  theme,
  host,
  selected,
  select,
  dirtyPaths,
  moved,
  removed,
}: Props) {
  const dragScope = `automations:${host.id}`;
  const styles = useStyles(theme);
  const listCall = useRpc(listRpc);
  const readFile = useRpc(readWorkflowRpc);
  const moveFile = useRpc(moveWorkflowRpc);
  const duplicateFile = useRpc(duplicateWorkflowRpc);
  const readDirectory = useRpc(readDirectoryRpc);
  const moveDirectory = useRpc(moveDirectoryRpc);
  const deleteFile = useRpc(deleteWorkflowRpc);
  const deleteDirectory = useRpc(deleteDirectoryRpc);
  const query = useQueryClient();
  const toast = useToast();
  const movement = useMutation({
    mutationFn: async ({ path, directory }: { path: string; directory: string }) => {
      if (directory) automationDirectoryId.parse(directory);
      const destination = `${directory ? `${directory}/` : ""}${path.split("/").at(-1)}`;
      if (directories.includes(path)) {
        const source = await readDirectory({ path });
        return moveDirectory({ path, destination, version: source.version });
      }
      workflowId.parse(path);
      const source = await readFile({ path });
      return moveFile({ path, destination, version: source.version });
    },
    onSuccess: async (result, input) => {
      moved(input.path, result.path);
      setClipboard((current) =>
        current?.operation === "cut" && current.path === input.path ? undefined : current,
      );
      setScope(parentOf(result.path));
      setClosed(
        (previous) =>
          new Set([...previous].filter((path) => !`${result.path}/`.startsWith(`${path}/`))),
      );
      await query.invalidateQueries({ queryKey: ["automations", host.id] });
    },
    onError: (error) => toast.error(error.message),
  });
  const move = useCallback(
    (path: string, directory: string) => {
      if (!movement.isPending && parentOf(path) !== directory && !within(directory, path))
        movement.mutate({ path, directory });
    },
    [movement],
  );
  const dropRoot = useCallback((path: string) => move(path, ""), [move]);
  const list = useQuery({
    queryKey: ["automations", host.id, "workflows"],
    queryFn: () => listCall({}),
    refetchInterval: 5_000,
  });
  const [filter, setFilter] = useState("");
  const [scope, setScope] = useState("");
  const [clipboard, setClipboard] = useState<{ path: string; operation: "copy" | "cut" }>();
  const [focusedEntry, setFocusedEntry] = useState("");
  const [creation, setCreation] = useState<Creation | null>(null);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [closed, setClosed] = useState<ReadonlySet<string>>(() => new Set());
  useEffect(() => {
    if (!selected) return;
    const parent = parentOf(selected);
    setScope(parent);
    setClosed((previous) => {
      const remaining = [...previous].filter((path) => !`${parent}/`.startsWith(`${path}/`));
      return remaining.length === previous.size ? previous : new Set(remaining);
    });
  }, [selected]);
  const create = useCallback((next: Creation) => {
    setEditing(null);
    setFilter("");
    setCreation(next);
    setScope(next.parent);
    setClosed(
      (previous) =>
        new Set([...previous].filter((path) => !`${next.parent}/`.startsWith(`${path}/`))),
    );
  }, []);
  const newFile = useCallback(() => create({ kind: "file", parent: scope }), [create, scope]);
  const newFolder = useCallback(() => create({ kind: "folder", parent: scope }), [create, scope]);
  const rootAction = useCallback(
    (id: string) => {
      if (id === "file" || id === "folder") create({ kind: id, parent: "" });
      else if (id === "collapse-all") setClosed(new Set(list.data?.directories ?? []));
    },
    [create, list.data?.directories],
  );
  const cancel = useCallback(() => setCreation(null), []);
  const open = useCallback(
    (path: string) => {
      setScope(parentOf(path));
      select(path);
    },
    [select],
  );
  const created = useCallback(
    (path: string, kind: Creation["kind"]) => {
      setCreation(null);
      setScope(kind === "folder" ? path : parentOf(path));
      setClosed(
        (previous) =>
          new Set([...previous].filter((folder) => !`${path}/`.startsWith(`${folder}/`))),
      );
      if (kind === "file") select(path);
    },
    [select],
  );
  const toggle = useCallback((path: string) => {
    setFocusedEntry(path);
    setScope(path);
    setClosed((previous) => {
      const next = new Set(previous);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);
  const selectTreeFile = useCallback(
    (path: string) => {
      setFocusedEntry(path);
      open(path);
    },
    [open],
  );
  const deletion = useMutation({
    mutationFn: async (entry: Entry) => {
      const source =
        entry.kind === "file"
          ? await readFile({ path: entry.path })
          : await readDirectory({ path: entry.path });
      const unsaved = [...dirtyPaths].some((path) => within(path, entry.path));
      const message =
        entry.kind === "folder"
          ? `Delete ${entry.path} and all its contents? Run history will be kept.`
          : `Delete ${entry.path}? Run history will be kept.`;
      if (
        !(await confirmDialog({
          title: entry.kind === "folder" ? "Delete folder?" : "Delete workflow?",
          message: unsaved ? `${message} Unsaved changes will be discarded.` : message,
          confirmLabel: entry.kind === "folder" ? "Delete folder" : "Delete workflow",
          destructive: true,
        }))
      )
        return null;
      return entry.kind === "file" ? deleteFile(source) : deleteDirectory(source);
    },
    onSuccess: async (result) => {
      if (!result) return;
      removed(result.path);
      setScope((previous) => (within(previous, result.path) ? parentOf(result.path) : previous));
      setClosed((previous) => new Set([...previous].filter((path) => !within(path, result.path))));
      query.removeQueries({
        predicate: (item) =>
          item.queryKey[0] === "automations" &&
          item.queryKey[1] === host.id &&
          item.queryKey[2] === "source" &&
          typeof item.queryKey[3] === "string" &&
          within(item.queryKey[3], result.path),
      });
      await query.invalidateQueries({ queryKey: ["automations", host.id] });
    },
    onError: (error) => toast.error(error.message),
  });
  const action = useCallback(
    (entry: Entry, id: string) => {
      if (id === "open") open(entry.path);
      else if (id === "file" || id === "folder")
        create({ kind: id, parent: entry.kind === "folder" ? entry.path : parentOf(entry.path) });
      else if (id === "copy-path")
        void copyText(entry.path).catch((error: unknown) =>
          toast.error(error instanceof Error ? error.message : "Could not copy path."),
        );
      else if (id === "collapse") setClosed((previous) => new Set([...previous, entry.path]));
      else if (id === "delete") {
        if (!deletion.isPending && !movement.isPending) deletion.mutate(entry);
      } else if (id === "rename" || id === "duplicate") {
        if ([...dirtyPaths].some((path) => within(path, entry.path))) {
          toast.error("Save your drafts before renaming or duplicating this entry.");
          return;
        }
        setCreation(null);
        setEditing({ entry, operation: id });
      }
    },
    [open, create, toast, deletion, movement.isPending, dirtyPaths],
  );
  const cancelEdit = useCallback(() => setEditing(null), []);
  const edited = useCallback(
    async (edit: Editing, path: string) => {
      setEditing(null);
      if (edit.operation === "duplicate") select(path);
      else {
        moved(edit.entry.path, path);
        setScope((previous) =>
          within(previous, edit.entry.path)
            ? `${path}${previous.slice(edit.entry.path.length)}`
            : previous,
        );
        setClosed(
          (previous) =>
            new Set(
              [...previous].map((folder) =>
                within(folder, edit.entry.path)
                  ? `${path}${folder.slice(edit.entry.path.length)}`
                  : folder,
              ),
            ),
        );
      }
      await query.invalidateQueries({ queryKey: ["automations", host.id] });
    },
    [moved, select, query, host.id],
  );
  const files = useMemo(() => {
    const paths = (list.data?.workflows ?? [])
      .filter((item) =>
        `${item.path} ${item.name} ${item.repositories.join(" ")}`
          .toLowerCase()
          .includes(filter.toLowerCase()),
      )
      .map((item) => item.path);
    return paths;
  }, [list.data, filter]);
  const directories = useMemo(
    () =>
      (list.data?.directories ?? []).filter(
        (path) =>
          !filter ||
          path.toLowerCase().includes(filter.toLowerCase()) ||
          files.some((file) => file.startsWith(`${path}/`)),
      ),
    [list.data?.directories, files, filter],
  );
  const paste = useMutation({
    mutationFn: async ({ path, directory }: { path: string; directory: string }) => {
      const source = await readFile({ path });
      const basename = path.split("/").at(-1) ?? path;
      const prefix = directory ? `${directory}/` : "";
      const occupied = new Set([
        ...(list.data?.workflows ?? []).map((item) => item.path),
        ...directories,
      ]);
      let destination = `${prefix}${basename}`;
      for (let index = 1; occupied.has(destination); index++) {
        destination =
          prefix + basename.replace(/(\.[^.]+)$/, ` copy${index === 1 ? "" : ` ${index}`}$1`);
      }
      return duplicateFile({ path, destination, version: source.version });
    },
    onSuccess: () => query.invalidateQueries({ queryKey: ["automations", host.id] }),
    onError: (error) => toast.error(error.message),
  });
  return (
    <View
      style={styles.fill}
      testID="automations-workflow-tree-pane"
      {...{
        onKeyDown: (event: React.KeyboardEvent) => {
          if (
            (!event.metaKey && !event.ctrlKey) ||
            event.altKey ||
            event.shiftKey ||
            editing ||
            (event.target instanceof Element &&
              event.target.closest('input, textarea, [contenteditable="true"]'))
          )
            return;
          const key = event.key.toLowerCase();
          if (
            (key === "c" || key === "x") &&
            focusedEntry &&
            (key === "x" || !directories.includes(focusedEntry))
          ) {
            event.preventDefault();
            event.stopPropagation();
            setClipboard({ path: focusedEntry, operation: key === "x" ? "cut" : "copy" });
          } else if (key === "v" && clipboard && !paste.isPending && !movement.isPending) {
            event.preventDefault();
            event.stopPropagation();
            const directory = directories.includes(focusedEntry)
              ? focusedEntry
              : parentOf(focusedEntry);
            if (clipboard.operation === "cut") move(clipboard.path, directory);
            else paste.mutate({ path: clipboard.path, directory });
          }
        },
      }}
    >
      <PaneHeader title="Workflows">
        <PaneHeaderAction icon="FilePlus2" label="New file" onPress={newFile} />
        <PaneHeaderAction icon="FolderPlus" label="New folder" onPress={newFolder} />
      </PaneHeader>
      <View style={styles.filter}>
        <SearchField
          size="xs"
          value={filter}
          onChangeText={setFilter}
          placeholder="Filter files"
          accessibilityLabel="Filter workflows"
          clearAccessibilityLabel="Clear workflow filter"
        />
      </View>
      {list.error && (
        <Text accessibilityRole="alert" style={styles.error}>
          {list.error.message}
        </Text>
      )}
      {deletion.isPending && (
        <Text accessibilityLiveRegion="polite" style={styles.muted}>
          Deleting {deletion.variables.path}…
        </Text>
      )}
      <ContextMenu fill actions={rootActions} onOpen={noop} onSelect={rootAction}>
        <TreeDropTarget scope={dragScope} onDropPath={dropRoot} disabled={movement.isPending}>
          <Text style={styles.muted}>Workflows</Text>
        </TreeDropTarget>
        <TreeDropTarget fill scope={dragScope} onDropPath={dropRoot}>
          <ScrollView
            style={styles.fill}
            contentContainerStyle={styles.content}
            testID="automations-files-background"
          >
            <Tree
              files={files}
              directories={directories}
              prefix=""
              depth={0}
              dragScope={dragScope}
              dirtyPaths={dirtyPaths}
              move={move}
              selected={selected}
              filter={filter}
              closed={closed}
              toggle={toggle}
              select={selectTreeFile}
              create={create}
              styles={styles}
              creation={creation}
              cancel={cancel}
              created={created}
              editing={editing}
              cancelEdit={cancelEdit}
              edited={edited}
              action={action}
              busy={deletion.isPending || movement.isPending || editing !== null}
            />
            {list.isPending && <Text style={styles.muted}>Loading workflows…</Text>}
            {!list.isPending && !files.length && !directories.length && !!filter && (
              <Text style={styles.muted}>No matching workflows.</Text>
            )}
            {list.data?.limited && (
              <Text style={styles.muted}>Showing a limited set of files.</Text>
            )}
          </ScrollView>
        </TreeDropTarget>
      </ContextMenu>
    </View>
  );
}

interface TreeProps {
  editing: Editing | null;
  cancelEdit(): void;
  edited(edit: Editing, path: string): Promise<void>;
  action(entry: Entry, id: string): void;
  busy: boolean;
  dragScope: string;
  dirtyPaths: ReadonlySet<string>;
  move(path: string, directory: string): void;
  depth: number;
  creation: Creation | null;
  cancel(): void;
  created(path: string, kind: Creation["kind"]): void;
  files: string[];
  directories: string[];
  prefix: string;
  selected: string;
  filter: string;
  closed: ReadonlySet<string>;
  toggle(path: string): void;
  select(path: string): void;
  create(creation: Creation): void;
  styles: Styles;
}
function Tree({ prefix, ...props }: TreeProps) {
  const { files: allFiles, directories } = props;
  const entries = useMemo(() => {
    const folders = new Set<string>();
    const files: string[] = [];
    for (const path of directories) {
      if (path.startsWith(prefix)) folders.add(path.slice(prefix.length).split("/")[0]);
    }
    for (const path of allFiles) {
      if (!path.startsWith(prefix)) continue;
      const relative = path.slice(prefix.length);
      const slash = relative.indexOf("/");
      if (slash < 0) files.push(path);
      else folders.add(relative.slice(0, slash));
    }
    return { folders: [...folders].filter(Boolean).sort(), files: files.sort() };
  }, [prefix, allFiles, directories]);
  return (
    <View>
      {props.creation &&
        `${props.creation.parent}${props.creation.parent ? "/" : ""}` === prefix && (
          <NewEntry
            depth={props.depth}
            key={`${props.creation.kind}:${props.creation.parent}`}
            creation={props.creation}
            styles={props.styles}
            cancel={props.cancel}
            created={props.created}
          />
        )}
      {entries.folders.map((name) => (
        <Folder key={name} {...props} path={`${prefix}${name}`} />
      ))}
      {entries.files.map((path) => (
        <File
          editing={props.editing}
          cancelEdit={props.cancelEdit}
          edited={props.edited}
          styles={props.styles}
          action={props.action}
          busy={props.busy}
          dragScope={props.dragScope}
          dirty={props.dirtyPaths.has(path)}
          depth={props.depth}
          key={path}
          path={path}
          selected={props.selected === path}
          select={props.select}
          move={props.move}
        />
      ))}
    </View>
  );
}
function Folder({ path, ...props }: Omit<TreeProps, "prefix"> & { path: string }) {
  const { toggle, action, move } = props;
  const drop = useCallback((source: string) => move(source, path), [move, path]);
  const expanded = !!props.filter || !props.closed.has(path);
  const press = useCallback(() => toggle(path), [toggle, path]);
  const menu = useCallback(
    (id: string) => {
      action({ path, kind: "folder" }, id);
    },
    [action, path],
  );
  const actions = useMemo(
    () =>
      folderActions.map((item) =>
        Object.assign({}, item, { disabled: props.busy && ["rename", "delete"].includes(item.id) }),
      ),
    [props.busy],
  );
  if (props.editing?.entry.path === path)
    return (
      <EditEntry
        depth={props.depth}
        dirty={[...props.dirtyPaths].some((file) => within(file, path))}
        edit={props.editing}
        styles={props.styles}
        cancel={props.cancelEdit}
        completed={props.edited}
      />
    );
  return (
    <TreeDropTarget scope={props.dragScope} onDropPath={drop}>
      <TreeDragSource scope={props.dragScope} path={path} disabled={props.busy}>
        <ContextMenu actions={actions} onOpen={noop} onSelect={menu}>
          <FileTreeRow
            path={path}
            depth={props.depth}
            expanded={expanded}
            selected={false}
            onPress={press}
          />
        </ContextMenu>
      </TreeDragSource>
      {expanded && (
        <View>
          <Tree {...props} depth={props.depth + 1} prefix={`${path}/`} />
        </View>
      )}
    </TreeDropTarget>
  );
}
function File({
  dragScope,
  dirty,
  depth,
  path,
  selected,
  select,
  move,
  editing,
  cancelEdit,
  edited,
  styles,
  action,
  busy,
}: {
  dragScope: string;
  dirty: boolean;
  depth: number;
  path: string;
  selected: boolean;
  select(path: string): void;
  move(path: string, directory: string): void;
  editing: Editing | null;
  cancelEdit(): void;
  edited(edit: Editing, path: string): Promise<void>;
  styles: Styles;
  action(entry: Entry, id: string): void;
  busy: boolean;
}) {
  const press = useCallback(() => select(path), [select, path]);
  const drop = useCallback((source: string) => move(source, parentOf(path)), [move, path]);
  const menu = useCallback(
    (id: string) => {
      action({ path, kind: "file" }, id);
    },
    [action, path],
  );
  const actions = useMemo(
    () =>
      fileActions.map((item) =>
        Object.assign({}, item, {
          disabled: busy && ["rename", "duplicate", "delete"].includes(item.id),
        }),
      ),
    [busy],
  );
  if (editing?.entry.path === path)
    return (
      <EditEntry
        depth={depth}
        dirty={dirty}
        edit={editing}
        styles={styles}
        cancel={cancelEdit}
        completed={edited}
      />
    );
  return (
    <TreeDropTarget scope={dragScope} onDropPath={drop} disabled={busy}>
      <TreeDragSource scope={dragScope} path={path} disabled={busy || path === "config.json"}>
        <ContextMenu actions={actions} onOpen={noop} onSelect={menu}>
          <FileTreeRow path={path} depth={depth} selected={selected} onPress={press} />
        </ContextMenu>
      </TreeDragSource>
    </TreeDropTarget>
  );
}

function NewEntry({
  depth,
  creation,
  styles,
  cancel,
  created,
}: {
  depth: number;
  creation: Creation;
  styles: Styles;
  cancel(): void;
  created(path: string, kind: Creation["kind"]): void;
}) {
  const [name, setName] = useState("");
  const [attempt, setAttempt] = useState(0);
  const file = useRpc(createRpc);
  const folder = useRpc(createDirectoryRpc);
  const query = useQueryClient();
  const operation = useMutation({
    mutationFn: (value: string) => {
      let filename = value.trim();
      if (creation.kind === "file" && filename && !/\.[^/]+$/.test(filename)) filename += ".yaml";
      const path = `${creation.parent ? `${creation.parent}/` : ""}${filename}`;
      const schema = creation.kind === "file" ? automationFileId : automationDirectoryId;
      if (!schema.safeParse(path).success)
        throw new Error("Use a valid relative name. Workflow files use .yaml, .yml, or .md.");
      return creation.kind === "file" ? file({ path }) : folder({ path });
    },
    onError: () => setAttempt((value) => value + 1),
    onSuccess: async (result) => {
      await query.invalidateQueries({ queryKey: ["automations"] });
      created(result.path, creation.kind);
    },
  });
  const submit = useCallback(
    (value: string) => {
      if (operation.isPending) return;
      setName(value);
      operation.mutate(value);
    },
    [operation],
  );
  return (
    <View>
      <TreeNameInput
        depth={depth}
        key={attempt}
        kind={creation.kind === "file" ? "file" : "directory"}
        initialName={name}
        accessibilityLabel={creation.kind === "file" ? "Workflow filename" : "Folder name"}
        onCommit={submit}
        onCancel={cancel}
        editable={!operation.isPending}
      />
      {operation.error && (
        <Text accessibilityRole="alert" style={styles.error}>
          {operation.error.message}
        </Text>
      )}
    </View>
  );
}
function parentOf(path: string) {
  return path.split("/").slice(0, -1).join("/");
}

function within(path: string, parent: string) {
  return path === parent || path.startsWith(`${parent}/`);
}

interface EditEntryProps {
  depth: number;
  dirty: boolean;
  edit: Editing;
  styles: Styles;
  cancel(): void;
  completed(edit: Editing, path: string): Promise<void>;
}
function EditEntry({ depth, dirty, edit, styles, cancel, completed }: EditEntryProps) {
  const basename = edit.entry.path.split("/").at(-1)!;
  const initialName =
    edit.operation === "duplicate" ? basename.replace(/(\.[^.]+)$/, " copy$1") : basename;
  const [name, setName] = useState(initialName);
  const [attempt, setAttempt] = useState(0);
  const read = useRpc(readWorkflowRpc);
  const move = useRpc(moveWorkflowRpc);
  const duplicate = useRpc(duplicateWorkflowRpc);
  const readFolder = useRpc(readDirectoryRpc);
  const moveFolder = useRpc(moveDirectoryRpc);
  const operation = useMutation({
    mutationFn: async (value: string) => {
      if (dirty) throw new Error("Save your drafts before renaming or duplicating this entry.");
      const filename = value.trim();
      if (!filename || filename.includes("/"))
        throw new Error("Enter a name without folder separators.");
      const parent = parentOf(edit.entry.path);
      const destination = `${parent ? `${parent}/` : ""}${filename}`;
      if (edit.entry.kind === "folder") {
        automationDirectoryId.parse(destination);
        const source = await readFolder({ path: edit.entry.path });
        return moveFolder({ ...source, destination });
      }
      if (!workflowId.safeParse(destination).success)
        throw new Error("Workflow files use .yaml, .yml, or .md.");
      const source = await read({ path: edit.entry.path });
      const input = { path: source.path, version: source.version, destination };
      return edit.operation === "duplicate" ? duplicate(input) : move(input);
    },
    onSuccess: (result) => completed(edit, result.path),
    onError: () => setAttempt((value) => value + 1),
  });
  const submit = useCallback(
    (value: string) => {
      if (operation.isPending) return;
      setName(value);
      if (edit.operation === "rename" && value === basename) cancel();
      else operation.mutate(value);
    },
    [operation, edit.operation, basename, cancel],
  );
  const cancelInput = useCallback(() => {
    if (!operation.isPending) cancel();
  }, [operation.isPending, cancel]);
  return (
    <View>
      <TreeNameInput
        key={attempt}
        depth={depth}
        kind={edit.entry.kind === "folder" ? "directory" : "file"}
        initialName={name}
        accessibilityLabel={
          edit.operation === "duplicate" ? "Duplicate workflow filename" : "Rename entry"
        }
        onCommit={submit}
        onCancel={cancelInput}
        editable={!operation.isPending}
      />
      {operation.isPending && (
        <Text accessibilityLiveRegion="polite" style={styles.muted}>
          {edit.operation === "duplicate" ? "Duplicating…" : "Renaming…"}
        </Text>
      )}
      {operation.error && (
        <Text accessibilityRole="alert" style={styles.error}>
          {operation.error.message}
        </Text>
      )}
    </View>
  );
}
