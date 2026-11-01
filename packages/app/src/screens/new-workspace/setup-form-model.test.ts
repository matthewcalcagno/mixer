import { describe, expect, it } from "vitest";
import type { HostProjectListItem } from "@/projects/host-project-model";
import { WorkspaceSetupForm, type WorkspaceSetupSnapshot } from "./setup-form-model";

function project(
  serverId = "host",
  worktreeSupport: "supported" | "unsupported" = "supported",
): HostProjectListItem {
  return {
    viewKey: `project:${serverId}`,
    projectKey: "org/repo",
    projectName: "Repository",
    projectKind: "git",
    iconWorkingDir: `/${serverId}/repo`,
    hosts: [
      {
        serverId,
        projectId: `repo-${serverId}`,
        iconWorkingDir: `/${serverId}/repo`,
        worktreeSupport,
      },
    ],
    workspaceKeys: [],
  };
}
function snapshot(overrides: Partial<WorkspaceSetupSnapshot> = {}): WorkspaceSetupSnapshot {
  return {
    hosts: [{ serverId: "host", label: "Host", connected: true, ready: true, supportsLocal: true }],
    projects: [project()],
    initialServerId: "host",
    routeProject: null,
    lastProject: null,
    isolation: "local",
    ...overrides,
  };
}

describe("New workspace setup form", () => {
  it("requires a base branch for explicit creation and preserves the exact new branch name", () => {
    const form = new WorkspaceSetupForm(snapshot({ isolation: "worktree" }), "request-1");
    form.selectNewBranch("internal/GLCX-106", { label: "internal/GLCX-106 (new branch)" });
    expect(form.getState()).toMatchObject({ showBaseBranch: true, canSubmit: false });
    expect(form.beginSubmission()).toBeNull();
    form.selectBaseBranch("release/base", { label: "release/base" });
    expect(form.beginSubmission()).toEqual({
      serverId: "host",
      request: {
        idempotencyKey: "request-1",
        source: {
          kind: "worktree",
          cwd: "/host/repo",
          projectId: "repo-host",
          action: "branch-off",
          branchName: "internal/GLCX-106",
          refName: "release/base",
        },
      },
    });
  });
  it("defaults the base to the repository default rather than the checkout and preserves an explicit choice", () => {
    const form = new WorkspaceSetupForm(snapshot({ isolation: "worktree" }), "request-1");
    form.applyCurrentBranch(form.getState().scopeKey, "develop");
    form.applyDefaultBranch(form.getState().scopeKey, "main");
    form.selectNewBranch("new/one", { label: "new/one (new branch)" });
    expect(form.getState().branch).toMatchObject({ kind: "new", base: { name: "main" } });
    form.selectBaseBranch("release/base", { label: "release/base" });
    form.applyCurrentBranch(form.getState().scopeKey, "other");
    form.applyDefaultBranch(form.getState().scopeKey, "other-default");
    form.selectNewBranch("new/two", { label: "new/two (new branch)" });
    expect(form.getState().branch).toMatchObject({ kind: "new", base: { name: "release/base" } });
    form.selectBranch("feature/existing", { label: "feature/existing" });
    expect(form.getState().showBaseBranch).toBe(false);
    expect(form.beginSubmission()?.request.source).toEqual({
      kind: "worktree",
      cwd: "/host/repo",
      projectId: "repo-host",
      action: "checkout",
      refName: "feature/existing",
    });
  });
  it("resolves a late default base only for the current host/project", () => {
    const form = new WorkspaceSetupForm(snapshot({ isolation: "worktree" }), "request-1");
    form.selectNewBranch("new/one", { label: "new/one (new branch)" });
    form.applyDefaultBranch("stale-scope", "wrong");
    expect(form.getState().canSubmit).toBe(false);
    form.applyDefaultBranch(form.getState().scopeKey, "main");
    expect(form.getState().branch).toMatchObject({ kind: "new", base: { name: "main" } });
    expect(form.getState().canSubmit).toBe(true);
  });
  it("creates only an empty local workspace with no first agent or terminal", () => {
    const form = new WorkspaceSetupForm(snapshot(), "request-1");
    expect(form.getState().canSubmit).toBe(true);
    expect(form.beginSubmission()).toEqual({
      serverId: "host",
      request: {
        idempotencyKey: "request-1",
        source: { kind: "directory", path: "/host/repo", projectId: "repo-host" },
      },
    });
    expect(form.beginSubmission()).toBeNull();
  });
  it("opens the selected branch rather than branching off or naming a new branch", () => {
    const form = new WorkspaceSetupForm(snapshot(), "request-1");
    form.selectIsolation("worktree");
    expect(form.getState().showBranch).toBe(true);
    expect(form.getState().canSubmit).toBe(false);
    form.selectBranch("feature/existing", { label: "feature/existing" });
    expect(form.beginSubmission()).toEqual({
      serverId: "host",
      request: {
        idempotencyKey: "request-1",
        source: {
          kind: "worktree",
          cwd: "/host/repo",
          projectId: "repo-host",
          action: "checkout",
          refName: "feature/existing",
        },
      },
    });
  });
  it("keeps manual choices when live project lists, defaults, or checkout status change", () => {
    const initial = snapshot();
    const form = new WorkspaceSetupForm(initial, "request-1");
    form.selectProject("project:host", { label: "Chosen repository" });
    form.selectIsolation("worktree");
    form.selectBranch("feature/chosen", { label: "feature/chosen" });
    form.applySnapshot({ ...initial, projects: [...initial.projects], isolation: "local" });
    form.applyCurrentBranch(form.getState().scopeKey, "main");
    expect(form.getState()).toMatchObject({
      isolation: "worktree",
      projectDisplay: { label: "Chosen repository" },
      branch: { name: "feature/chosen" },
    });
  });
  it("defaults to the current local branch and ignores stale branch data after a host switch", () => {
    const first = snapshot();
    const next = {
      ...first,
      hosts: [
        ...first.hosts,
        { serverId: "other", label: "Other", ready: true, connected: true, supportsLocal: true },
      ],
      projects: [...first.projects, project("other")],
    };
    const form = new WorkspaceSetupForm(next, "request-1");
    form.selectIsolation("worktree");
    const oldScope = form.getState().scopeKey;
    form.applyCurrentBranch(oldScope, "feature/local");
    expect(form.getState().branch?.name).toBe("feature/local");
    form.selectHost("other", { label: "Other" });
    expect(form.getState().branch).toBeNull();
    form.applyCurrentBranch(oldScope, "stale");
    expect(form.getState().branch).toBeNull();
    expect(form.getState().directory).toBe("/other/repo");
  });
  it("hides branch and isolation controls when worktrees are unsupported", () => {
    const form = new WorkspaceSetupForm(
      snapshot({ projects: [project("host", "unsupported")], isolation: "worktree" }),
      "request-1",
    );
    expect(form.getState()).toMatchObject({
      isolation: "local",
      showIsolation: false,
      showBranch: false,
      canSubmit: true,
    });
  });
  it("waits for capabilities and a connection, and retries with the same creation identity", () => {
    const initial = snapshot();
    const form = new WorkspaceSetupForm(
      { ...initial, hosts: [{ ...initial.hosts[0], connected: false, ready: false }] },
      "request-1",
    );
    expect(form.beginSubmission()).toBeNull();
    form.applySnapshot(initial);
    const first = form.beginSubmission();
    form.fail("Failed");
    expect(form.getState().submission).toEqual({ status: "error", message: "Failed" });
    expect(form.beginSubmission()).toEqual(first);
  });
  it("uses a fresh creation identity when correcting the branch after a failed attempt", () => {
    const form = new WorkspaceSetupForm(snapshot({ isolation: "worktree" }), "request-1");
    form.selectBranch("main", { label: "main" });
    expect(form.beginSubmission()?.request.idempotencyKey).toBe("request-1");
    form.fail("Branch already checked out");
    form.selectBranch("feature/free", { label: "feature/free" });
    expect(form.beginSubmission()?.request.idempotencyKey).toBe("request-1:1");
  });
  it("keeps the selected registered project when its remembered workspace disappears", () => {
    const remembered = project();
    const other = {
      ...project(),
      viewKey: "other",
      projectKey: "org/other",
      projectName: "Other",
      hosts: [
        {
          serverId: "host",
          projectId: "repo-other",
          iconWorkingDir: "/host/other",
          worktreeSupport: "supported" as const,
        },
      ],
    };
    const initial = snapshot({ projects: [other, remembered], lastProject: remembered });
    const form = new WorkspaceSetupForm(initial, "request-1");
    form.selectIsolation("worktree");
    form.applySnapshot({ ...initial, lastProject: null });
    expect(form.getState().project?.viewKey).toBe(remembered.viewKey);
    expect(form.getState().isolation).toBe("worktree");
  });
  it("prefers a connected host over stale offline context until a host is explicitly chosen", () => {
    const initial = snapshot({
      initialServerId: "",
      lastProject: project("offline"),
      projects: [project("offline"), project()],
      hosts: [
        {
          serverId: "offline",
          label: "Offline",
          connected: false,
          ready: true,
          supportsLocal: true,
        },
        { serverId: "host", label: "Host", connected: true, ready: true, supportsLocal: true },
      ],
    });
    const form = new WorkspaceSetupForm(initial, "request-1");
    expect(form.getState().serverId).toBe("host");
    form.selectHost("offline", { label: "Offline" });
    form.applySnapshot(initial);
    expect(form.getState().serverId).toBe("offline");
    expect(form.getState().canSubmit).toBe(false);
  });
});
