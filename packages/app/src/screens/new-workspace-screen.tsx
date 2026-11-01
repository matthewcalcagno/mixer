import { useCallback, useMemo, useRef, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { PressHighlight } from "@/components/ui/press-highlight";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Monitor, Plus } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { MenuHeader } from "@/components/headers/menu-header";
import {
  SelectField,
  SelectFieldTrigger,
  type SelectFieldRenderOptionInput,
} from "@/components/ui/select-field";
import { Field } from "@/components/ui/form-field";
import { Combobox } from "@/components/ui/combobox";
import { Button } from "@/components/ui/button";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useOpenAddProject } from "@/hooks/use-open-add-project";
import { HostPicker } from "@/components/hosts/host-picker";
import { useHosts } from "@/runtime/host-runtime";
import { router } from "expo-router";
import { buildSettingsAddHostRoute } from "@/utils/host-routes";
import { NewWorkspaceSetupSurface } from "./new-workspace/setup-surface";
import { useWorkspaceSetupForm, type WorkspaceSetupRoute } from "./new-workspace/use-setup-form";
import type { WorkspaceIsolation } from "./new-workspace/setup-form-model";
import { ProjectIcon, branchIcon, folderIcon } from "./new-workspace/form/icons";
import { ProjectOption, IsolationOption } from "./new-workspace/form/options";
import { buildNewWorkspaceProjectIconTargets } from "./new-workspace/project-icon-targets";
import { useProjectIcons } from "@/projects/icons";
import { HostStatusDot } from "@/components/host-status-dot";
import { settingsStyles } from "@/styles/settings";
import { ICON_SIZE, type Theme } from "@/styles/theme";

type SetupController = ReturnType<typeof useWorkspaceSetupForm>;
const ThemedMonitor = withUnistyles(Monitor);
const mutedColor = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const monitorIcon = <ThemedMonitor size={ICON_SIZE.md} uniProps={mutedColor} />;

function ProjectField({ form, size }: { form: SetupController; size: "sm" | "md" }) {
  const { t } = useTranslation();
  const { state, model } = form;
  const targets = useMemo(
    () => buildNewWorkspaceProjectIconTargets(state.projects, state.serverId),
    [state.projects, state.serverId],
  );
  const icons = useProjectIcons({ projects: targets });
  const projects = useMemo(
    () =>
      state.projects.map((project) => ({
        id: project.viewKey,
        value: project.viewKey,
        label: project.projectName,
      })),
    [state.projects],
  );
  const byKey = useMemo(
    () => new Map(state.projects.map((project) => [project.viewKey, project])),
    [state.projects],
  );
  const pending = state.submission.status === "pending";
  const leading = useMemo(
    () => (
      <View style={styles.fieldIcon} testID="new-workspace-project-icon">
        {state.project ? (
          <ProjectIcon
            projectViewKey={state.project.viewKey}
            projectName={state.project.projectName}
            iconDataUri={icons.get(state.project.viewKey) ?? null}
          />
        ) : (
          folderIcon
        )}
      </View>
    ),
    [state.project, icons],
  );
  const renderOption = useCallback(
    (input: SelectFieldRenderOptionInput<string>) => {
      const project = byKey.get(input.option.value);
      return (
        <ProjectOption
          {...input}
          project={project}
          iconDataUri={project ? (icons.get(project.viewKey) ?? null) : null}
          selectedServerId={state.serverId}
          disabled={pending}
        />
      );
    },
    [byKey, icons, state.serverId, pending],
  );
  return (
    <SelectField
      label={t("newWorkspace.fields.project")}
      value={state.project?.viewKey ?? null}
      selectedDisplay={state.projectDisplay}
      options={projects}
      onChange={model.selectProject}
      placeholder={t("newWorkspace.tooltips.project")}
      emptyText="No projects available."
      searchable
      searchPlaceholder="Search projects"
      size={size}
      disabled={pending}
      triggerLeading={leading}
      renderOption={renderOption}
      triggerTestID="new-workspace-project-picker-trigger"
    />
  );
}

function HostField({ form, size }: { form: SetupController; size: "sm" | "md" }) {
  const { t } = useTranslation();
  const hosts = useHosts();
  const { model } = form;
  const anchor = useRef<View | null>(null);
  const [open, setOpen] = useState(false);
  const show = useCallback(() => setOpen(true), []);
  const select = useCallback(
    (serverId: string) => {
      const host = hosts.find((candidate) => candidate.serverId === serverId);
      if (host) model.selectHost(serverId, { label: host.label });
      setOpen(false);
    },
    [hosts, model],
  );
  const addHost = useCallback(() => router.push(buildSettingsAddHostRoute(Date.now())), []);
  const pending = form.state.submission.status === "pending";
  const serverId = form.state.serverId;
  const leading = useMemo(
    () => (
      <View style={styles.fieldIcon} testID="new-workspace-host-status">
        {serverId ? <HostStatusDot serverId={serverId} /> : monitorIcon}
      </View>
    ),
    [serverId],
  );
  return (
    <Field label={t("newWorkspace.fields.host")}>
      <HostPicker
        hosts={hosts}
        value={form.state.serverId}
        onSelect={select}
        open={open}
        onOpenChange={setOpen}
        anchorRef={anchor}
        includeAddHost
        onAddHost={addHost}
        searchable
        desktopPlacement="bottom-start"
        addHostTestID="new-workspace-host-picker-add-host"
      >
        <PressHighlight
          ref={anchor}
          accessibilityRole="button"
          accessibilityLabel={t("newWorkspace.fields.host")}
          onPress={show}
          disabled={pending}
          testID="host-picker-trigger"
        >
          <SelectFieldTrigger
            display={form.state.hostDisplay}
            placeholder={t("newWorkspace.tooltips.host")}
            size={size}
            active={open}
            disabled={pending}
            leading={leading}
          />
        </PressHighlight>
      </HostPicker>
    </Field>
  );
}

function BranchField({
  form,
  size,
  base = false,
}: {
  form: SetupController;
  size: "sm" | "md";
  base?: boolean;
}) {
  const { t } = useTranslation();
  const anchor = useRef<View | null>(null);
  const picker = base ? form.basePicker : form.branchPicker;
  const { setOpen } = picker;
  const open = useCallback(() => setOpen(true), [setOpen]);
  const pending = form.state.submission.status === "pending";
  return (
    <Field
      label={t(base ? "newWorkspace.refPicker.baseBranch" : "newWorkspace.fields.branch")}
      error={picker.error}
      testID={base ? "new-workspace-base-branch-field" : "new-workspace-branch-field"}
    >
      <PressHighlight
        ref={anchor}
        accessibilityRole="button"
        accessibilityLabel={t(
          base ? "newWorkspace.refPicker.baseBranch" : "newWorkspace.refPicker.startingRef",
        )}
        onPress={open}
        disabled={pending}
        testID={base ? "new-workspace-base-branch-trigger" : "new-workspace-ref-picker-trigger"}
      >
        <SelectFieldTrigger
          display={picker.display}
          placeholder={t(
            base ? "newWorkspace.refPicker.chooseBaseBranch" : "newWorkspace.refPicker.title",
          )}
          size={size}
          active={picker.open}
          disabled={pending}
          leading={branchLeading}
        />
      </PressHighlight>
      <Combobox
        options={picker.options}
        value={picker.value}
        onSelect={picker.choose}
        open={picker.open}
        onOpenChange={picker.setOpen}
        anchorRef={anchor}
        searchable
        onSearchQueryChange={picker.setSearch}
        searchPlaceholder={t("newWorkspace.refPicker.searchPlaceholder")}
        title={t(base ? "newWorkspace.refPicker.baseBranch" : "newWorkspace.refPicker.title")}
        emptyText={
          picker.loading
            ? t("newWorkspace.refPicker.searching")
            : t("newWorkspace.refPicker.noMatchingRefs")
        }
        desktopPlacement="bottom-start"
      />
    </Field>
  );
}

function SetupFields({
  form,
  size,
  compact,
}: {
  form: SetupController;
  size: "sm" | "md";
  compact: boolean;
}) {
  const { t } = useTranslation();
  const { state } = form;
  const pending = state.submission.status === "pending";
  const isolationOptions = useMemo(() => {
    const options: {
      id: WorkspaceIsolation;
      value: WorkspaceIsolation;
      label: string;
      testID: string;
    }[] = [
      {
        id: "worktree",
        value: "worktree",
        label: t("newWorkspace.isolation.worktree"),
        testID: "workspace-create-isolation-worktree",
      },
    ];
    if (state.hosts.find((host) => host.serverId === state.serverId)?.supportsLocal)
      options.unshift({
        id: "local",
        value: "local",
        label: t("newWorkspace.isolation.local"),
        testID: "workspace-create-isolation-local",
      });
    return options;
  }, [state.hosts, state.serverId, t]);
  const isolationDisplay = useMemo(
    () => ({
      label: t(
        state.isolation === "worktree"
          ? "newWorkspace.isolation.worktree"
          : "newWorkspace.isolation.local",
      ),
    }),
    [state.isolation, t],
  );
  const renderIsolation = useCallback(
    (input: SelectFieldRenderOptionInput<WorkspaceIsolation>) => (
      <IsolationOption {...input} disabled={pending} />
    ),
    [pending],
  );
  return (
    <View style={styles.cardBody}>
      <ProjectField form={form} size={size} />
      <View style={[styles.details, !compact && styles.detailsWide]}>
        <View style={!compact && styles.hostCell}>
          <HostField form={form} size={size} />
        </View>
        {state.showIsolation && (
          <View style={!compact && styles.isolationCell}>
            <SelectField
              label={t("newWorkspace.isolation.label")}
              value={state.isolation}
              selectedDisplay={isolationDisplay}
              options={isolationOptions}
              onChange={form.selectIsolation}
              placeholder={t("newWorkspace.tooltips.isolation")}
              emptyText=""
              size={size}
              disabled={pending}
              triggerLeading={state.isolation === "worktree" ? branchLeading : localLeading}
              renderOption={renderIsolation}
              triggerTestID="workspace-create-isolation-trigger"
            />
          </View>
        )}
      </View>
      {state.showBranch && (
        <View style={[styles.details, !compact && styles.detailsWide]}>
          <View style={!compact && styles.hostCell}>
            <BranchField form={form} size={size} />
          </View>
          {state.showBaseBranch && (
            <View style={!compact && styles.isolationCell}>
              <BranchField form={form} size={size} base />
            </View>
          )}
        </View>
      )}
      {state.submission.status === "error" && (
        <Text accessibilityRole="alert" style={styles.error} testID="new-workspace-setup-error">
          {state.submission.message}
        </Text>
      )}
    </View>
  );
}

export function NewWorkspaceScreen(route: WorkspaceSetupRoute) {
  const { t } = useTranslation();
  const compact = useIsCompactFormFactor();
  const form = useWorkspaceSetupForm(route);
  const { state } = form;
  const size = compact ? "md" : "sm";
  const pending = state.submission.status === "pending";
  const openAddProject = useOpenAddProject();
  const addProject = useCallback(() => {
    void openAddProject(state.serverId || undefined);
  }, [openAddProject, state.serverId]);
  return (
    <NewWorkspaceSetupSurface isCompact={compact}>
      <View style={styles.page} testID="new-workspace-setup-screen">
        <MenuHeader borderless />
        <ScrollView contentContainerStyle={[styles.viewport, compact && styles.compactViewport]}>
          <View style={styles.form} testID="new-workspace-setup-form">
            <Text style={styles.title}>{t("newWorkspace.title")}</Text>
            <View style={settingsStyles.card} testID="new-workspace-setup-card">
              <SetupFields form={form} size={size} compact={compact} />
              <View style={[styles.actions, settingsStyles.rowBorder]}>
                {state.projects.length === 0 ? (
                  <Button variant="outline" size={size} onPress={addProject}>
                    {t("sidebar.actions.addProject")}
                  </Button>
                ) : null}
                <Button
                  variant="default"
                  size={size}
                  leftIcon={Plus}
                  onPress={form.submit}
                  disabled={!state.canSubmit}
                  loading={pending}
                  testID="workspace-create-submit"
                >
                  {t("newWorkspace.create")}
                </Button>
              </View>
            </View>
          </View>
        </ScrollView>
      </View>
    </NewWorkspaceSetupSurface>
  );
}

const styles = StyleSheet.create((theme) => ({
  page: { flex: 1, minHeight: 0, backgroundColor: theme.colors.surface0 },
  viewport: {
    flexGrow: 1,
    justifyContent: "center",
    alignItems: "center",
    padding: theme.spacing[6],
  },
  compactViewport: { justifyContent: "flex-start" },
  form: { width: "100%", maxWidth: 560, gap: theme.spacing[3] },
  cardBody: { padding: theme.spacing[4], gap: theme.spacing[4] },
  details: { gap: theme.spacing[4] },
  detailsWide: { flexDirection: "row" },
  hostCell: { flex: 1.4, minWidth: 0 },
  isolationCell: { flex: 1, minWidth: 0 },
  fieldIcon: {
    width: ICON_SIZE.md,
    height: ICON_SIZE.md,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  title: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize["2xl"],
    fontWeight: theme.fontWeight.normal,
    paddingLeft: theme.spacing[4],
  },
  error: { color: theme.colors.statusDanger, fontSize: theme.fontSize.sm },
  actions: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[3],
  },
}));

const branchLeading = <View style={styles.fieldIcon}>{branchIcon}</View>;
const localLeading = <View style={styles.fieldIcon}>{folderIcon}</View>;
