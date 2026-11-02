import { useState, useCallback, useMemo } from "react";
import { useQuery, type QueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type { DaemonClient } from "@mixer/client/internal/daemon-client";
import type { ComboboxOption } from "@/components/ui/combobox";
import type { ToastApi } from "@/components/toast-host";
import { invalidateCheckoutGitQueriesForClient } from "@/git/query-keys";
import { createBranchSwitcherOperations } from "@/git/branch-switcher-operations";
import { confirmCreateBranch } from "@/git/confirm-create-branch";
import { confirmDialog } from "@/utils/confirm-dialog";

interface UseBranchSwitcherInput {
  client: DaemonClient | null;
  normalizedServerId: string;
  normalizedWorkspaceId: string;
  workspaceDirectory: string | null;
  currentBranchName: string | null;
  isGitCheckout: boolean;
  isConnected: boolean;
  toast: ToastApi;
  queryClient: QueryClient;
}

interface UseBranchSwitcherResult {
  branchOptions: ComboboxOption[];
  setSearchQuery: (query: string) => void;
  emptyText: string;
  isSwitching: boolean;
  canCreateBranch: boolean;
  isOpen: boolean;
  setIsOpen: (open: boolean) => void;
  handleBranchSelect: (branchId: string) => void;
  invalidateStashAndCheckout: () => Promise<void>;
}

export function useBranchSwitcher({
  client,
  normalizedServerId,
  normalizedWorkspaceId,
  workspaceDirectory,
  currentBranchName,
  isGitCheckout,
  isConnected,
  toast,
  queryClient,
}: UseBranchSwitcherInput): UseBranchSwitcherResult {
  const { t } = useTranslation();
  const [isOpen, setIsOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [isSwitching, setIsSwitching] = useState(false);

  // Git operations are bound to the workspace directory; the opaque workspace id is
  // used only for query cache identity below, never as a cwd.
  const operations = useMemo(
    () =>
      client && workspaceDirectory
        ? createBranchSwitcherOperations(client, workspaceDirectory)
        : null,
    [client, workspaceDirectory],
  );

  const branchSuggestionsQuery = useQuery({
    queryKey: ["branchSuggestions", normalizedServerId, normalizedWorkspaceId, searchQuery],
    queryFn: async () => {
      if (!operations) {
        throw new Error(t("common.errors.daemonClientUnavailable"));
      }
      const payload = await operations.getBranchSuggestions(200, searchQuery);
      if (payload.error) {
        throw new Error(payload.error);
      }
      return payload.branches ?? [];
    },
    enabled: isOpen && isGitCheckout && Boolean(operations) && isConnected,
    // Keep the picker stable while each search runs; never carry results across workspaces.
    placeholderData: (previous, query) => {
      const sameWorkspace =
        query?.queryKey[1] === normalizedServerId && query.queryKey[2] === normalizedWorkspaceId;
      return sameWorkspace ? previous : undefined;
    },
    retry: false,
    staleTime: 15_000,
  });

  const branchOptions = useMemo<ComboboxOption[]>(() => {
    const branches = branchSuggestionsQuery.data ?? [];
    const names = new Set(branches);
    if (branchSuggestionsQuery.data && currentBranchName && !searchQuery) {
      names.delete(currentBranchName);
      return [currentBranchName, ...names].map((name) => ({ id: name, label: name }));
    }
    return branches.map((name) => ({ id: name, label: name }));
  }, [branchSuggestionsQuery.data, currentBranchName, searchQuery]);
  let emptyText = t("branchSwitcher.empty");
  if (branchSuggestionsQuery.isPending) emptyText = t("common.loading");
  else if (branchSuggestionsQuery.error) emptyText = branchSuggestionsQuery.error.message;

  const stashListQueryKey = useMemo(
    () => ["stashList", normalizedServerId, normalizedWorkspaceId] as const,
    [normalizedServerId, normalizedWorkspaceId],
  );

  const invalidateStashAndCheckout = useCallback(async () => {
    if (!workspaceDirectory) return;
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: stashListQueryKey }),
      invalidateCheckoutGitQueriesForClient(queryClient, {
        serverId: normalizedServerId,
        cwd: workspaceDirectory,
      }),
    ]);
  }, [queryClient, stashListQueryKey, normalizedServerId, workspaceDirectory]);

  const maybeRestoreStashForBranch = useCallback(
    async (branchId: string) => {
      if (!operations) return;
      try {
        const stashPayload = await operations.listMixerStashes();
        const targetStash = stashPayload.entries.find((e) => e.branch === branchId);
        if (!targetStash) return;
        const shouldRestore = await confirmDialog({
          title: t("branchSwitcher.restoreStashTitle"),
          message: t("branchSwitcher.restoreStashMessage"),
          confirmLabel: t("branchSwitcher.restore"),
          cancelLabel: t("branchSwitcher.later"),
        });
        if (!shouldRestore) return;
        const popPayload = await operations.popStash(targetStash.index);
        if (popPayload.error) {
          toast.error(popPayload.error.message);
        } else {
          toast.show(t("branchSwitcher.stashRestored"));
        }
        await invalidateStashAndCheckout();
      } catch {
        // Non-critical — user can still restore on next branch switch
      }
    },
    [operations, invalidateStashAndCheckout, toast, t],
  );

  const stashAndSwitch = useCallback(
    async (branchId: string, create: boolean) => {
      if (!operations) return false;
      const shouldStash = await confirmDialog({
        title: t("branchSwitcher.uncommittedTitle"),
        message: t("branchSwitcher.uncommittedMessage"),
        confirmLabel: t("branchSwitcher.stashAndSwitch"),
        cancelLabel: t("common.actions.cancel"),
      });
      if (!shouldStash) return false;

      try {
        const stashPayload = await operations.saveStash(currentBranchName ?? undefined);
        if (stashPayload.error) {
          toast.error(stashPayload.error.message);
          return false;
        }
        await invalidateStashAndCheckout();
        const switchPayload = create
          ? await operations.createBranch(branchId)
          : await operations.switchBranch(branchId);
        if (switchPayload.error) {
          toast.error(switchPayload.error.message);
          return false;
        }
        await invalidateStashAndCheckout();
        return true;
      } catch (err) {
        toast.error(err instanceof Error ? err.message : t("branchSwitcher.failedToStash"));
        return false;
      }
    },
    [operations, currentBranchName, invalidateStashAndCheckout, toast, t],
  );

  const handleBranchSelect = useCallback(
    (branchId: string) => {
      if (branchId === currentBranchName || isSwitching) return;

      void (async () => {
        if (!operations) return;
        setIsSwitching(true);
        try {
          let exists =
            branchSuggestionsQuery.data?.includes(branchId) || branchId === currentBranchName;
          if (!exists) {
            // A displayed create option may precede its search response. Recheck before creating.
            const exact = await operations.getBranchSuggestions(200, branchId);
            if (exact.error) throw new Error(exact.error);
            exists = exact.branches?.includes(branchId) ?? false;
          }
          let pushToOrigin = false;
          if (!exists) {
            const decision = await confirmCreateBranch(branchId);
            if (!decision.confirmed) return;
            pushToOrigin = decision.pushToOrigin;
          }
          const payload = exists
            ? await operations.switchBranch(branchId)
            : await operations.createBranch(branchId);
          if (payload.error) {
            // If the error is about uncommitted changes, offer the stash dialog
            if (payload.error.message.toLowerCase().includes("uncommitted")) {
              if (!(await stashAndSwitch(branchId, !exists))) return;
            } else {
              toast.error(payload.error.message);
              return;
            }
          }
          // Success — refresh and check for stashes on the target branch
          await invalidateStashAndCheckout();
          if (pushToOrigin) {
            const pushed = await operations.pushBranch();
            if (pushed.error) {
              toast.error(`Branch created, but push to origin failed: ${pushed.error.message}`);
              return;
            }
            await invalidateStashAndCheckout();
          }
          await maybeRestoreStashForBranch(branchId);
        } catch (err) {
          toast.error(err instanceof Error ? err.message : t("branchSwitcher.failedToSwitch"));
        } finally {
          setIsSwitching(false);
        }
      })();
    },
    [
      operations,
      isSwitching,
      branchSuggestionsQuery.data,
      currentBranchName,
      invalidateStashAndCheckout,
      maybeRestoreStashForBranch,
      stashAndSwitch,
      t,
      toast,
    ],
  );

  return {
    branchOptions,
    isSwitching,
    canCreateBranch: branchSuggestionsQuery.isSuccess,
    setSearchQuery,
    emptyText,
    isOpen,
    setIsOpen,
    handleBranchSelect,
    invalidateStashAndCheckout,
  };
}
