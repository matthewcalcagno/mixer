import { useEffect } from "react";
import { withUnistyles } from "react-native-unistyles";
import type { DaemonClient } from "@mixer/client/internal/daemon-client";
import type { ExplorerRefactoringProps } from "./explorer-refactoring";
import type { MonacoTheme } from "./monaco/messages";
import { useSessionStore } from "@/stores/session-store";
import { workspaceDocuments } from "./workspace";
import { useWorkspaceEditReview } from "./review.electron";
import type { ReviewEdit } from "./workspace-edit";
import { reviewFileMove } from "./language-bridge.electron";
import { parentExplorerPath } from "@/utils/explorer-paths";
import { retargetFileTabs } from "./move-tabs";
import { resolveWorkspaceFilePaths } from "@/workspace/file-open";
import { preloadEditorResources } from "./preload.electron";

const reviewers = new WeakMap<
  DaemonClient,
  Map<string, Set<(edit: ReviewEdit) => Promise<boolean>>>
>();

function Host({ client, root, theme }: { client: DaemonClient; root: string; theme: MonacoTheme }) {
  const { review, dialog } = useWorkspaceEditReview(workspaceDocuments(client, root), theme);
  useEffect(() => {
    let roots = reviewers.get(client);
    if (!roots) {
      roots = new Map();
      reviewers.set(client, roots);
    }
    let callbacks = roots.get(root);
    if (!callbacks) {
      callbacks = new Set();
      roots.set(root, callbacks);
    }
    callbacks.add(review);
    return () => {
      callbacks.delete(review);
      if (callbacks.size === 0) roots.delete(root);
    };
  }, [client, root, review]);
  return dialog;
}
const ThemedHost = withUnistyles(Host, (theme) => ({
  theme: {
    colorScheme: theme.colorScheme,
    background: theme.colors.surface0,
    foreground: theme.colors.foreground,
    cursor: theme.colors.terminal.cursor,
    foregroundMuted: theme.colors.foregroundMuted,
    border: theme.colors.border,
    selection: theme.colors.terminal.selectionBackground,
    monoFont: theme.fontFamily.mono,
    codeFontSize: theme.fontSize.code,
  },
}));

export function FileExplorerRefactoringHost({ serverId, root }: ExplorerRefactoringProps) {
  useEffect(() => {
    const idle = window.requestIdleCallback(
      () => {
        void preloadEditorResources();
      },
      { timeout: 1000 },
    );
    return () => window.cancelIdleCallback(idle);
  }, []);
  const client = useSessionStore((state) => state.sessions[serverId]?.client ?? null);
  return client ? <ThemedHost client={client} root={root} /> : null;
}

export async function renameWithReview(
  input: ExplorerRefactoringProps & { path: string; name: string; kind: "file" | "directory" },
): Promise<{ success: true; renamedPath: string; error: null } | null | undefined> {
  if (input.kind !== "file" || !/\.(?:[cm]?[jt]sx?|pyi?)$/i.test(input.path)) return undefined;
  const client = useSessionStore.getState().sessions[input.serverId]?.client;
  if (!client || !input.workspaceId) throw new Error("The workspace host is disconnected");
  if (client.getLastServerInfoMessage()?.features?.workspaceRefactoring !== true)
    throw new Error("Update the workspace host to rename source files with import updates.");
  const review = reviewers.get(client)?.get(input.root)?.values().next().value;
  if (!review) throw new Error("The file review view is not ready. Try again.");
  const parent = parentExplorerPath(input.path);
  const destination = parent === "." ? input.name : `${parent}/${input.name}`;
  const resolved = resolveWorkspaceFilePaths({ path: destination, workspaceRoot: input.root });
  if (!resolved?.relativePath) throw new Error("Choose a destination inside this workspace.");
  const workspaceId = input.workspaceId;
  const applied = await reviewFileMove({
    client,
    workspaceId,
    document: workspaceDocuments(client, input.root).document(input.path),
    destination: resolved.relativePath,
    onReview: review,
    onMoved(from, to) {
      retargetFileTabs({ serverId: input.serverId, workspaceId, root: input.root, from, to });
    },
  });
  return applied ? { success: true, renamedPath: resolved.relativePath, error: null } : null;
}
