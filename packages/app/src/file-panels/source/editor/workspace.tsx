import { createContext, useContext, useEffect, useMemo } from "react";
import type { DaemonClient } from "@mixer/client/internal/daemon-client";
import { createDaemonFileSession } from "../../file/daemon-session";
import { SharedFileDocument, WorkspaceDocuments } from "./documents";
import type { FileHandleSnapshot } from "../../file/handle";
import { editorStorage } from "./persistence-storage";
import { FileRecoveryJournal } from "./persistence";
const workspaces = new WeakMap<DaemonClient, Map<string, WorkspaceDocuments>>();
export function workspaceDocuments(client: DaemonClient, root: string): WorkspaceDocuments {
  let stores = workspaces.get(client);
  if (!stores) {
    stores = new Map();
    workspaces.set(client, stores);
  }
  let store = stores.get(root);
  if (!store) {
    const storage = editorStorage();
    store = new WorkspaceDocuments(
      root,
      createDaemonFileSession(client, {
        get workspaceFileEditing() {
          return client.getLastServerInfoMessage()?.features?.workspaceFileEditing === true;
        },
        get fileByteWrites() {
          return client.getLastServerInfoMessage()?.features?.fileByteWrites === true;
        },
      }),
      undefined,
      storage
        ? (path) =>
            new FileRecoveryJournal(storage, () => {
              const serverId = client.getLastServerInfoMessage()?.serverId;
              if (!serverId) throw new Error("The host identity is unavailable for draft recovery");
              return JSON.stringify([serverId, root, path()]);
            })
        : undefined,
    );
    stores.set(root, store);
  }
  return store;
}
interface DocumentView {
  document: SharedFileDocument;
  mount(): () => void;
  suspendPendingSave(): () => void;
}
function documentView(document: SharedFileDocument): DocumentView {
  let resume: (() => void) | null = null;
  return {
    document,
    mount() {
      const release = document.acquire();
      return () => {
        release();
        const held = resume;
        resume = null;
        if (!held) return;
        // A confirmed close leaves the hold in place. Discard only when no other view needs it.
        if (!document.hasViews) void document.model.revert().finally(held);
        else held();
      };
    },
    suspendPendingSave() {
      resume ??= document.model.holdAutosave();
      return () => {
        resume?.();
        resume = null;
      };
    },
  };
}
export const FileDocumentContext = createContext<SharedFileDocument | null>(null);
export function useDocumentView(input: {
  client: DaemonClient | null;
  root: string;
  path: string;
  snapshot: FileHandleSnapshot;
}) {
  const { client, root, path, snapshot } = input;
  const enabled =
    snapshot.status === "ready" && snapshot.kind === "text" && snapshot.size <= 1024 * 1024;
  const view = useMemo(
    () =>
      enabled && client ? documentView(workspaceDocuments(client, root).document(path)) : null,
    [client, root, path, enabled],
  );
  useEffect(() => view?.mount(), [view]);
  return view;
}
export function useFileDocument(): SharedFileDocument {
  const document = useContext(FileDocumentContext);
  if (!document) throw new Error("An editable file requires its shared workspace document");
  return document;
}
