import type { TFunction } from "i18next";
import type { SidebarWorkspaceEntry } from "@/hooks/use-sidebar-workspaces-list";
import { getStatusBucketLabel } from "@/hooks/sidebar-status-view-model";

export function resolveSidebarWorkspacePrimaryLabel(input: {
  workspace: Pick<SidebarWorkspaceEntry, "workspaceDirectoryLabel" | "currentBranch" | "title">;
}): string {
  return (
    input.workspace.title ??
    input.workspace.currentBranch ??
    input.workspace.workspaceDirectoryLabel
  );
}

export function resolveSidebarWorkspaceAccessibilityLabel(input: {
  workspace: Pick<
    SidebarWorkspaceEntry,
    "workspaceDirectoryLabel" | "currentBranch" | "statusBucket" | "title"
  >;
  leadingProjectName?: string | null;
  hostBadgeLabel?: string | null;
  pullRequestLabel?: string | null;
  serviceLabel?: string | null;
  t: TFunction;
}): string {
  return [
    input.leadingProjectName,
    resolveSidebarWorkspacePrimaryLabel(input),
    input.hostBadgeLabel,
    input.pullRequestLabel,
    input.serviceLabel,
    input.workspace.statusBucket === "done"
      ? null
      : getStatusBucketLabel(input.workspace.statusBucket, input.t),
  ]
    .filter((label): label is string => Boolean(label))
    .join(", ");
}
