import { useCallback, useMemo, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { PluginTheme } from "@mixer/plugin";
import {
  useRpc,
  useSettings,
  type PluginScreenProps,
  type PluginSurfaceProps,
} from "@mixer/plugin/client";
import { Button, confirmDialog, FileIcon, PaneHeader, TextInput } from "@mixer/plugin/client/ui";
import {
  automationSettings,
  applyActionRpc,
  chatRpc,
  createRpc,
  getRunRpc,
  importRpc,
  integrationSettings,
  listRpc,
  listRunsRpc,
  openRpc,
  startRunRpc,
  runtimeStatusRpc,
  runtimeControlRpc,
} from "../shared/contracts.js";

function useStyles(theme: PluginTheme) {
  return useMemo(() => {
    const c = theme.colors;
    return {
      screen: { flex: 1, minHeight: 0 },
      form: { flexDirection: "row" as const, gap: 8, alignItems: "center" as const, padding: 12 },
      settings: { padding: 16, gap: 8 },
      input: { padding: 8, color: c.foreground, backgroundColor: c.surface1 },
      nameInput: { flex: 1, padding: 8, color: c.foreground, backgroundColor: c.surface1 },
      text: { color: c.foreground, fontSize: theme.typography?.chrome ?? 13 },
      name: { flex: 1, color: c.foreground, fontSize: theme.typography?.chrome ?? 13 },
      note: { color: c.foregroundMuted, padding: 12 },
      error: { color: c.statusDanger, padding: 12 },
      toolbar: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        justifyContent: "space-between" as const,
        flexWrap: "wrap" as const,
        gap: 8,
        paddingHorizontal: 16,
        paddingVertical: 6,
        borderBottomWidth: 1,
        borderBottomColor: c.border,
      },
      toolbarGroup: {
        flexDirection: "row" as const,
        flexWrap: "wrap" as const,
        alignItems: "center" as const,
        gap: 8,
      },
      content: { flex: 1, minHeight: 0, paddingHorizontal: 24, paddingTop: 24, paddingBottom: 12 },
      field: { gap: 8, marginBottom: 16 },
      fieldLabel: { color: c.foregroundMuted, fontSize: 12 },
      ask: { alignSelf: "flex-end" as const, marginHorizontal: 16, marginBottom: 16 },
      success: { color: c.statusSuccess },
      danger: { color: c.statusDanger },
      muted: { color: c.foregroundMuted },
      runHeader: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 8,
        paddingHorizontal: 10,
        borderBottomWidth: 1,
        borderBottomColor: c.border,
      },
      runRow: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 8,
        paddingHorizontal: 10,
      },
      output: {
        color: c.foreground,
        padding: 12,
        fontFamily: "monospace",
        backgroundColor: c.surface1,
      },
      table: { flex: 1, minWidth: 740 },
      tableScroll: { flexGrow: 1 },
      tableHeader: { color: c.foregroundMuted },
      filter: {
        paddingHorizontal: 10,
        height: 36,
        borderWidth: 1,
        borderColor: c.border,
        borderRadius: 6,
        color: c.foreground,
      },
      workflowCell: {
        flex: 1,
        minWidth: 0,
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 8,
      },
      workflowActions: {
        width: 206,
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 4,
      },
      workflowInfo: { flex: 1, minWidth: 0, paddingVertical: 8 },
      workflowDetail: { color: c.foregroundMuted, fontSize: 12 },
      row: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 8,
        paddingHorizontal: 12,
        borderBottomWidth: 1,
        borderBottomColor: c.border,
      },
    };
  }, [theme]);
}
type Styles = ReturnType<typeof useStyles>;

function Action({
  label,
  onPress,
  color,
  disabled,
}: {
  label: string;
  onPress(): void;
  color: string;
  disabled?: boolean;
}) {
  const style = useMemo(
    () => ({ paddingHorizontal: 8, paddingVertical: 6, opacity: disabled ? 0.5 : 1 }),
    [disabled],
  );
  const text = useMemo(() => ({ color, fontSize: 13 }), [color]);
  return (
    <Pressable accessibilityRole="button" disabled={disabled} onPress={onPress} style={style}>
      <Text style={text}>{label}</Text>
    </Pressable>
  );
}

function WorkflowRow({
  path,
  name,
  detail,
  state,
  onHistory,
  runnable,
  onRun,
  styles,
  color,
  busy,
  canEdit,
  canChat,
  onEdit,
  onChat,
}: {
  path: string;
  name: string;
  detail: string;
  state: string;
  onHistory(path: string): void;
  runnable: boolean;
  onRun(path: string): void;
  styles: Styles;
  color: string;
  busy: boolean;
  canEdit: boolean;
  canChat: boolean;
  onEdit(path: string): void;
  onChat(path: string): void;
}) {
  const history = useCallback(() => onHistory(path), [onHistory, path]);
  const run = useCallback(() => onRun(path), [onRun, path]);
  const edit = useCallback(() => onEdit(path), [onEdit, path]);
  const chat = useCallback(() => onChat(path), [onChat, path]);
  return (
    <View style={styles.row}>
      <View style={styles.workflowCell}>
        <FileIcon fileName={path} size={16} />
        <View style={styles.workflowInfo}>
          <Text numberOfLines={1} style={styles.text}>
            {name}
          </Text>
          <Text style={styles.workflowDetail}>{detail}</Text>
        </View>
      </View>
      <TableCell value={state} width={120} styles={styles} />
      <View style={styles.workflowActions}>
        <Action label="History" color={color} onPress={history} />
        <Action label="Run" color={color} disabled={busy || !runnable} onPress={run} />
        <Action label="Edit" color={color} disabled={busy || !canEdit} onPress={edit} />
        <Action label="Chat" color={color} disabled={busy || !canChat} onPress={chat} />
      </View>
    </View>
  );
}

type AutomationsPage = "Runs" | "Workflows" | "Integrations" | "Diagnostics";

export function AutomationsScreen({ theme, navigation, host }: PluginScreenProps) {
  const list = useRpc(listRpc);
  const open = useRpc(openRpc);
  const create = useRpc(createRpc);
  const chat = useRpc(chatRpc);
  const start = useRpc(startRunRpc);
  const [page, setPage] = useState<AutomationsPage>("Runs");
  const [selectedRun, setSelectedRun] = useState<string>();
  const [kind, setKind] = useState<"agent" | "steps">("agent");
  const {
    data,
    error: loadError,
    isPending,
    refetch,
  } = useQuery({
    queryKey: ["automations", host.id, "workflows"],
    queryFn: () => list({}),
    refetchInterval: page === "Workflows" ? 5_000 : false,
  });
  const [filter, setFilter] = useState("");
  const [workflowFilter, setWorkflowFilter] = useState("");
  const workflows = data?.workflows.filter((item) =>
    `${item.name} ${item.path} ${item.repositories.join(" ")}`
      .toLowerCase()
      .includes(filter.trim().toLowerCase()),
  );
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const styles = useStyles(theme);
  const perform = useCallback(async (action: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }, []);
  const openEditor = navigation?.openFile;
  const newWorkflow = useCallback(() => {
    void perform(async () => {
      const result = await create({ name, kind });
      setName("");
      openEditor?.({ ...result, serverId: host.id });
      await refetch();
    });
  }, [create, host.id, kind, name, openEditor, perform, refetch]);
  const editWorkflow = useCallback(
    (path: string) => {
      void perform(async () => {
        const result = await open({ path });
        openEditor?.({ ...result, serverId: host.id });
      });
    },
    [host.id, open, openEditor, perform],
  );
  const chatWorkflow = useCallback(
    (path: string) => {
      void perform(async () => {
        const result = await chat({ path });
        navigation?.openAgent({ ...result, serverId: host.id });
      });
    },
    [chat, host.id, navigation, perform],
  );
  const navigate = useCallback((target: AutomationsPage) => {
    if (target === "Runs") {
      setWorkflowFilter("");
      setSelectedRun(undefined);
    }
    setPage(target);
  }, []);
  const askAgent = useCallback(() => {
    void perform(async () => {
      const result = await chat({});
      navigation?.openAgent({ ...result, serverId: host.id });
    });
  }, [chat, host.id, navigation, perform]);
  const showHistory = useCallback((path: string) => {
    setWorkflowFilter(path);
    setSelectedRun(undefined);
    setPage("Runs");
  }, []);
  const changeKind = useCallback(
    () => setKind((current) => (current === "agent" ? "steps" : "agent")),
    [],
  );
  const runWorkflow = useCallback(
    (path: string) => {
      void perform(async () => {
        const { id } = await start({ path });
        setSelectedRun(id);
        setPage("Runs");
      });
    },
    [perform, start],
  );
  return (
    <View style={styles.screen} testID="automations-screen">
      <AutomationsToolbar page={page} navigate={navigate} theme={theme} host={host} />
      {!!error && (
        <Text accessibilityRole="alert" style={styles.error}>
          {error}
        </Text>
      )}
      <View style={styles.content}>
        {page === "Runs" ? (
          <RunsView
            key={host.id}
            theme={theme}
            host={host}
            navigation={navigation}
            workflowFilter={workflowFilter}
            selectedRun={selectedRun}
            selectRun={setSelectedRun}
          />
        ) : null}
        {page === "Integrations" && (
          <ScrollView>
            <AutomationsSettings theme={theme} />
          </ScrollView>
        )}
        {page === "Diagnostics" && <AutomationsDiagnostics theme={theme} host={host} />}
        {page === "Workflows" && (
          <>
            <View style={styles.form}>
              <TextInput
                accessibilityLabel="Workflow name"
                value={name}
                onChangeText={setName}
                placeholder="Workflow name"
                placeholderTextColor={theme.colors.foregroundMuted}
                style={styles.nameInput}
              />
              <Action
                label={kind === "agent" ? "Agent · Markdown" : "Shell · YAML"}
                color={theme.colors.foreground}
                onPress={changeKind}
              />
              <Action
                label="New workflow"
                color={theme.colors.accent}
                disabled={busy || !name.trim() || !openEditor}
                onPress={newWorkflow}
              />
            </View>
            {loadError && (
              <Text accessibilityRole="alert" style={styles.error}>
                {loadError.message}
              </Text>
            )}
            <TextInput
              accessibilityLabel="Filter workflows"
              placeholder="Search workflows"
              value={filter}
              onChangeText={setFilter}
              style={styles.filter}
            />
            <ScrollView>
              <ScrollView horizontal contentContainerStyle={styles.tableScroll}>
                <View style={styles.table} testID="automations-workflows-table">
                  <WorkflowTableHeader styles={styles} />
                  {isPending && <Text style={styles.note}>Loading workflows…</Text>}
                  {workflows?.length === 0 && (
                    <Text style={styles.note}>No matching workflows.</Text>
                  )}
                  {workflows?.map((workflow) => (
                    <WorkflowRow
                      key={workflow.path}
                      path={workflow.path}
                      name={workflow.name}
                      detail={[workflow.path, ...workflow.repositories, workflow.error]
                        .filter(Boolean)
                        .join(" · ")}
                      state={workflowStatus(workflow)}
                      onHistory={showHistory}
                      runnable={!workflow.disabled && !workflow.error}
                      onRun={runWorkflow}
                      styles={styles}
                      color={theme.colors.foreground}
                      busy={busy}
                      canEdit={!!openEditor}
                      canChat={!!navigation}
                      onEdit={editWorkflow}
                      onChat={chatWorkflow}
                    />
                  ))}
                  {data?.limited && (
                    <Text style={styles.note}>Showing a limited set of workflows.</Text>
                  )}
                </View>
              </ScrollView>
            </ScrollView>
          </>
        )}
      </View>
      {navigation && (
        <View style={styles.ask}>
          <Button
            size="sm"
            variant="outline"
            icon="MessageSquare"
            onPress={askAgent}
            disabled={busy}
          >
            Ask agent
          </Button>
        </View>
      )}
    </View>
  );
}

const pages = ["Runs", "Workflows", "Integrations", "Diagnostics"] as const;

function AutomationsTab({
  page,
  selected,
  navigate,
}: {
  page: AutomationsPage;
  selected: boolean;
  navigate(page: AutomationsPage): void;
}) {
  const press = useCallback(() => navigate(page), [navigate, page]);
  return (
    <Button variant={selected ? "secondary" : "ghost"} size="md" onPress={press}>
      {page}
    </Button>
  );
}

function useRuntimeStatus(host: PluginScreenProps["host"]) {
  const status = useRpc(runtimeStatusRpc);
  return useQuery({
    queryKey: ["automations", host.id, "runtime"],
    queryFn: () => status({}),
    refetchInterval: 2_000,
  });
}

function AutomationsToolbar({
  page,
  navigate,
  theme,
  host,
}: Pick<PluginScreenProps, "theme" | "host"> & {
  page: AutomationsPage;
  navigate(page: AutomationsPage): void;
}) {
  const styles = useStyles(theme);
  const query = useQueryClient();
  const { data } = useRuntimeStatus(host);
  const control = useRpc(runtimeControlRpc);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const refresh = useCallback(() => {
    void query.invalidateQueries({ queryKey: ["automations", host.id] });
  }, [host.id, query]);
  const change = useCallback(
    async (action: "start" | "stop" | "restart") => {
      setBusy(true);
      setError("");
      try {
        const status = await control({ action });
        query.setQueryData(["automations", host.id, "runtime"], status);
        refresh();
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setBusy(false);
      }
    },
    [control, host.id, query, refresh],
  );
  const toggle = useCallback(() => {
    void change(data?.paused ? "start" : "stop");
  }, [change, data?.paused]);
  const restart = useCallback(() => {
    void change("restart");
  }, [change]);
  return (
    <>
      <View style={styles.toolbar}>
        <View style={styles.toolbarGroup}>
          {pages.map((tab) => (
            <AutomationsTab key={tab} page={tab} selected={tab === page} navigate={navigate} />
          ))}
        </View>
        <View style={styles.toolbarGroup}>
          <Button variant="outline" size="sm" icon="RefreshCw" onPress={refresh}>
            Refresh
          </Button>
          <Button
            variant="outline"
            size="sm"
            icon="Power"
            onPress={toggle}
            disabled={busy || !data}
          >
            {data?.paused ? "Start" : "Stop"}
          </Button>
          <Button
            variant="outline"
            size="sm"
            icon="RotateCw"
            onPress={restart}
            disabled={busy || !data}
          >
            Restart
          </Button>
        </View>
      </View>
      {!!error && (
        <Text accessibilityRole="alert" style={styles.error}>
          {error}
        </Text>
      )}
    </>
  );
}

function AutomationsDiagnostics({ theme, host }: Pick<PluginScreenProps, "theme" | "host">) {
  const styles = useStyles(theme);
  const { data, error } = useRuntimeStatus(host);
  return (
    <View style={styles.field}>
      <Text style={styles.text}>{host.label}</Text>
      {error && <Text style={styles.error}>{error.message}</Text>}
      {data && (
        <>
          <Text style={styles.text}>Automations · {data.paused ? "Stopped" : "Running"}</Text>
          <Text style={styles.text}>
            Webhook listener · {data.listening ? "Listening" : "Inactive"}
          </Text>
          <Text style={styles.text}>Queued or running · {data.pending}</Text>
        </>
      )}
    </View>
  );
}

function WorkflowTableHeader({ styles }: { styles: Styles }) {
  return (
    <View style={styles.row}>
      <TableCell value="Workflow" styles={styles} heading />
      <TableCell value="Status" width={120} styles={styles} heading />
      <TableCell value="Actions" width={206} styles={styles} heading />
    </View>
  );
}

function workflowStatus(workflow: (typeof listRpc.output)["_output"]["workflows"][number]) {
  if (workflow.error) return "Invalid";
  if (workflow.disabled) return "Disabled";
  return workflow.cron ?? (workflow.triggers.length ? workflow.triggers.join(", ") : "Manual");
}

function RunsView({
  theme,
  host,
  navigation,
  selectedRun,
  workflowFilter,
  selectRun,
}: Pick<PluginScreenProps, "theme" | "host" | "navigation"> & {
  selectedRun?: string;
  workflowFilter: string;
  selectRun(id?: string): void;
}) {
  const back = useCallback(() => selectRun(), [selectRun]);
  return selectedRun ? (
    <RunDetails
      theme={theme}
      host={host}
      navigation={navigation}
      selectedRun={selectedRun}
      back={back}
    />
  ) : (
    <RunHistory theme={theme} host={host} selectRun={selectRun} workflowFilter={workflowFilter} />
  );
}

function RunDetails({
  theme,
  host,
  navigation,
  selectedRun,
  back,
}: Pick<PluginScreenProps, "theme" | "host" | "navigation"> & {
  selectedRun: string;
  back(): void;
}) {
  const styles = useStyles(theme);
  const get = useRpc(getRunRpc);
  const run = useQuery({
    queryKey: ["automations", host.id, "run", selectedRun],
    queryFn: () => get({ id: selectedRun }),
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return !status || status === "running" || status === "queued" ? 1_000 : false;
    },
  });
  const agentId = run.data?.agentId;
  const openAgent = useCallback(() => {
    if (agentId) navigation?.openAgent({ agentId, serverId: host.id });
  }, [agentId, host.id, navigation]);
  return (
    <>
      <PaneHeader title={run.data?.name ?? "Run details"}>
        <Action label="Back to runs" color={theme.colors.foreground} onPress={back} />
      </PaneHeader>
      <ScrollView>
        {run.data ? (
          <>
            <Text style={styles.note}>
              {[
                run.data.path,
                run.data.sourceStatus ?? run.data.status,
                run.data.trigger,
                run.data.repository,
                run.data.revision?.slice(0, 12),
              ]
                .filter(Boolean)
                .join(" · ")}
            </Text>
            {run.data.error && <Text style={styles.error}>{run.data.error}</Text>}
            {run.data.actionError && <Text style={styles.error}>{run.data.actionError}</Text>}
            {run.data.action && (
              <SafeActionRow
                id={selectedRun}
                action={run.data.action}
                refresh={run.refetch}
                theme={theme}
              />
            )}
            {agentId && navigation && (
              <Action label="Open agent" color={theme.colors.accent} onPress={openAgent} />
            )}
            <Text selectable style={styles.output}>
              {run.data.output || "No output yet."}
            </Text>
          </>
        ) : (
          <Text style={run.error ? styles.error : styles.note}>
            {run.error?.message ?? "Loading run…"}
          </Text>
        )}
      </ScrollView>
    </>
  );
}

function SafeActionRow({
  id,
  action,
  refresh,
  theme,
}: {
  id: string;
  action: NonNullable<(typeof getRunRpc.output)["_output"]["action"]>;
  refresh(): Promise<unknown>;
  theme: PluginTheme;
}) {
  const styles = useStyles(theme);
  const apply = useRpc(applyActionRpc);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const label = action.name === "github.pr.merge" ? "Merge PR" : "Approve PR";
  const confirm = useCallback(async () => {
    setPending(true);
    setError("");
    try {
      const accepted = await confirmDialog({
        title: label,
        message: `${action.repository} #${action.number} at ${action.sha.slice(0, 12)}`,
        confirmLabel: label,
      });
      if (!accepted) return;
      await apply({ id, action: action.name, sha: action.sha });
      await refresh();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setPending(false);
    }
  }, [action, apply, id, label, refresh]);
  return (
    <View style={styles.form}>
      <Text style={styles.name}>
        {label} · {action.status} {action.message ?? ""}
      </Text>
      {!!error && (
        <Text accessibilityRole="alert" style={styles.error}>
          {error}
        </Text>
      )}
      {action.status === "proposed" && (
        <Action label={label} disabled={pending} onPress={confirm} color={theme.colors.accent} />
      )}
    </View>
  );
}

const runColumns = [
  { label: "Workflow", weight: 30 },
  { label: "Project", weight: 22 },
  { label: "Run", weight: 15 },
  { label: "Status", weight: 9 },
  { label: "Outcome", weight: 8 },
  { label: "Created", weight: 16 },
] as const;

function RunHistory({
  theme,
  host,
  selectRun,
  workflowFilter,
}: Pick<PluginScreenProps, "theme" | "host"> & {
  selectRun(id: string): void;
  workflowFilter: string;
}) {
  const styles = useStyles(theme);
  const list = useRpc(listRunsRpc);
  const [filter, setFilter] = useState(workflowFilter);
  const { data, error, isPending, dataUpdatedAt } = useQuery({
    queryKey: ["automations", host.id, "runs"],
    queryFn: () => list({}),
    refetchInterval: 2_000,
  });
  const rows = data?.runs.filter((item) =>
    [
      item.name,
      item.path,
      item.id,
      item.importedId,
      item.repository,
      item.sourceStatus ?? item.status,
      item.outcome,
    ].some((value) => value?.toLowerCase().includes(filter.trim().toLowerCase())),
  );
  return (
    <>
      <View style={styles.field}>
        <Text style={styles.fieldLabel}>Filter runs</Text>
        <TextInput
          accessibilityLabel="Filter runs"
          placeholder="Search by workflow, project, status or run ID"
          value={filter}
          onChangeText={setFilter}
          style={styles.filter}
        />
      </View>
      <ScrollView>
        <ScrollView horizontal contentContainerStyle={styles.tableScroll}>
          <View style={styles.table} testID="automations-runs-table">
            <View style={styles.runHeader}>
              {runColumns.map(({ label, weight }) => (
                <TableCell key={label} value={label} weight={weight} styles={styles} heading />
              ))}
            </View>
            {rows?.map((item) => (
              <RunRow
                key={item.id}
                item={item}
                selectRun={selectRun}
                styles={styles}
                now={dataUpdatedAt}
              />
            ))}
          </View>
        </ScrollView>
        {error && <Text style={styles.error}>{error.message}</Text>}
        {isPending && <Text style={styles.note}>Loading runs…</Text>}
        {rows?.length === 0 && <Text style={styles.note}>No matching runs.</Text>}
      </ScrollView>
    </>
  );
}

function TableCell({
  value,
  width,
  weight,
  tone,
  styles,
  heading,
}: {
  value: string;
  width?: number;
  weight?: number;
  tone?: "success" | "danger" | "muted";
  styles: Styles;
  heading?: boolean;
}) {
  const style = useMemo(
    () => [
      styles.text,
      heading && styles.tableHeader,
      tone && styles[tone],
      {
        width,
        flex: width === undefined ? (weight ?? 1) : undefined,
        minWidth: 0,
        paddingVertical: 8,
      },
    ],
    [heading, styles, tone, weight, width],
  );
  return (
    <Text numberOfLines={1} style={style} accessibilityRole={heading ? "header" : undefined}>
      {value}
    </Text>
  );
}

function RunRow({
  item,
  selectRun,
  styles,
  now,
}: {
  item: (typeof listRunsRpc.output)["_output"]["runs"][number];
  selectRun(id: string): void;
  styles: Styles;
  now: number;
}) {
  const open = useCallback(() => selectRun(item.id), [item.id, selectRun]);
  const status = item.sourceStatus ?? (item.status === "succeeded" ? "completed" : item.status);
  const values = [
    item.path,
    item.repository ?? "—",
    item.importedId ?? item.id,
    status,
    item.outcome ?? "—",
    relativeAge(item.createdAt, now),
  ];
  const statusTones = { succeeded: "success", failed: "danger" } as const;
  const statusTone = statusTones[item.status as keyof typeof statusTones] ?? "muted";
  const tones = [undefined, undefined, undefined, statusTone, "muted", "muted"] as const;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Inspect ${item.name}, ${item.status}`}
      onPress={open}
      style={styles.runRow}
    >
      {runColumns.map(({ label, weight }, index) => (
        <TableCell
          key={label}
          value={values[index]}
          weight={weight}
          tone={tones[index]}
          styles={styles}
        />
      ))}
    </Pressable>
  );
}

function relativeAge(created: number, now: number) {
  const minutes = Math.max(0, Math.floor((now - created) / 60_000));
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`;
}

export function AutomationsSettings({ theme }: Pick<PluginSurfaceProps, "theme">) {
  const settings = useSettings(automationSettings);
  const [draft, setDraft] = useState<string | null>(null);
  const [retention, setRetention] = useState<string | null>(null);
  const [schedules, setSchedules] = useState<boolean | null>(null);
  const [integrationDraft, setIntegrationDraft] = useState<Partial<Record<IntegrationKey, string>>>(
    {},
  );
  const changeIntegration = useCallback((key: IntegrationKey, value: string) => {
    setIntegrationDraft((previous) => ({ ...previous, [key]: value.trim() }));
  }, []);
  const validIntegrations = parseIntegrationDraft(
    settings.status === "ready"
      ? settings.values.integrations
      : integrationSettings.parse(undefined),
    integrationDraft,
  ).success;
  const dirty =
    [draft, retention, schedules].some((value) => value !== null) ||
    Object.keys(integrationDraft).length > 0;
  const styles = useStyles(theme);
  const validRetention =
    retention === null ||
    (/^\d+$/.test(retention) && Number(retention) >= 1 && Number(retention) <= 365);
  const save = useCallback(() => {
    if (settings.status !== "ready" || !validRetention) return;
    const values = settings.values;
    const parsed = parseIntegrationDraft(values.integrations, integrationDraft);
    if (!parsed.success) return;
    void settings
      .save(
        {
          integrations: parsed.data,
          agentProvider: draft?.trim() ?? values.agentProvider,
          retentionDays: retention === null ? values.retentionDays : Number(retention),
          schedulesEnabled: schedules ?? values.schedulesEnabled,
        },
        settings.revision,
      )
      .then((saved) => {
        if (saved) {
          setDraft(null);
          setRetention(null);
          setSchedules(null);
          setIntegrationDraft({});
        }
        return saved;
      });
  }, [draft, retention, schedules, settings, validRetention, integrationDraft]);
  const schedulesEnabled =
    schedules ?? (settings.status === "ready" && settings.values.schedulesEnabled);
  const toggleSchedules = useCallback(() => setSchedules(!schedulesEnabled), [schedulesEnabled]);
  if (settings.status !== "ready") {
    return (
      <Text style={styles.note}>
        {"error" in settings ? settings.error : "Loading Automations settings…"}
      </Text>
    );
  }
  return (
    <View style={styles.settings}>
      <Text style={styles.text}>Default agent for workflow runs and chat</Text>
      <TextInput
        accessibilityLabel="Workflow chat provider"
        value={draft ?? settings.values.agentProvider}
        onChangeText={setDraft}
        placeholder="Provider or provider/model"
        placeholderTextColor={theme.colors.foregroundMuted}
        style={styles.input}
      />
      <Text style={styles.text}>Run history retention (days)</Text>
      <TextInput
        accessibilityLabel="Run history retention (days)"
        value={retention ?? String(settings.values.retentionDays)}
        onChangeText={setRetention}
        style={styles.input}
      />
      {!validRetention && <Text style={styles.error}>Enter a whole number from 1 to 365.</Text>}
      <Action
        label={schedulesEnabled ? "Schedules enabled" : "Schedules disabled"}
        color={theme.colors.foreground}
        onPress={toggleSchedules}
      />
      <Text style={styles.text}>Integrations</Text>
      {integrationFields.map(({ field, label }) => (
        <IntegrationInput
          key={field}
          field={field}
          label={label}
          value={integrationDraft[field] ?? String(settings.values.integrations[field])}
          onChange={changeIntegration}
          styles={styles}
        />
      ))}
      <Text style={styles.note}>
        Port 0 disables the loopback webhook listener. Use a host environment variable for each
        secret.
      </Text>
      {!validIntegrations && (
        <Text style={styles.error}>Check the port and environment variable names.</Text>
      )}
      <Action
        label="Save"
        color={theme.colors.accent}
        disabled={settings.saving || !validRetention || !validIntegrations || !dirty}
        onPress={save}
      />
      {settings.saveError && (
        <Text accessibilityRole="alert" style={styles.error}>
          {settings.saveError}
        </Text>
      )}
      <RoboPlaneImport theme={theme} />
    </View>
  );
}

const integrationFields = [
  { field: "webhookPort", label: "Webhook port" },
  { field: "githubSecretEnv", label: "GitHub signing secret variable" },
  { field: "githubTokenEnv", label: "GitHub polling token variable" },
  { field: "githubActionTokenEnv", label: "GitHub Safe Actions token variable" },
  { field: "webhookSecretEnv", label: "Webhook bearer secret variable" },
  { field: "jiraBaseUrl", label: "Jira Data Center URL" },
  { field: "jiraTokenEnv", label: "Jira API token variable" },
] as const;
type IntegrationKey = (typeof integrationFields)[number]["field"];

function parseIntegrationDraft(
  configured: (typeof integrationSettings)["_output"],
  draft: Partial<Record<IntegrationKey, string>>,
) {
  return integrationSettings.safeParse({
    ...configured,
    ...draft,
    webhookPort: Number(draft.webhookPort ?? configured.webhookPort),
  });
}

function IntegrationInput({
  field,
  label,
  value,
  onChange,
  styles,
}: {
  field: IntegrationKey;
  label: string;
  value: string;
  onChange(field: IntegrationKey, value: string): void;
  styles: Styles;
}) {
  const change = useCallback((text: string) => onChange(field, text), [field, onChange]);
  return (
    <>
      <Text style={styles.text}>{label}</Text>
      <TextInput
        accessibilityLabel={label}
        value={value}
        onChangeText={change}
        style={styles.input}
      />
    </>
  );
}

function RoboPlaneImport({ theme }: { theme: PluginTheme }) {
  const runImport = useRpc(importRpc);
  const styles = useStyles(theme);
  const [home, setHome] = useState("");
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState("");
  const [error, setError] = useState("");
  const start = useCallback(async () => {
    setPending(true);
    setResult("");
    setError("");
    try {
      const value = await runImport({ home });
      setResult(
        `Imported ${value.workflows} workflows and ${value.runs} runs. Skipped ${value.skipped} entries.`,
      );
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setPending(false);
    }
  }, [home, runImport]);
  return (
    <>
      <Text style={styles.text}>Import RoboPlane</Text>
      <Text style={styles.note}>
        Enter the RoboPlane home on this host. Imported workflows start disabled.
      </Text>
      <TextInput
        accessibilityLabel="RoboPlane home"
        value={home}
        onChangeText={setHome}
        style={styles.input}
      />
      <Action
        label="Import workflows and runs"
        color={theme.colors.accent}
        disabled={!home.trim() || pending}
        onPress={start}
      />
      {!!result && <Text style={styles.note}>{result}</Text>}
      {!!error && (
        <Text accessibilityRole="alert" style={styles.error}>
          {error}
        </Text>
      )}
    </>
  );
}
