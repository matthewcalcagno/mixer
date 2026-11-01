import { i18n } from "@/i18n/i18next";
import { describe, expect, it } from "vitest";
import {
  resolveSidebarWorkspaceAccessibilityLabel,
  resolveSidebarWorkspacePrimaryLabel,
} from "@/components/sidebar/sidebar-workspace-title";

describe("resolveSidebarWorkspacePrimaryLabel", () => {
  it("uses a custom title before the branch", () => {
    const label = resolveSidebarWorkspacePrimaryLabel({
      workspace: {
        workspaceDirectoryLabel: "Search",
        currentBranch: "fix/search",
        title: "Search work",
      },
    });

    expect(label).toBe("Search work");
  });

  it("shows the updated branch after a checkout changes", () => {
    const label = resolveSidebarWorkspacePrimaryLabel({
      workspace: { workspaceDirectoryLabel: "Search", currentBranch: "develop", title: null },
    });

    expect(label).toBe("develop");
  });

  it("falls back to the directory without a branch", () => {
    const label = resolveSidebarWorkspacePrimaryLabel({
      workspace: { workspaceDirectoryLabel: "Local folder", currentBranch: null, title: null },
    });

    expect(label).toBe("Local folder");
  });
});

describe("resolveSidebarWorkspaceAccessibilityLabel", () => {
  it("includes the visible host badge with the workspace title", () => {
    const label = resolveSidebarWorkspaceAccessibilityLabel({
      workspace: {
        workspaceDirectoryLabel: "Search",
        currentBranch: "fix/search",
        statusBucket: "done",
        title: null,
      },
      hostBadgeLabel: "Build host",
      t: i18n.t,
    });

    expect(label).toBe("fix/search, Build host");
  });

  it("owns every visual row contributor in one accessible label", () => {
    const label = resolveSidebarWorkspaceAccessibilityLabel({
      workspace: {
        workspaceDirectoryLabel: "Search",
        currentBranch: "fix/search",
        statusBucket: "running",
        title: null,
      },
      leadingProjectName: "Search project",
      hostBadgeLabel: "Build host",
      pullRequestLabel: "Pull request 42",
      serviceLabel: "Service web running",
      t: i18n.t,
    });

    expect(label).toBe(
      "Search project, fix/search, Build host, Pull request 42, Service web running, Working",
    );
  });

  it("omits the idle status from the workspace label", () => {
    const label = resolveSidebarWorkspaceAccessibilityLabel({
      workspace: {
        workspaceDirectoryLabel: "Search",
        currentBranch: "fix/search",
        statusBucket: "done",
        title: null,
      },
      leadingProjectName: "Search project",
      hostBadgeLabel: "Build host",
      t: i18n.t,
    });

    expect(label).toBe("Search project, fix/search, Build host");
  });
});
