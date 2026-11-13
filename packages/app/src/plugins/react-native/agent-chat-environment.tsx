import type { ReactNode } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { queryClient } from "@/data/query-client";
import { DiffDocumentWorkspaceCacheProvider } from "@/git/diff-document/workspace-cache";
import { SheetPaneHostProvider, type SheetPaneHost } from "@/screens/workspace/sheet-pane/host";

/** Embedded conversations own the same supporting-pane environment as workspace conversations. */
export function AgentChatEnvironment({
  host,
  children,
}: {
  host: SheetPaneHost;
  children: ReactNode;
}) {
  return (
    <QueryClientProvider client={queryClient}>
      <DiffDocumentWorkspaceCacheProvider>
        <SheetPaneHostProvider value={host}>{children}</SheetPaneHostProvider>
      </DiffDocumentWorkspaceCacheProvider>
    </QueryClientProvider>
  );
}
