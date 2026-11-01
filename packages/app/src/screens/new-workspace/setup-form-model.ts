import type { CreateWorkspaceRequestOptions } from "@mixer/client/internal/daemon-client";
import {
  filterWorkspaceProjectsForHost,
  getHostProjectId,
  getHostProjectSourceDirectory,
  getWorktreeSupportForHostProject,
  resolveHostProjectCandidate,
  resolveInitialWorkspaceProject,
  type HostProjectListItem,
} from "@/projects/host-project-model";
import {
  resolveNewWorkspaceInitialServerId,
  resolveNewWorkspaceAutomaticServerId,
  type NewWorkspaceInitialServerInput,
} from "../new-workspace-initial-context";

export type WorkspaceIsolation = "local" | "worktree";
export interface SetupHost {
  serverId: string;
  label: string;
  connected: boolean;
  ready: boolean;
  supportsLocal: boolean;
}

function connectionStatus(host: SetupHost): "online" | "offline" | "connecting" {
  if (host.connected) return "online";
  if (host.ready) return "offline";
  return "connecting";
}
export interface SetupDisplay {
  label: string;
}
export interface SetupBranchReference {
  name: string;
  display: SetupDisplay;
}
export type SetupBranch =
  | (SetupBranchReference & { kind: "existing" })
  | (SetupBranchReference & { kind: "new"; base: SetupBranchReference | null });

function branchFields(branch: SetupBranch | null, visible: boolean) {
  if (!visible) return { showBaseBranch: false, ready: true };
  if (!branch) return { showBaseBranch: false, ready: false };
  if (branch.kind === "existing") return { showBaseBranch: false, ready: true };
  return { showBaseBranch: true, ready: branch.base !== null };
}
export interface WorkspaceSetupSnapshot {
  hosts: readonly SetupHost[];
  projects: readonly HostProjectListItem[];
  initialServerId: string;
  routeProject: HostProjectListItem | null;
  lastProject: HostProjectListItem | null;
  isolation: WorkspaceIsolation;
}
type Submission = { status: "idle" } | { status: "pending" } | { status: "error"; message: string };
export interface WorkspaceSetupState {
  serverId: string;
  hostDisplay: SetupDisplay | null;
  project: HostProjectListItem | null;
  projectDisplay: SetupDisplay | null;
  projectId: string | null;
  directory: string | null;
  scopeKey: string;
  hosts: readonly SetupHost[];
  projects: HostProjectListItem[];
  isolation: WorkspaceIsolation;
  showIsolation: boolean;
  showBranch: boolean;
  showBaseBranch: boolean;
  branch: SetupBranch | null;
  submission: Submission;
  canSubmit: boolean;
}
export interface WorkspaceSetupPlan {
  serverId: string;
  request: CreateWorkspaceRequestOptions;
}

export class WorkspaceSetupForm {
  private snapshot: WorkspaceSetupSnapshot;
  private serverId = "";
  private project: HostProjectListItem | null = null;
  private projectIntent: HostProjectListItem | null = null;
  private projectDisplay: SetupDisplay | null = null;
  private hostDisplay: SetupDisplay | null = null;
  private isolation: WorkspaceIsolation;
  private branch: SetupBranch | null = null;
  private defaultBranch: string | null = null;
  private manualHost = false;
  private manualProject = false;
  private manualIsolation = false;
  private manualBranch = false;
  private submission: Submission = { status: "idle" };
  private listeners = new Set<() => void>();
  private closed = false;
  private state: WorkspaceSetupState;
  private lastSourceFingerprint: string | null = null;
  private attempt = 0;
  private preferredProjectKey = "";

  constructor(
    snapshot: WorkspaceSetupSnapshot,
    private idempotencyKey: string,
  ) {
    this.snapshot = snapshot;
    this.isolation = snapshot.isolation;
    this.reconcile();
    this.state = this.derive();
  }
  getState = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  close = () => {
    this.closed = true;
    this.listeners.clear();
  };
  applySnapshot = (snapshot: WorkspaceSetupSnapshot) => {
    const previousScope = this.state.scopeKey;
    this.snapshot = snapshot;
    if (!this.manualIsolation) this.isolation = snapshot.isolation;
    this.reconcile();
    this.resetBranchForScope(previousScope);
    this.publish();
  };
  selectHost = (serverId: string, display: SetupDisplay) => {
    const previousScope = this.state.scopeKey;
    this.manualHost = true;
    this.serverId = serverId;
    this.hostDisplay = display;
    this.reconcile();
    this.resetBranchForScope(previousScope);
    this.publish();
  };
  selectProject = (viewKey: string, display: SetupDisplay) => {
    const project = this.state.projects.find((candidate) => candidate.viewKey === viewKey);
    if (!project) return;
    const sameProject = project.viewKey === this.project?.viewKey;
    this.manualProject = true;
    this.project = project;
    this.projectIntent = project;
    this.projectDisplay = display;
    if (!sameProject) {
      this.defaultBranch = null;
      this.branch = null;
      this.manualBranch = false;
    }
    this.submission = { status: "idle" };
    this.publish();
  };
  selectIsolation = (isolation: WorkspaceIsolation) => {
    this.manualIsolation = true;
    this.isolation = isolation;
    this.submission = { status: "idle" };
    this.publish();
  };
  selectBranch = (name: string, display: SetupDisplay) => {
    this.manualBranch = true;
    this.branch = { kind: "existing", name, display };
    this.submission = { status: "idle" };
    this.publish();
  };
  selectNewBranch = (name: string, display: SetupDisplay) => {
    this.manualBranch = true;
    let base: SetupBranchReference | null = this.defaultBranch
      ? { name: this.defaultBranch, display: { label: this.defaultBranch } }
      : null;
    if (this.branch?.kind === "new") base = this.branch.base;
    this.branch = { kind: "new", name, display, base };
    this.submission = { status: "idle" };
    this.publish();
  };
  selectBaseBranch = (name: string, display: SetupDisplay) => {
    if (this.branch?.kind !== "new") return;
    this.branch = { ...this.branch, base: { name, display } };
    this.submission = { status: "idle" };
    this.publish();
  };
  applyCurrentBranch = (scopeKey: string, name: string | null) => {
    if (scopeKey !== this.state.scopeKey || !name) return;
    if (this.manualBranch || this.branch?.name === name) return;
    this.branch = { kind: "existing", name, display: { label: name } };
    this.publish();
  };
  applyDefaultBranch = (scopeKey: string, name: string | null) => {
    if (scopeKey !== this.state.scopeKey || !name) return;
    this.defaultBranch = name;
    if (this.branch?.kind !== "new" || this.branch.base) return;
    this.branch = { ...this.branch, base: { name, display: { label: name } } };
    this.publish();
  };
  beginSubmission = (): WorkspaceSetupPlan | null => {
    const state = this.state;
    if (!state.canSubmit || !state.projectId || !state.directory) return null;
    const source = this.creationSource(state.projectId, state.directory);
    if (!source) return null;
    const fingerprint = JSON.stringify({ serverId: state.serverId, source });
    if (this.lastSourceFingerprint !== null && this.lastSourceFingerprint !== fingerprint)
      this.attempt++;
    this.lastSourceFingerprint = fingerprint;
    this.submission = { status: "pending" };
    this.publish();
    return {
      serverId: state.serverId,
      request: {
        idempotencyKey:
          this.attempt === 0 ? this.idempotencyKey : `${this.idempotencyKey}:${this.attempt}`,
        source,
      },
    };
  };
  private creationSource(
    projectId: string,
    directory: string,
  ): CreateWorkspaceRequestOptions["source"] | null {
    if (!this.state.showBranch) return { kind: "directory", path: directory, projectId };
    if (!this.branch) return null;
    const source = {
      kind: "worktree",
      cwd: directory,
      projectId,
    } satisfies CreateWorkspaceRequestOptions["source"];
    if (this.branch.kind === "existing")
      return { ...source, action: "checkout", refName: this.branch.name };
    if (!this.branch.base) return null;
    return {
      ...source,
      action: "branch-off",
      branchName: this.branch.name,
      refName: this.branch.base.name,
    };
  }
  fail = (message: string) => {
    this.submission = { status: "error", message };
    this.publish();
  };
  complete = () => {
    this.submission = { status: "idle" };
    this.publish();
  };

  private reconcile() {
    this.reconcileHost();
    this.reconcileProject();
  }
  private reconcileHost() {
    const hosts = this.snapshot.hosts;
    if (!this.manualHost || !hosts.some((host) => host.serverId === this.serverId)) {
      const input: NewWorkspaceInitialServerInput = {
        allServerIds: hosts.map((host) => host.serverId),
        routeServerId: this.snapshot.initialServerId,
        projects: this.snapshot.projects,
        lastActiveProject: this.snapshot.lastProject,
        hostConnectionStatusByServerId: new Map(
          hosts.map((host) => [host.serverId, connectionStatus(host)]),
        ),
        workspaceMultiplicityByServerId: new Map(
          hosts.map((host) => [host.serverId, host.supportsLocal]),
        ),
      };
      this.serverId = resolveNewWorkspaceAutomaticServerId({
        ...input,
        currentServerId: this.serverId,
        nextServerId: resolveNewWorkspaceInitialServerId(input),
      });
      const host = hosts.find((candidate) => candidate.serverId === this.serverId);
      this.hostDisplay = host ? { label: host.label } : null;
    }
  }
  private reconcileProject() {
    const host = this.snapshot.hosts.find((candidate) => candidate.serverId === this.serverId);
    const projects = filterWorkspaceProjectsForHost({
      projects: this.snapshot.projects,
      serverId: this.serverId,
      allowAllProjects: Boolean(host?.supportsLocal),
    });
    const candidate = this.manualProject ? this.projectIntent : this.project;
    const currentProject = candidate
      ? resolveHostProjectCandidate({ candidate, projects, serverId: this.serverId })
      : null;
    const preferredKey =
      this.snapshot.routeProject?.viewKey ?? this.snapshot.lastProject?.viewKey ?? "";
    const changedPreference = preferredKey !== "" && preferredKey !== this.preferredProjectKey;
    const project =
      this.manualProject || (currentProject && !changedPreference)
        ? currentProject
        : resolveInitialWorkspaceProject({
            routeProject: this.snapshot.routeProject,
            lastActiveProject: this.snapshot.lastProject,
            projects,
            serverId: this.serverId,
            allowAllProjects: Boolean(host?.supportsLocal),
          });
    this.preferredProjectKey = preferredKey;
    if (project?.viewKey !== this.project?.viewKey)
      this.projectDisplay = project ? { label: project.projectName } : null;
    this.project = project;
  }
  private derive(): WorkspaceSetupState {
    const host = this.snapshot.hosts.find((candidate) => candidate.serverId === this.serverId);
    const projectId = this.project ? getHostProjectId(this.project, this.serverId) : null;
    const directory = this.project
      ? getHostProjectSourceDirectory(this.project, this.serverId)
      : null;
    const showIsolation = Boolean(
      host?.ready &&
      this.project &&
      getWorktreeSupportForHostProject({ project: this.project, serverId: this.serverId }) !==
        "unsupported",
    );
    const isolation =
      showIsolation && (this.isolation === "worktree" || !host?.supportsLocal)
        ? "worktree"
        : "local";
    const showBranch = Boolean(projectId && isolation === "worktree");
    const fields = branchFields(this.branch, showBranch);
    return {
      serverId: this.serverId,
      hostDisplay: this.hostDisplay,
      project: this.project,
      projectDisplay: this.projectDisplay,
      projectId,
      directory,
      scopeKey: `${this.serverId}:${directory ?? ""}`,
      hosts: this.snapshot.hosts,
      projects: filterWorkspaceProjectsForHost({
        projects: this.snapshot.projects,
        serverId: this.serverId,
        allowAllProjects: Boolean(host?.supportsLocal),
      }),
      isolation,
      showIsolation,
      showBranch,
      showBaseBranch: fields.showBaseBranch,
      branch: this.branch,
      submission: this.submission,
      canSubmit: Boolean(
        host?.connected &&
        host.ready &&
        projectId &&
        directory &&
        fields.ready &&
        this.submission.status !== "pending",
      ),
    };
  }
  private resetBranchForScope(previousScope: string) {
    if (this.derive().scopeKey === previousScope) return;
    this.branch = null;
    this.defaultBranch = null;
    this.manualBranch = false;
    this.submission = { status: "idle" };
  }
  private publish() {
    if (this.closed) return;
    this.state = this.derive();
    for (const listener of this.listeners) listener();
  }
}
