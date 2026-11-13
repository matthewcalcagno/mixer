import { useCallback, useEffect, useMemo, useState } from "react";
import { Text, View } from "react-native";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRpc, type PluginScreenProps } from "@mixer/plugin/client";
import {
  ContextMenu,
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
  workflowId,
} from "../shared/contracts.js";

interface Creation {
  kind: "file" | "folder";
  parent: string;
}
interface Props extends Pick<PluginScreenProps, "theme" | "host"> {
  dirtyPaths: ReadonlySet<string>;
  moved(from: string, to: string): void;
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

export function WorkflowLibrary({ theme, host, selected, select, dirtyPaths, moved }: Props) {
  const dragScope = `automations:${host.id}`;
  const styles = useStyles(theme);
  const listCall = useRpc(listRpc);
  const readFile = useRpc(readWorkflowRpc);
  const moveFile = useRpc(moveWorkflowRpc);
  const query = useQueryClient();
  const toast = useToast();
  const movement = useMutation({
    mutationFn: async ({ path, directory }: { path: string; directory: string }) => {
      workflowId.parse(path);
      if (directory) automationDirectoryId.parse(directory);
      if (dirtyPaths.has(path)) throw new Error("Save your draft before moving this workflow.");
      const destination = `${directory ? `${directory}/` : ""}${path.split("/").at(-1)}`;
      const source = await readFile({ path });
      return moveFile({ path, destination, version: source.version });
    },
    onSuccess: async (result, input) => {
      query.setQueryData(["automations", host.id, "source", result.path], result);
      moved(input.path, result.path);
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
      if (!movement.isPending && parentOf(path) !== directory) movement.mutate({ path, directory });
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
  const [creation, setCreation] = useState<Creation | null>(null);
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
    },
    [create],
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
    setScope(path);
    setClosed((previous) => {
      const next = new Set(previous);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);
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
  return (
    <View style={styles.fill} testID="automations-workflow-tree-pane">
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
      <ContextMenu fill actions={createActions} onOpen={noop} onSelect={rootAction}>
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
              select={open}
              create={create}
              styles={styles}
              creation={creation}
              cancel={cancel}
              created={created}
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
          dragScope={props.dragScope}
          dirty={props.dirtyPaths.has(path)}
          depth={props.depth}
          key={path}
          path={path}
          selected={props.selected === path}
          select={props.select}
          create={props.create}
        />
      ))}
    </View>
  );
}
function Folder({ path, ...props }: Omit<TreeProps, "prefix"> & { path: string }) {
  const { toggle, create, move } = props;
  const drop = useCallback((source: string) => move(source, path), [move, path]);
  const expanded = !!props.filter || !props.closed.has(path);
  const press = useCallback(() => toggle(path), [toggle, path]);
  const menu = useCallback(
    (id: string) => {
      if (id === "file" || id === "folder") create({ kind: id, parent: path });
    },
    [create, path],
  );
  return (
    <TreeDropTarget scope={props.dragScope} onDropPath={drop}>
      <ContextMenu actions={createActions} onOpen={noop} onSelect={menu}>
        <FileTreeRow
          path={path}
          depth={props.depth}
          expanded={expanded}
          selected={false}
          onPress={press}
        />
      </ContextMenu>
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
  create,
}: {
  dragScope: string;
  dirty: boolean;
  depth: number;
  path: string;
  selected: boolean;
  select(path: string): void;
  create(creation: Creation): void;
}) {
  const press = useCallback(() => select(path), [select, path]);
  const menu = useCallback(
    (id: string) => {
      if (id === "open") select(path);
      else if (id === "file" || id === "folder") create({ kind: id, parent: parentOf(path) });
    },
    [select, create, path],
  );
  return (
    <TreeDragSource scope={dragScope} path={path} disabled={dirty || path === "config.json"}>
      <ContextMenu actions={fileActions} onOpen={noop} onSelect={menu}>
        <FileTreeRow path={path} depth={depth} selected={selected} onPress={press} />
      </ContextMenu>
    </TreeDragSource>
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
