import { useReplicaQuery } from "@/data/query";
import { useWorkspace } from "@/stores/session-store-hooks";
import { checkoutStatusQueryKey } from "@/git/query-keys";
import type { CheckoutStatusPayload } from "@/git/checkout-status-cache";
import { EmptyStatusBar, WorkspaceStatusBar } from "./index";

export function ActiveWorkspaceStatusBar({
  serverId,
  workspaceId,
}: {
  serverId: string;
  workspaceId: string;
}) {
  const workspace = useWorkspace(serverId, workspaceId);
  // The workspace screen owns Git requests; this footer only observes its cache.
  const { data } = useReplicaQuery<CheckoutStatusPayload>({
    pushEvent: "checkout_status",
    queryKey: checkoutStatusQueryKey(serverId, workspace?.workspaceDirectory ?? ""),
    enabled: false,
  });
  return (
    <WorkspaceStatusBar
      serverId={serverId}
      workspaceId={workspaceId}
      workspaceDirectory={workspace?.workspaceDirectory ?? null}
      isGitCheckout={data?.isGit ?? false}
      branch={data?.currentBranch ?? null}
    />
  );
}

export function AppStatusBar({
  enabled,
  workspace,
}: {
  enabled: boolean;
  workspace: { serverId: string; workspaceId: string } | null;
}) {
  if (!enabled || !workspace) return <EmptyStatusBar />;
  return (
    <ActiveWorkspaceStatusBar serverId={workspace.serverId} workspaceId={workspace.workspaceId} />
  );
}
