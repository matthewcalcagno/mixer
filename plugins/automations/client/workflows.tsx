import { useCallback, useMemo, useState } from "react";
import { Text, View } from "react-native";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRpc, type PluginScreenProps } from "@mixer/plugin/client";
import {
  ActionMenu,
  Button,
  confirmDialog,
  AGENT_CHAT_LAUNCHER_CLEARANCE,
  Icon,
  PaneHeader,
  PaneHeaderAction,
  SourceEditor,
  type ContextMenuAction,
} from "@mixer/plugin/client/ui";
import {
  deleteWorkflowRpc,
  listRpc,
  readWorkflowRpc,
  saveWorkflowRpc,
  setWorkflowEnabledRpc,
  startRunRpc,
} from "../shared/contracts.js";

type Workflow = (typeof listRpc.output)["_output"]["workflows"][number];
type Source = (typeof readWorkflowRpc.output)["_output"];
type HostProps = Pick<PluginScreenProps, "theme" | "host">;
type EditorOperation = "save" | "reload" | "enable" | "disable" | "delete" | "run";
interface Selection {
  selected: string;
  select(path: string): void;
}
type Props = HostProps &
  Selection & {
    active: boolean;
    paths: string[];
    dirtyPaths: ReadonlySet<string>;
    close(path: string): void;
    onHistory(path: string): void;
    onRun(id: string): void;
    onDirtyChange(path: string, dirty: boolean): void;
  };

function useStyles(theme: HostProps["theme"]) {
  return useMemo(
    () => ({
      fill: { flex: 1, minHeight: 0, minWidth: 0 },
      body: { flex: 1, minHeight: 0, paddingBottom: AGENT_CHAT_LAUNCHER_CLEARANCE },
      hidden: { display: "none" as const },
      row: { flexDirection: "row" as const, alignItems: "center" as const, gap: 4 },
      configurationTools: {
        position: "absolute" as const,
        left: 12,
        bottom: 12,
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 4,
      },
      muted: { color: theme.colors.foregroundMuted, fontSize: theme.typography?.chrome ?? 13 },
      error: {
        color: theme.colors.statusDanger,
        padding: 8,
        fontSize: theme.typography?.chrome ?? 13,
      },
      notice: {
        color: theme.colors.foregroundMuted,
        paddingHorizontal: 10,
        paddingVertical: 4,
        fontSize: 12,
      },
      empty: {
        flex: 1,
        justifyContent: "center" as const,
        alignItems: "center" as const,
        gap: 8,
        padding: 24,
      },
    }),
    [theme],
  );
}
type Styles = ReturnType<typeof useStyles>;
function useWorkflows(host: HostProps["host"]) {
  const list = useRpc(listRpc);
  return useQuery({
    queryKey: ["automations", host.id, "workflows"],
    queryFn: () => list({}),
    refetchInterval: 5_000,
  });
}

export function Workflows(props: Props) {
  const styles = useStyles(props.theme);
  if (!props.paths.length)
    return (
      <View style={styles.empty} testID="automations-workflows">
        <Icon name="Workflow" size={28} color={props.theme.colors.foregroundMuted} />
        <Text style={styles.muted}>No workflow open</Text>
      </View>
    );
  return (
    <View style={styles.fill} testID="automations-workflows">
      {props.paths.map((path) => (
        <WorkflowDocument key={path} {...props} path={path} styles={styles} />
      ))}
    </View>
  );
}

type DocumentProps = Props & { path: string; styles: Styles };
function WorkflowDocument(props: DocumentProps) {
  const read = useRpc(readWorkflowRpc);
  const source = useQuery({
    queryKey: ["automations", props.host.id, "source", props.path],
    queryFn: () => read({ path: props.path }),
    refetchOnWindowFocus: false,
    staleTime: Infinity,
  });
  const style = useMemo(
    () => [props.styles.fill, props.selected !== props.path && props.styles.hidden],
    [props.styles, props.selected, props.path],
  );
  const retry = useCallback(() => {
    void source.refetch();
  }, [source]);
  return (
    <View style={style}>
      {source.error && (
        <View style={props.styles.row}>
          <Text accessibilityRole="alert" style={props.styles.error}>
            {source.error.message}
          </Text>
          <Button size="xs" variant="ghost" onPress={retry}>
            Retry
          </Button>
        </View>
      )}
      {!source.data && !source.error && <Text style={props.styles.notice}>Reading workflow…</Text>}
      {source.data && <WorkflowEditor {...props} initial={source.data} />}
    </View>
  );
}
function WorkflowEditor({ initial, ...props }: DocumentProps & { initial: Source }) {
  const { styles, path, host, onDirtyChange, close, onRun } = props;
  const [source, setSource] = useState(initial);
  const [content, setContent] = useState(initial.content);
  const [notice, setNotice] = useState("");
  const dirty = content !== source.content;
  if (!dirty && initial.version !== source.version) {
    setSource(initial);
    setContent(initial.content);
  }
  const list = useWorkflows(host);
  const workflow = list.data?.workflows.find((item) => item.path === path);
  const read = useRpc(readWorkflowRpc);
  const save = useRpc(saveWorkflowRpc);
  const enabled = useRpc(setWorkflowEnabledRpc);
  const remove = useRpc(deleteWorkflowRpc);
  const run = useRpc(startRunRpc);
  const query = useQueryClient();
  const operation = useMutation({
    mutationFn: async (action: EditorOperation) => {
      setNotice("");
      if (action === "run") {
        const result = await run({ path });
        onRun(result.id);
        return;
      }
      if (action === "delete") {
        const configuration = path === "config.json";
        if (
          !(await confirmDialog({
            title: configuration ? "Delete configuration?" : "Delete workflow?",
            message: configuration
              ? "Deleting config.json restores plugin settings and can change which event sources are enabled."
              : `Delete ${path}? Run history will be kept.`,
            confirmLabel: configuration ? "Delete config.json" : "Delete workflow",
            destructive: true,
          }))
        )
          return;
        await remove({ path, version: source.version });
        close(path);
        query.removeQueries({ queryKey: ["automations", host.id, "source", path], exact: true });
      } else {
        let next: Source;
        if (action === "reload") {
          if (
            dirty &&
            !(await confirmDialog({
              title: "Discard unsaved changes?",
              message: "Reload this workflow from disk?",
              confirmLabel: "Reload",
              destructive: true,
            }))
          )
            return;
          next = await read({ path });
        } else if (action === "save") next = await save({ path, content, version: source.version });
        else next = await enabled({ path, version: source.version, enabled: action === "enable" });
        setSource(next);
        setContent(next.content);
        onDirtyChange(path, false);
        query.setQueryData(["automations", host.id, "source", path], next);
        setNotice(action === "save" ? "Workflow saved." : "Workflow updated.");
      }
      await query.invalidateQueries({ queryKey: ["automations"] });
    },
  });
  const change = useCallback(
    (value: string) => {
      setContent(value);
      onDirtyChange(path, value !== source.content);
    },
    [onDirtyChange, path, source.content],
  );
  const saveShortcut = useCallback(() => {
    if (dirty && !operation.isPending) operation.mutate("save");
  }, [dirty, operation]);
  return (
    <View style={styles.fill} testID="automations-workflow-editor">
      {path !== "config.json" && (
        <EditorToolbar
          {...props}
          workflow={workflow}
          dirty={dirty}
          busy={operation.isPending}
          invoke={operation.mutate}
        />
      )}
      {!!workflow?.error && (
        <Text accessibilityRole="alert" style={styles.error}>
          {workflow.error}
        </Text>
      )}
      {!!operation.error && (
        <Text accessibilityRole="alert" style={styles.error}>
          {operation.error.message}
        </Text>
      )}
      {!!notice && (
        <Text accessibilityLiveRegion="polite" style={styles.notice}>
          {notice}
        </Text>
      )}
      <View style={styles.body}>
        <SourceEditor
          autoFocus={props.active && props.selected === path}
          filename={path}
          value={content}
          onChange={change}
          onSave={saveShortcut}
          readOnly={operation.isPending}
        />
      </View>
      {path === "config.json" && (
        <View style={styles.configurationTools}>
          <PaneHeaderAction
            icon="Save"
            label="Save configuration"
            disabled={operation.isPending || !dirty}
            onPress={saveShortcut}
          />
        </View>
      )}
    </View>
  );
}
function EditorToolbar({
  workflow,
  dirty,
  busy,
  invoke,
  ...props
}: DocumentProps & {
  workflow?: Workflow;
  dirty: boolean;
  busy: boolean;
  invoke(action: EditorOperation): void;
}) {
  const { path, onHistory } = props;
  const history = useCallback(() => onHistory(path), [onHistory, path]);
  const save = useCallback(() => invoke("save"), [invoke]);
  const run = useCallback(() => invoke("run"), [invoke]);
  const toggle = useCallback(
    () => invoke(workflow?.disabled ? "enable" : "disable"),
    [invoke, workflow?.disabled],
  );
  const menu = useCallback(
    (id: string) => {
      if (id === "reload" || id === "delete") invoke(id);
    },
    [invoke],
  );
  const actions = useMemo<ContextMenuAction[]>(
    () => [
      { id: "reload", label: "Reload from disk", disabled: busy },
      {
        id: "delete",
        label: "Delete workflow",
        disabled: busy || dirty,
        separatorBefore: true,
      },
    ],
    [busy, dirty],
  );
  const locked = busy || dirty;
  const invalid = !workflow || !!workflow.error;
  let stateLabel = workflow?.disabled ? "Disabled" : "Enabled";
  if (invalid) stateLabel = "Unavailable";
  return (
    <PaneHeader title={workflow?.name ?? path}>
      <Button size="xs" variant="ghost" disabled={locked || invalid} onPress={toggle}>
        {stateLabel}
      </Button>
      <PaneHeaderAction
        icon="Save"
        label="Save workflow"
        disabled={busy || !dirty}
        onPress={save}
      />
      <PaneHeaderAction icon="History" label="View runs" onPress={history} />
      <Button
        size="xs"
        variant="ghost"
        icon="Play"
        disabled={locked || invalid || workflow?.disabled}
        onPress={run}
      >
        Run
      </Button>
      <ActionMenu label="Workflow actions" actions={actions} onSelect={menu} />
    </PaneHeader>
  );
}
