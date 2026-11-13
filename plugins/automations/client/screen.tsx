import { useCallback, useMemo, useState } from "react";
import { Pressable, ScrollView, Text, View, type PressableStateCallbackType } from "react-native";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { PluginTheme } from "@mixer/plugin";
import {
  useRpc,
  useSettings,
  useMixer,
  type PluginScreenProps,
  type PluginSurfaceProps,
} from "@mixer/plugin/client";
import {
  Button,
  Icon,
  CodeEditor,
  AGENT_CHAT_LAUNCHER_CLEARANCE,
  Markdown,
  PaneHeaderAction,
  TextInput,
  WorkspaceIsland,
  WorkspaceLayout,
  WorkspaceSidebar,
  SegmentedControl,
  SettingsSection,
  SettingsCard,
  SettingsRow,
  EditorTabs,
  AgentChat,
  type AgentChatProps,
  useToast,
  type EditorTabsProps,
} from "@mixer/plugin/client/ui";
import { Workflows } from "./workflows.js";
import { WorkflowLibrary } from "./library.js";
import { AutomationAssistant } from "./assistant.js";
import { useConfiguration } from "./configuration.js";
import { inspectRunResult, runOverviewSummary, runStatusTone } from "../shared/run-inspection.js";
import { RunLogs } from "./run-logs.js";
import {
  automationSettings,
  automationFileId,
  getRunRpc,
  importRpc,
  integrationSettings,
  listRunsRpc,
  runtimeStatusRpc,
  runtimeControlRpc,
  startRunRpc,
  replayRunRpc,
  cancelRunRpc,
} from "../shared/contracts.js";

function useStyles(theme: PluginTheme) {
  return useMemo(() => {
    const c = theme.colors;
    const baseSize = theme.typography?.base ?? 14;
    const smallSize = theme.typography?.small ?? 12;
    return {
      screen: { flex: 1, minHeight: 0 },
      form: { flexDirection: "row" as const, gap: 8, alignItems: "center" as const, padding: 12 },
      settings: { padding: 16, gap: 8 },
      input: { padding: 8, color: c.foreground, backgroundColor: c.surface1 },
      text: { color: c.foreground, fontSize: theme.typography?.chrome ?? 13 },
      name: { flex: 1, color: c.foreground, fontSize: theme.typography?.chrome ?? 13 },
      note: { color: c.foregroundMuted, padding: 12 },
      error: { color: c.statusDanger, padding: 12 },
      toolbar: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        justifyContent: "space-between" as const,
        flexWrap: "wrap" as const,
        gap: 4,
        paddingHorizontal: 8,
        paddingVertical: 2,
        borderBottomWidth: 1,
        borderBottomColor: c.border,
      },
      toolbarGroup: {
        flexDirection: "row" as const,
        flexWrap: "wrap" as const,
        alignItems: "center" as const,
        gap: 4,
      },
      content: {
        flex: 1,
        minHeight: 0,
        padding: 16,
        paddingBottom: AGENT_CHAT_LAUNCHER_CLEARANCE,
      },
      fill: { flex: 1, minHeight: 0 },
      reading: {
        width: "100%" as const,
        maxWidth: 1280,
        alignSelf: "center" as const,
        gap: 16,
        paddingVertical: 16,
      },
      inspector: {
        flex: 1,
        minHeight: 0,
        width: "100%" as const,
        alignSelf: "stretch" as const,
        gap: 16,
      },
      inspectorContent: {
        width: "100%" as const,
        maxWidth: 1280,
        alignSelf: "center" as const,
      },
      inspectorTabs: {
        flexDirection: "row" as const,
        flexWrap: "wrap" as const,
        alignItems: "center" as const,
        gap: 4,
        width: "100%" as const,
        maxWidth: 1280,
        alignSelf: "center" as const,
      },
      inspectorLogs: {
        flex: 1,
        minHeight: 0,
        borderWidth: 1,
        borderColor: c.border,
        borderRadius: theme.typography?.radius ?? 6,
        overflow: "hidden" as const,
        width: "100%" as const,
        maxWidth: 1280,
        alignSelf: "center" as const,
      },
      inspectorReading: {
        width: "100%" as const,
        maxWidth: 1280,
        alignSelf: "center" as const,
        gap: 16,
        paddingVertical: 16,
      },
      runTitle: {
        color: c.foreground,
        fontSize: (baseSize * 20) / 14,
        fontWeight: "600" as const,
      },
      runHeading: { gap: 8 },
      metadata: {
        flexDirection: "row" as const,
        flexWrap: "wrap" as const,
        alignItems: "center" as const,
        gap: 8,
      },
      metadataText: { color: c.foregroundMuted, fontSize: smallSize },
      runSuccess: { color: c.statusSuccess, fontSize: smallSize },
      runFailure: { color: c.statusDanger, fontSize: smallSize },
      runWarning: { color: c.statusWarning, fontSize: smallSize },
      runStatus: { color: c.foregroundMuted, fontSize: smallSize },
      cardBody: { padding: 16, gap: 12 },
      resultText: {
        color: c.foreground,
        fontSize: baseSize,
        lineHeight: baseSize * 1.6,
      },
      logs: {
        flex: 1,
        minHeight: 0,
        borderWidth: 1,
        borderColor: c.border,
        borderRadius: theme.typography?.radius ?? 6,
        overflow: "hidden" as const,
      },
      contextEditor: { height: 260, minHeight: 0 },
      section: { gap: 12, paddingVertical: 12 },
      hidden: { display: "none" as const },
      field: { gap: 8, marginBottom: 16 },
      fieldLabel: { color: c.foregroundMuted, fontSize: 12 },
      success: { color: c.statusSuccess },
      danger: { color: c.statusDanger },
      warning: { color: c.statusWarning },
      muted: { color: c.foregroundMuted },
      runHeader: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 16,
        minHeight: 40,
        paddingHorizontal: 16,
        backgroundColor: c.surface1,
        borderBottomWidth: 1,
        borderBottomColor: c.border,
      },
      runRow: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 16,
        minHeight: 52,
        paddingHorizontal: 16,
        borderBottomWidth: 1,
        borderBottomColor: c.border,
      },
      runRowTarget: { position: "relative" as const },
      runRowHover: { backgroundColor: c.surface2 },
      runRowFocus: { backgroundColor: c.surface2, borderBottomColor: c.inputFocus },
      runRowPressed: { backgroundColor: c.surface1 },
      runId: { fontFamily: theme.typography?.monoFontFamily, fontSize: smallSize },
      runDisclosure: { width: 16, alignItems: "center" as const },
      runDisclosureHidden: { opacity: 0 },
      table: {
        flex: 1,
        minWidth: 1010,
        borderWidth: 1,
        borderColor: c.border,
        borderRadius: theme.typography?.radius ?? 6,
        overflow: "hidden" as const,
        alignSelf: "flex-start" as const,
      },
      tableScroll: { flexGrow: 1 },
      tableHeader: { color: c.foregroundMuted, fontSize: smallSize, fontWeight: "500" as const },
      filter: {
        paddingHorizontal: 10,
        height: 36,
        borderWidth: 1,
        borderColor: c.border,
        borderRadius: 6,
        color: c.foreground,
      },
    };
  }, [theme]);
}
type Styles = ReturnType<typeof useStyles>;

function Action({
  label,
  onPress,
  disabled,
}: {
  label: string;
  onPress(): void;
  disabled?: boolean;
}) {
  return (
    <Button variant="ghost" size="xs" disabled={disabled} onPress={onPress}>
      {label}
    </Button>
  );
}

type AutomationsPage = "Runs" | "Workflows" | { kind: "agent"; agentId: string };

export function AutomationsScreen(props: PluginScreenProps) {
  return <AutomationsWorkspace key={props.host.id} {...props} />;
}

function AutomationsWorkspace({ theme, navigation, host, layout }: PluginScreenProps) {
  const mixer = useMixer();
  const toast = useToast();
  const [agentTabs, setAgentTabs] = useState<{ agentId: string; workspaceId: string }[]>([]);
  const [page, setPage] = useState<AutomationsPage>("Runs");
  const [selectedRun, setSelectedRun] = useState<string>();
  const [workflowFilter, setWorkflowFilter] = useState("");
  const [sideOpen, setSideOpen] = useState(!layout.compact);
  const [aiOpen, setAiOpen] = useState(false);
  const [documents, setDocuments] = useState<{
    selected: string;
    paths: string[];
    dirtyPaths: Set<string>;
  }>({ selected: "", paths: [], dirtyPaths: new Set() });
  const styles = useStyles(theme);
  const navigate = useCallback((target: AutomationsPage) => {
    if (target === "Runs") {
      setWorkflowFilter("");
      setSelectedRun(undefined);
    }
    setPage(target);
  }, []);
  const openConversation = useCallback(
    async (agentId: string) => {
      try {
        const agent = mixer.agents.ref(agentId);
        await agent.refresh();
        const workspaceId = agent.workspaceId;
        if (!workspaceId) throw new Error("This agent has no workspace.");
        setAgentTabs((previous) =>
          previous.some((tab) => tab.agentId === agentId)
            ? previous
            : [...previous, { agentId, workspaceId }],
        );
        setPage({ kind: "agent", agentId });
        setAiOpen(false);
      } catch (error) {
        toast.error(
          error instanceof Error ? error.message : "Could not open the agent conversation.",
        );
      }
    },
    [mixer, toast],
  );
  const selectWorkflow = useCallback(
    (path: string) => {
      setDocuments((previous) => ({
        ...previous,
        selected: path,
        paths: previous.paths.includes(path) ? previous.paths : [...previous.paths, path],
      }));
      setPage("Workflows");
      if (layout.compact) setSideOpen(false);
    },
    [layout.compact],
  );
  const closeWorkflow = useCallback(
    (path: string) =>
      setDocuments((previous) => {
        if (previous.dirtyPaths.has(path)) return previous;
        const paths = previous.paths.filter((item) => item !== path);
        return {
          ...previous,
          paths,
          selected: previous.selected === path ? (paths.at(-1) ?? "") : previous.selected,
        };
      }),
    [],
  );
  const changeDirty = useCallback(
    (path: string, dirty: boolean) =>
      setDocuments((previous) => {
        if (previous.dirtyPaths.has(path) === dirty) return previous;
        const dirtyPaths = new Set(previous.dirtyPaths);
        if (dirty) dirtyPaths.add(path);
        else dirtyPaths.delete(path);
        return { ...previous, dirtyPaths };
      }),
    [],
  );
  const movedWorkflow = useCallback((from: string, to: string) => {
    setDocuments((previous) => ({
      ...previous,
      selected: previous.selected === from ? to : previous.selected,
      paths: [...new Set(previous.paths.map((path) => (path === from ? to : path)))],
    }));
  }, []);
  const clearFilter = useCallback(() => setWorkflowFilter(""), []);
  const workflowsActive = page === "Workflows" && documents.paths.length > 0;
  let selectedTab = workflowsActive ? documents.selected : "runs";
  if (typeof page === "object") selectedTab = `agent:${page.agentId}`;
  const files = useMemo<EditorTabsProps["files"]>(
    () => [
      ...documents.paths.map((path) => ({ path, dirty: documents.dirtyPaths.has(path) })),
      ...agentTabs.map((tab) => ({
        path: `agent:${tab.agentId}`,
        kind: "agent" as const,
        label: "Agent",
      })),
    ],
    [documents.paths, documents.dirtyPaths, agentTabs],
  );
  const selectTab = useCallback(
    (path: string) => {
      if (path === "runs") navigate("Runs");
      else if (path.startsWith("agent:")) setPage({ kind: "agent", agentId: path.slice(6) });
      else selectWorkflow(path);
    },
    [navigate, selectWorkflow],
  );
  const closeTab = useCallback(
    (path: string) => {
      if (!path.startsWith("agent:")) {
        closeWorkflow(path);
        return;
      }
      const agentId = path.slice(6);
      setAgentTabs((previous) => previous.filter((tab) => tab.agentId !== agentId));
      setPage((previous) =>
        typeof previous === "object" && previous.agentId === agentId ? "Runs" : previous,
      );
    },
    [closeWorkflow],
  );
  const openAgentFile = useCallback(
    (path: string) => {
      if (automationFileId.safeParse(path).success) selectWorkflow(path);
      else toast.error("Only workflow files can be opened in Automations.");
    },
    [selectWorkflow, toast],
  );
  const workflowStyle = useMemo(
    () => [styles.fill, !workflowsActive && styles.hidden],
    [styles, workflowsActive],
  );
  const showHistory = useCallback((path: string) => {
    setWorkflowFilter(path);
    setSelectedRun(undefined);
    setPage("Runs");
  }, []);
  const showRun = useCallback((id: string) => {
    setSelectedRun(id);
    setPage("Runs");
  }, []);
  return (
    <View style={styles.screen} testID="automations-screen">
      <WorkspaceLayout>
        <WorkspaceIsland>
          <AutomationsToolbar
            files={files}
            selected={selectedTab}
            selectTab={selectTab}
            closeTab={closeTab}
            theme={theme}
            host={host}
          />
          <View style={workflowStyle}>
            <Workflows
              active={workflowsActive}
              theme={theme}
              host={host}
              selected={documents.selected}
              paths={documents.paths}
              dirtyPaths={documents.dirtyPaths}
              select={selectWorkflow}
              close={closeWorkflow}
              onHistory={showHistory}
              onRun={showRun}
              onDirtyChange={changeDirty}
            />
          </View>
          {agentTabs.map((tab) => (
            <AutomationConversation
              key={tab.agentId}
              serverId={host.id}
              conversation={tab}
              active={typeof page === "object" && page.agentId === tab.agentId}
              onOpenFile={openAgentFile}
              onOpenAgent={openConversation}
            />
          ))}
          {!workflowsActive && typeof page === "string" && (
            <View style={styles.content}>
              <RunsView
                key={host.id}
                theme={theme}
                host={host}
                openConversation={openConversation}
                workflowFilter={workflowFilter}
                selectedRun={selectedRun}
                selectRun={setSelectedRun}
                openWorkflow={selectWorkflow}
                clearFilter={clearFilter}
              />
            </View>
          )}
          <AutomationAssistant
            theme={theme}
            host={host}
            navigation={navigation}
            path={documents.selected}
            dirty={documents.dirtyPaths.size > 0}
            visible={aiOpen}
            launcherVisible={typeof page !== "object"}
            onOpenChange={setAiOpen}
            selectFile={selectWorkflow}
            openConversation={openConversation}
          />
        </WorkspaceIsland>
        <WorkspaceSidebar
          persistenceKey={`automations:${host.id}`}
          open={sideOpen}
          onOpenChange={setSideOpen}
          compact={layout.compact}
          testID="automations-sidebar"
        >
          <WorkflowLibrary
            dirtyPaths={documents.dirtyPaths}
            moved={movedWorkflow}
            theme={theme}
            host={host}
            selected={documents.selected}
            select={selectWorkflow}
          />
        </WorkspaceSidebar>
      </WorkspaceLayout>
    </View>
  );
}

const fixedTabs = [{ id: "runs", label: "Runs" }];

function AutomationConversation({
  conversation,
  active,
  ...props
}: Pick<AgentChatProps, "serverId" | "onOpenFile" | "onOpenAgent"> & {
  conversation: { agentId: string; workspaceId: string };
  active: boolean;
}) {
  return (
    <View style={active ? agentPaneStyle : hiddenAgentPaneStyle} testID="automations-agent-tab">
      <AgentChat {...props} {...conversation} active={active} />
    </View>
  );
}
const agentPaneStyle = { flex: 1, minHeight: 0 };
const hiddenAgentPaneStyle = { display: "none" } as const;

function useRuntimeStatus(host: PluginScreenProps["host"]) {
  const status = useRpc(runtimeStatusRpc);
  return useQuery({
    queryKey: ["automations", host.id, "runtime"],
    queryFn: () => status({}),
    refetchInterval: 2_000,
  });
}

function AutomationsToolbar({
  files,
  selected,
  selectTab,
  closeTab,
  theme,
  host,
}: Pick<PluginScreenProps, "theme" | "host"> & {
  files: EditorTabsProps["files"];
  selected: string;
  selectTab(path: string): void;
  closeTab(path: string): void;
}) {
  const styles = useStyles(theme);
  const query = useQueryClient();
  const { data, error: statusError, isFetching } = useRuntimeStatus(host);
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
  const reviewConfiguration = useCallback(() => selectTab("config.json"), [selectTab]);
  return (
    <>
      <View style={styles.toolbar}>
        <EditorTabs
          files={files}
          fixedTabs={fixedTabs}
          selected={selected}
          onSelect={selectTab}
          onClose={closeTab}
        />
        <View style={styles.toolbarGroup}>
          <PaneHeaderAction
            label="Refresh"
            icon="RefreshCw"
            onPress={refresh}
            disabled={isFetching}
          />
          <PaneHeaderAction
            icon="Settings"
            label="Automations configuration"
            onPress={reviewConfiguration}
          />
          <Button
            variant="ghost"
            size="xs"
            icon="Power"
            onPress={toggle}
            disabled={busy || !data}
            loading={busy}
          >
            {data?.paused ? "Start" : "Stop"}
          </Button>
          <PaneHeaderAction
            label="Restart"
            icon="RotateCw"
            onPress={restart}
            disabled={busy || !data}
          />
        </View>
      </View>
      {!!(error || statusError) && (
        <Text accessibilityRole="alert" style={styles.error}>
          {error || statusError?.message}
        </Text>
      )}
      {data?.errors.map((issue) => (
        <Text key={issue.source} accessibilityRole="alert" style={styles.error}>
          {issue.message}
        </Text>
      ))}
      {data?.notices?.map((notice) => (
        <View key={notice.source} style={styles.toolbarGroup}>
          <Text style={styles.metadataText}>{notice.message}</Text>
          <Button size="xs" variant="ghost" onPress={reviewConfiguration}>
            Review configuration
          </Button>
        </View>
      ))}
    </>
  );
}

export function AutomationsPreferences(props: PluginSurfaceProps) {
  return (
    <View testID="automations-preferences">
      <SettingsSection title="Configuration">
        <AutomationsSettings theme={props.theme} />
      </SettingsSection>
      <SettingsSection title="Diagnostics">
        <AutomationsDiagnostics theme={props.theme} host={props.host} />
      </SettingsSection>
    </View>
  );
}

function AutomationsDiagnostics({ theme, host }: Pick<PluginScreenProps, "theme" | "host">) {
  const styles = useStyles(theme);
  const { data, error, isPending } = useRuntimeStatus(host);
  return (
    <View style={styles.field}>
      <Text style={styles.text}>{host.label}</Text>
      {isPending && <Text style={styles.note}>Loading diagnostics…</Text>}
      {error && <Text style={styles.error}>{error.message}</Text>}
      {data && (
        <>
          <Text style={styles.text}>Automations · {data.paused ? "Stopped" : "Running"}</Text>
          <Text style={styles.text}>
            Webhook listener · {data.listening ? "Listening" : "Inactive"}
          </Text>
          <Text style={styles.text}>Queued or running · {data.pending}</Text>
          <Text style={styles.text}>
            Schedules · {data.schedulesEnabled ? "Enabled" : "Disabled"}
          </Text>
          <Text style={styles.note}>
            Readiness checks host configuration, not API permissions. Failed requests appear below.
          </Text>
          {data.integrations.map((integration) => (
            <View key={integration.name} style={styles.field}>
              <Text style={styles.text}>
                {integration.name} · {integration.ready ? "Ready" : "Not ready"}
              </Text>
              <Text style={styles.muted}>{integration.message}</Text>
            </View>
          ))}
          {data.errors.map(({ source, message }) => (
            <Text key={source} accessibilityRole="alert" style={styles.error}>
              {source}: {message}
            </Text>
          ))}
        </>
      )}
    </View>
  );
}

function RunsView({
  theme,
  host,
  openConversation,
  selectedRun,
  workflowFilter,
  selectRun,
  openWorkflow,
  clearFilter,
}: Pick<PluginScreenProps, "theme" | "host"> & {
  openConversation(agentId: string): void;
  selectedRun?: string;
  workflowFilter: string;
  selectRun(id?: string): void;
  openWorkflow(path: string): void;
  clearFilter(): void;
}) {
  const back = useCallback(() => selectRun(), [selectRun]);
  return selectedRun ? (
    <RunDetails
      key={selectedRun}
      theme={theme}
      host={host}
      openConversation={openConversation}
      selectedRun={selectedRun}
      back={back}
      openWorkflow={openWorkflow}
      selectRun={selectRun}
    />
  ) : (
    <RunHistory
      key={workflowFilter}
      theme={theme}
      host={host}
      selectRun={selectRun}
      workflowFilter={workflowFilter}
      clearFilter={clearFilter}
    />
  );
}

function RunDetails({
  theme,
  host,
  openConversation,
  selectedRun,
  back,
  openWorkflow,
  selectRun,
}: Pick<PluginScreenProps, "theme" | "host"> & {
  openConversation(agentId: string): void;
  selectedRun: string;
  back(): void;
  openWorkflow(path: string): void;
  selectRun(id: string): void;
}) {
  const styles = useStyles(theme);
  const get = useRpc(getRunRpc);
  const [tab, setTab] = useState("Overview");
  const run = useQuery({
    queryKey: ["automations", host.id, "run", selectedRun],
    queryFn: () => get({ id: selectedRun }),
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return !status || status === "running" || status === "queued" ? 1_000 : false;
    },
  });
  const edit = useCallback(() => {
    if (run.data) openWorkflow(run.data.path);
  }, [run.data, openWorkflow]);
  const tabs = useMemo(() => {
    return runInspectionTabs(run.data).map((value) => ({ value, label: value }));
  }, [run.data]);
  return (
    <View style={styles.inspector} testID="automations-run-inspector">
      <View style={styles.toolbarGroup}>
        <Button
          size="xs"
          variant="ghost"
          icon="ChevronLeft"
          accessibilityLabel="Back to runs"
          flushStart
          onPress={back}
        >
          Runs
        </Button>
      </View>
      {run.data && <RunHeading run={run.data} styles={styles} />}
      {run.error && (
        <Text accessibilityRole="alert" style={styles.error}>
          {run.error.message}
        </Text>
      )}
      <View style={styles.inspectorTabs}>
        <SegmentedControl options={tabs} value={tab} onValueChange={setTab} size="xs" />
      </View>
      {tab === "Logs" && run.data ? (
        <View style={styles.inspectorLogs}>
          <RunLogs
            output={run.data.output}
            active={run.data.status === "running" || run.data.status === "queued"}
            theme={theme}
          />
        </View>
      ) : (
        <ScrollView>
          {run.data ? (
            <View style={styles.inspectorReading}>
              {tab === "Details" && <RunMetadata run={run.data} styles={styles} edit={edit} />}
              {tab === "Actions" && <RunActions run={run.data} theme={theme} />}
              {tab === "Steps" && run.data.engine && (
                <SettingsSection title="Scripted steps">
                  <View style={styles.contextEditor}>
                    <CodeEditor
                      language="json"
                      label="Recorded steps"
                      value={JSON.stringify(run.data.engine.steps, null, 2)}
                      readOnly
                    />
                  </View>
                </SettingsSection>
              )}
              {tab === "Overview" && (
                <RunSummary
                  run={run.data}
                  styles={styles}
                  openConversation={openConversation}
                  edit={edit}
                  selectRun={selectRun}
                />
              )}
            </View>
          ) : (
            <Text style={run.error ? styles.error : styles.note}>
              {run.error?.message ?? "Loading run…"}
            </Text>
          )}
        </ScrollView>
      )}
    </View>
  );
}

type AutomationRun = (typeof getRunRpc.output)["_output"];
function runInspectionTabs(run: AutomationRun | undefined) {
  const tabs = ["Overview", "Logs", "Details"];
  if (run?.engine?.steps.length) tabs.push("Steps");
  if (
    run &&
    (run.engine?.actions.length || run.action || run.actionError || run.actionAttempts.length)
  )
    tabs.push("Actions");
  return tabs;
}
function RunActions({ run, theme }: { run: AutomationRun; theme: PluginTheme }) {
  const styles = useStyles(theme);
  if (run.engine)
    return (
      <SettingsSection title="Safe Actions">
        <View style={styles.contextEditor}>
          <CodeEditor
            language="json"
            label="Recorded Safe Actions"
            value={JSON.stringify(run.engine.actions, null, 2)}
            readOnly
          />
        </View>
      </SettingsSection>
    );
  return (
    <View>
      {run.actionError && <Text style={styles.error}>{run.actionError}</Text>}
      <Text style={styles.note}>
        Legacy Safe Action proposals are read-only. Review their external state before starting a
        new engine run.
      </Text>
      {run.action && (
        <View style={styles.contextEditor}>
          <CodeEditor
            language="json"
            label="Legacy Safe Action"
            value={JSON.stringify(run.action, null, 2)}
            readOnly
          />
        </View>
      )}
      <ActionAudit attempts={run.actionAttempts} styles={styles} />
    </View>
  );
}
function ActionAudit({
  attempts,
  styles,
}: {
  attempts: AutomationRun["actionAttempts"];
  styles: Styles;
}) {
  return (
    <View style={styles.section}>
      {attempts.map((attempt) => (
        <Text key={attempt.id} style={styles.text}>
          {new Date(attempt.at).toLocaleString()} · {attempt.status}
          {attempt.message ? ` · ${attempt.message}` : ""}
        </Text>
      ))}
    </View>
  );
}
function runStatus(run: AutomationRun) {
  return run.sourceStatus ?? (run.status === "succeeded" ? "completed" : run.status);
}
function runStatusStyle(run: AutomationRun, styles: Styles) {
  const tone = runStatusTone(run);
  if (tone === "success") return styles.runSuccess;
  if (tone === "warning") return styles.runWarning;
  if (tone === "danger") return styles.runFailure;
  return styles.runStatus;
}
function RunHeading({ run, styles }: { run: AutomationRun; styles: Styles }) {
  const result = inspectRunResult(run);
  const title =
    run.name === run.path || run.trigger === "imported"
      ? run.path
          .split("/")
          .at(-1)
          ?.replace(/\.(md|ya?ml)$/i, "")
      : run.name;
  return (
    <View style={styles.runHeading}>
      <Text selectable accessibilityRole="header" style={styles.runTitle}>
        {title}
      </Text>
      <View style={styles.metadata}>
        <Text style={runStatusStyle(run, styles)}>{runStatus(run)}</Text>
        {(result?.outcome ?? run.outcome) && (
          <Text style={styles.metadataText}>{result?.outcome ?? run.outcome}</Text>
        )}
        <Text style={styles.metadataText}>{run.repository ?? "Scratch workspace"}</Text>
        <Text style={styles.metadataText}>{new Date(run.createdAt).toLocaleString()}</Text>
        {run.finishedAt && (
          <Text style={styles.metadataText}>
            Updated {new Date(run.finishedAt).toLocaleTimeString()}
          </Text>
        )}
      </View>
    </View>
  );
}
function RunMetadata({ run, styles, edit }: { run: AutomationRun; styles: Styles; edit(): void }) {
  const [contextOpen, setContextOpen] = useState(false);
  const toggleContext = useCallback(() => setContextOpen((value) => !value), []);
  const trigger = JSON.stringify(
    run.engine?.event ?? {
      type: run.trigger,
      scheduledFor: run.scheduledFor,
      repository: run.repository,
      revision: run.revision,
    },
    null,
    2,
  );
  const result = inspectRunResult(run);
  return (
    <View>
      <SettingsSection title="Execution">
        <SettingsCard>
          <SettingsRow label="Workflow" hint={run.repository ?? "Scratch workspace"}>
            <Button variant="outline" onPress={edit}>
              Open current workflow
            </Button>
          </SettingsRow>
          <SettingsRow label="Status" hint={run.path}>
            <Text style={runStatusStyle(run, styles)}>{runStatus(run)}</Text>
          </SettingsRow>
          <SettingsRow label="Run ID" hint={run.importedId ?? run.id}>
            <Text style={styles.metadataText}>
              {run.agentId || /\.md$/i.test(run.path) ? "Agent workflow" : "Scripted steps"}
            </Text>
          </SettingsRow>
          <SettingsRow label="Outcome">
            <Text style={styles.metadataText}>
              {result?.outcome ?? run.outcome ?? "Not recorded"}
            </Text>
          </SettingsRow>
          <SettingsRow
            label={run.finishedAt ? "Last updated" : "Created"}
            hint={`Created ${new Date(run.createdAt).toLocaleString()}`}
          >
            <Text style={styles.metadataText}>
              {new Date(run.finishedAt ?? run.createdAt).toLocaleString()}
            </Text>
          </SettingsRow>
          {run.revision && (
            <SettingsRow label="Revision">
              <Text selectable style={styles.metadataText}>
                {run.revision}
              </Text>
            </SettingsRow>
          )}
        </SettingsCard>
      </SettingsSection>
      <View style={styles.toolbarGroup}>
        <Button
          size="xs"
          variant="ghost"
          icon={contextOpen ? "ChevronDown" : "ChevronRight"}
          onPress={toggleContext}
        >
          Trigger context
        </Button>
      </View>
      {contextOpen && (
        <View style={styles.contextEditor}>
          <CodeEditor language="json" label="Trigger context" value={trigger} readOnly />
        </View>
      )}
      {run.engine?.workspace && (
        <SettingsSection title="Workspace attestations">
          <View style={styles.contextEditor}>
            <CodeEditor
              language="json"
              label="Workspace attestations"
              value={JSON.stringify(run.engine.workspace, null, 2)}
              readOnly
            />
          </View>
        </SettingsSection>
      )}
    </View>
  );
}
function RunSummary({
  run,
  styles,
  openConversation,
  edit,
  selectRun,
}: {
  openConversation(agentId: string): void;
  run: AutomationRun;
  styles: Styles;
  edit(): void;
  selectRun(id: string): void;
}) {
  const result = inspectRunResult(run);
  const notes = [...new Set(result?.verification ?? [])];
  const unresolved = [
    ...new Set([...(result?.unresolved ?? []), ...(run.error ? [run.error] : [])]),
  ];
  const summary = runOverviewSummary(run);
  return (
    <View style={styles.section}>
      <SettingsSection title="Result">
        <SettingsCard>
          <View style={styles.cardBody}>
            <Markdown>{summary}</Markdown>
          </View>
        </SettingsCard>
      </SettingsSection>
      {notes.length > 0 && (
        <SettingsSection title={`Notes (${notes.length})`}>
          <SettingsCard>
            <View style={styles.cardBody}>
              <Text style={styles.metadataText}>
                Workflow-reported checks, not independently verified.
              </Text>
              {notes.map((note) => (
                <Text key={note} selectable style={styles.resultText}>
                  • {note}
                </Text>
              ))}
            </View>
          </SettingsCard>
        </SettingsSection>
      )}
      {run.engine && run.engine.verification.length > 0 && (
        <SettingsSection title="Executed verification">
          <View style={styles.contextEditor}>
            <CodeEditor
              language="json"
              label="Executed verification"
              value={JSON.stringify(run.engine.verification, null, 2)}
              readOnly
            />
          </View>
        </SettingsSection>
      )}
      {unresolved.length > 0 && (
        <SettingsSection title="Needs attention">
          <SettingsCard>
            <View style={styles.cardBody}>
              {unresolved.map((note) => (
                <Text key={note} selectable style={styles.resultText}>
                  {note}
                </Text>
              ))}
            </View>
          </SettingsCard>
        </SettingsSection>
      )}
      <RunControls
        run={run}
        styles={styles}
        openConversation={openConversation}
        edit={edit}
        selectRun={selectRun}
      />
    </View>
  );
}

function RunControls({
  run,
  styles,
  openConversation,
  edit,
  selectRun,
}: Parameters<typeof RunSummary>[0]) {
  const start = useRpc(startRunRpc);
  const replay = useRpc(replayRunRpc);
  const cancel = useRpc(cancelRunRpc);
  const cancelOperation = useMutation({
    mutationFn: () => cancel({ id: run.id, reason: "Cancelled from Mixer Automations" }),
  });
  const cancelRun = useCallback(() => cancelOperation.mutate(), [cancelOperation]);
  const rerun = useMutation({
    mutationFn: async () => {
      const result = run.engine
        ? await replay({ id: run.id, workflow: "current" })
        : await start({ path: run.path });
      selectRun(result.id);
    },
  });
  const runLatest = useCallback(() => rerun.mutate(), [rerun]);
  const original = useMutation({
    mutationFn: async () => {
      const result = await replay({ id: run.id, workflow: "snapshot" });
      selectRun(result.id);
    },
  });
  const runOriginal = useCallback(() => original.mutate(), [original]);
  const openAgent = useCallback(() => {
    if (run.agentId) openConversation(run.agentId);
  }, [run.agentId, openConversation]);
  const active = run.status === "running" || run.status === "queued";
  const error = rerun.error ?? original.error ?? cancelOperation.error;
  return (
    <SettingsSection title={active ? "Run controls" : "Run again"}>
      <View style={styles.toolbarGroup}>
        {run.engine && !active && (
          <Button
            size="xs"
            variant="outline"
            disabled={original.isPending}
            loading={original.isPending}
            onPress={runOriginal}
          >
            Rerun original workflow
          </Button>
        )}
        {run.engine && active && (
          <Button
            size="xs"
            variant="outline"
            disabled={cancelOperation.isPending}
            loading={cancelOperation.isPending}
            onPress={cancelRun}
          >
            Cancel run
          </Button>
        )}
        <Button
          size="xs"
          variant="outline"
          icon="Play"
          disabled={active || rerun.isPending}
          loading={rerun.isPending}
          onPress={runLatest}
        >
          Run latest workflow
        </Button>
        {run.agentId && <Action label="Open agent" onPress={openAgent} />}
        <Button size="xs" variant="ghost" onPress={edit}>
          Open current workflow
        </Button>
      </View>
      {error && (
        <Text accessibilityRole="alert" style={styles.error}>
          {error.message}
        </Text>
      )}
    </SettingsSection>
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
  clearFilter,
}: Pick<PluginScreenProps, "theme" | "host"> & {
  selectRun(id: string): void;
  workflowFilter: string;
  clearFilter(): void;
}) {
  const styles = useStyles(theme);
  const list = useRpc(listRunsRpc);
  const [filter, setFilter] = useState("");
  const { data, error, isPending, dataUpdatedAt } = useQuery({
    queryKey: ["automations", host.id, "runs"],
    queryFn: () => list({}),
    refetchInterval: 2_000,
  });
  const rows = data?.runs.filter(
    (item) =>
      (!workflowFilter || item.path === workflowFilter) &&
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
      {!!workflowFilter && (
        <View style={styles.toolbarGroup}>
          <Text style={styles.text}>{workflowFilter}</Text>
          <Button size="xs" variant="ghost" onPress={clearFilter}>
            Clear workflow filter
          </Button>
        </View>
      )}
      <View style={styles.field}>
        <Text style={styles.fieldLabel}>Filter runs</Text>
        <TextInput
          accessibilityLabel="Filter runs"
          placeholderTextColor={theme.colors.foregroundMuted}
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
              <View style={styles.runDisclosure} />
            </View>
            {rows?.map((item) => (
              <RunRow
                key={item.id}
                item={item}
                selectRun={selectRun}
                styles={styles}
                now={dataUpdatedAt}
                theme={theme}
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
  mono,
}: {
  value: string;
  width?: number;
  weight?: number;
  tone?: "success" | "warning" | "danger" | "muted";
  styles: Styles;
  heading?: boolean;
  mono?: boolean;
}) {
  const style = useMemo(
    () => [
      styles.text,
      heading && styles.tableHeader,
      mono && styles.runId,
      tone && styles[tone],
      {
        width,
        flex: width === undefined ? (weight ?? 1) : undefined,
        minWidth: 0,
        paddingVertical: 8,
      },
    ],
    [heading, mono, styles, tone, weight, width],
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
  theme,
}: {
  item: (typeof listRunsRpc.output)["_output"]["runs"][number];
  selectRun(id: string): void;
  styles: Styles;
  now: number;
  theme: PluginTheme;
}) {
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const enter = useCallback(() => setHovered(true), []);
  const leave = useCallback(() => setHovered(false), []);
  const focus = useCallback(() => setFocused(true), []);
  const blur = useCallback(() => setFocused(false), []);
  const rowStyle = useCallback(
    ({ pressed }: PressableStateCallbackType) => [
      styles.runRow,
      hovered && styles.runRowHover,
      focused && styles.runRowFocus,
      pressed && styles.runRowPressed,
    ],
    [styles, hovered, focused],
  );
  const disclosureStyle = useMemo(
    () => [styles.runDisclosure, !hovered && !focused && styles.runDisclosureHidden],
    [styles, hovered, focused],
  );
  const open = useCallback(() => selectRun(item.id), [item.id, selectRun]);
  const status = item.sourceStatus ?? (item.status === "succeeded" ? "completed" : item.status);
  const values = [
    item.name,
    item.repository ?? "—",
    item.importedId ?? item.id,
    status,
    item.outcome ?? "—",
    relativeAge(item.createdAt, now),
  ];
  const statusTone = runStatusTone(item);
  const tones = [undefined, "muted", "muted", statusTone, "muted", "muted"] as const;
  return (
    <View style={styles.runRowTarget} onPointerEnter={enter} onPointerLeave={leave}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Inspect ${item.name}, ${item.status}`}
        onPress={open}
        onFocus={focus}
        onBlur={blur}
        style={rowStyle}
      >
        {runColumns.map(({ label, weight }, index) => (
          <TableCell
            key={label}
            value={values[index]}
            weight={weight}
            tone={tones[index]}
            mono={label === "Run"}
            styles={styles}
          />
        ))}
        <View style={disclosureStyle}>
          <Icon name="ChevronRight" size={16} color={theme.colors.foregroundMuted} />
        </View>
      </Pressable>
    </View>
  );
}

function relativeAge(created: number, now: number) {
  const minutes = Math.max(0, Math.floor((now - created) / 60_000));
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`;
}

export function AutomationsSettings({
  theme,
  onOpenConfiguration,
}: Pick<PluginSurfaceProps, "theme"> & { onOpenConfiguration?(): void }) {
  const configuration = useConfiguration();
  const styles = useStyles(theme);
  if (configuration.isPending)
    return <Text style={styles.note}>Loading Automations configuration…</Text>;
  if (configuration.error)
    return (
      <Text accessibilityRole="alert" style={styles.error}>
        {configuration.error.message}
      </Text>
    );
  if (configuration.data?.fileConfigured)
    return (
      <View style={styles.settings}>
        <Text style={styles.text}>
          This host uses automations/config.json. File configuration takes precedence over plugin
          settings.
        </Text>
        <Text style={styles.note}>
          Edit config.json in the Automations sidebar to configure GitHub, Jira, environment values,
          runtime limits, and retention. Environment references resolve on this host.
        </Text>
        <Text style={styles.note}>
          Workflow execution uses the bundled Mixer Automations engine, including its workspace
          lifecycle, Safe Action policies, and publication guards. Restart Automations after editing
          configuration.
        </Text>
        {onOpenConfiguration && (
          <Button size="sm" variant="outline" onPress={onOpenConfiguration}>
            Open config.json
          </Button>
        )}
        {configuration.data.error && (
          <Text accessibilityRole="alert" style={styles.error}>
            {configuration.data.error}
          </Text>
        )}
        <RoboPlaneImport theme={theme} />
      </View>
    );
  return <LegacyAutomationSettings theme={theme} />;
}

function LegacyAutomationSettings({ theme }: Pick<PluginSurfaceProps, "theme">) {
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
        onPress={toggleSchedules}
      />
      <Text style={styles.text}>Integrations</Text>
      <Text style={styles.note}>
        Safe Actions require confirmation in Runs. They do not restrict writes through other agent
        tools or credentials.
      </Text>
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
        label={settings.saving ? "Saving…" : "Save"}
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
