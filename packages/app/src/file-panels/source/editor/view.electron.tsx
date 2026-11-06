import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ComponentProps,
} from "react";
import type { FileEditorView as WebFileEditorView } from "./view";
import {
  editorEventSchema,
  type EditorCommand,
  type EditorConfiguration,
  type EditorEvent,
} from "./monaco/messages";
import { usePaneContext } from "@/panels/pane-context";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { connectLanguagePort } from "./language-bridge.electron";
import { useWorkspaceFields } from "@/stores/session-store-hooks";
import { resolveWorkspaceFilePaths, type WorkspaceFileLocation } from "@/workspace/file-open";
import { useWorkspaceEditReview } from "./review.electron";
import { EditorViewSession } from "./view-state";
import { editorStorage } from "./persistence-storage";
import type { EditorViewState } from "./persistence";
import { useAppSettings } from "@/hooks/use-settings";
import { copyToClipboard } from "@/utils/copy-to-clipboard";
import { openExternalUrl } from "@/utils/open-external-url";
import { useToast } from "@/contexts/toast-context";
import { gitObjectIdSchema } from "@mixer/protocol/editor-git";
import type { LanguageProvider } from "@mixer/protocol/language-services";
import { readLanguageProviders } from "./language-provider-catalog.electron";
import { editorStatus, type EditorLanguageState } from "./status";
import { useDesktopStartupBlocker } from "@/desktop/startup-readiness";
import { useRetainedPanelActive } from "@/components/retained-panel";
type FileEditorViewProps = ComponentProps<typeof WebFileEditorView>;
function readFrameEvent(
  event: MessageEvent<unknown>,
  source: Window | null | undefined,
): EditorEvent | null {
  if (event.source !== source || event.origin !== window.location.origin) return null;
  const parsed = editorEventSchema.safeParse(event.data);
  return parsed.success ? parsed.data : null;
}
function navigationLocation(
  message: Extract<
    EditorEvent,
    {
      type: "open-location";
    }
  >,
  workspaceRoot: string | null,
): WorkspaceFileLocation | null {
  const uri = new URL(message.uri);
  if (uri.protocol !== "file:" || !workspaceRoot) return null;
  let path = decodeURIComponent(uri.pathname);
  if (/^\/[A-Za-z]:\//.test(path)) path = path.slice(1);
  const resolved = resolveWorkspaceFilePaths({ path, workspaceRoot });
  if (!resolved?.relativePath) return null;
  return { path: resolved.relativePath, lineStart: message.lineStart, lineEnd: message.lineEnd };
}
export function FileEditorView(props: FileEditorViewProps) {
  const toast = useToast();
  const toastRef = useRef(toast);
  toastRef.current = toast;
  const { settings } = useAppSettings();
  const preferences = useRef(settings.editor);
  preferences.current = settings.editor;
  const { review, dialog } = useWorkspaceEditReview(props.document.store, props.theme);
  const reviewRef = useRef(review);
  reviewRef.current = review;
  const pane = usePaneContext();
  const client = useHostRuntimeClient(pane.serverId);
  const workspaceRoot = useWorkspaceFields(
    pane.serverId,
    pane.workspaceId,
    (workspace) => workspace.workspaceDirectory,
  );
  const context = useRef({ client, pane, workspaceRoot });
  context.current = { client, pane, workspaceRoot };
  const frame = useRef<HTMLIFrameElement>(null);
  const mode = useSyncExternalStore(
    useCallback(
      (listener) =>
        props.document.store.subscribe((document) => {
          if (document === props.document) listener();
        }),
      [props.document],
    ),
    () => props.document.languageMode,
    () => null,
  );
  const statusRegistration = useRef<ReturnType<typeof editorStatus.register> | null>(null);
  const languageState = useRef<{
    filename: string;
    value: EditorLanguageState;
  } | null>(null);
  useEffect(() => {
    const document = props.document;
    const registration = editorStatus.register(
      editorStatus.key(pane.serverId, pane.workspaceId, pane.tabId),
      {
        filename: props.filename,
        selectLanguage: (selected) => document.store.setLanguageMode(document, selected),
        focus: () => {
          if (current.current.document === document)
            frame.current?.contentWindow?.postMessage({ type: "focus" }, window.location.origin);
        },
        quickPickBounds: () => {
          if (current.current.document !== document || !frame.current) return null;
          const element = frame.current;
          const panel = element.closest("[data-editor-pane]");
          const bounds = (panel ?? element).getBoundingClientRect();
          const top =
            panel?.querySelector("[data-editor-pane-tabs]")?.getBoundingClientRect().top ??
            bounds.top;
          return { x: bounds.left, y: top, width: bounds.width, height: bounds.bottom - top };
        },
      },
    );
    statusRegistration.current = registration;
    if (languageState.current?.filename === props.filename)
      registration.publish(languageState.current.value);
    return () => {
      registration.dispose();
      if (statusRegistration.current === registration) statusRegistration.current = null;
    };
  }, [pane.serverId, pane.workspaceId, pane.tabId, props.filename, props.document]);
  const languageProviders = useRef<LanguageProvider[]>([]);
  const current = useRef(props);
  current.current = props;
  const revision = useRef(0);
  const booted = useRef(false);
  const editorReady = useRef(false);
  const active = useRetainedPanelActive();
  const releaseStartup = useDesktopStartupBlocker(
    `Editor: ${props.filename}`,
    active && !editorReady.current,
  );
  const pendingNavigation = useRef<number | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [rejectedDraft, setRejectedDraft] = useState<string | null>(null);
  const [languageError, setLanguageError] = useState<string | null>(null);
  const [languageProgress, setLanguageProgress] = useState("");
  const [languageProgressCancellable, setLanguageProgressCancellable] = useState(false);
  const [viewStateError, setViewStateError] = useState<string | null>(null);
  const viewState = useRef<EditorViewState | null>(null);
  const viewSession = useMemo(
    () =>
      new EditorViewSession({
        document: props.document,
        viewId: JSON.stringify([pane.workspaceId, pane.tabId]),
        serverId: pane.serverId,
        storage: editorStorage(),
        onError: (message) => setViewStateError(`Editor position could not be saved: ${message}`),
      }),
    [props.document, pane.workspaceId, pane.tabId, pane.serverId],
  );
  const errorStyle = useMemo(
    () => ({ ...ERROR_STYLE, background: props.theme.background, color: props.theme.foreground }),
    [props.theme.background, props.theme.foreground],
  );
  const languageErrorStyle = useMemo(
    () => ({
      ...LANGUAGE_ERROR_STYLE,
      background: props.theme.background,
      color: props.theme.foreground,
    }),
    [props.theme.background, props.theme.foreground],
  );
  const retry = useCallback(() => {
    setError(null);
    setRejectedDraft(null);
    setLanguageError(null);
    setViewStateError(null);
    setAttempt((value) => value + 1);
  }, []);
  const configuration = useCallback((): EditorConfiguration => {
    const values = current.current;
    const snapshot = values.model.getSnapshot();
    return {
      filename: values.filename,
      languageMode: values.document.languageMode,
      content: snapshot.content,
      lineSeparator: snapshot.lineSeparator,
      revision: revision.current,
      bufferVersion: snapshot.version,
      theme: values.theme,
      vimEnabled: values.vimEnabled,
      preferences: preferences.current,
      projectLanguageServices:
        context.current.client?.getLastServerInfoMessage()?.features?.languageServers === true,
      languageProviders: languageProviders.current,
      extendedLanguageFeatures:
        context.current.client?.getLastServerInfoMessage()?.features?.languageProviders === true,
      gitAnnotations:
        context.current.client?.getLastServerInfoMessage()?.features?.editorGitAnnotations === true,
      viewState: viewState.current?.kind === "monaco" ? viewState.current.state : null,
      initialLocation:
        values.location.lineStart &&
        viewSession.shouldReveal(values.navigationRevision, viewState.current !== null)
          ? { lineStart: values.location.lineStart, lineEnd: values.location.lineEnd }
          : undefined,
    };
  }, [viewSession]);
  const retryLanguageServices = useCallback(() => {
    setLanguageError(null);
    const connection = context.current.client;
    if (!connection) return;
    void readLanguageProviders(connection)
      .then((providers) => {
        languageProviders.current = providers;
        frame.current?.contentWindow?.postMessage(
          { type: "configure", configuration: configuration(), restartLanguageServices: true },
          window.location.origin,
        );
        return undefined;
      })
      .catch((failure: unknown) =>
        setLanguageError(failure instanceof Error ? failure.message : String(failure)),
      );
  }, [configuration]);
  useEffect(() => {
    if (!client) return;
    let closed = false;
    let generation = 0;
    const load = () => {
      const request = ++generation;
      void readLanguageProviders(client)
        .then((providers) => {
          if (closed || request !== generation) return undefined;
          languageProviders.current = providers;
          if (booted.current)
            frame.current?.contentWindow?.postMessage(
              { type: "configure", configuration: configuration() },
              window.location.origin,
            );
          return undefined;
        })
        .catch((failure: unknown) => {
          if (!closed)
            setLanguageError(failure instanceof Error ? failure.message : String(failure));
        });
    };
    load();
    const unsubscribe = client.subscribeConnectionStatus((state) => {
      if (state.status === "connected") load();
    });
    const observation = client.observeEvents(["status.plugin_catalog_changed"]);
    observation.subscribe({
      snapshot: () => {},
      update: (message) => {
        if (message.type === "status" && message.payload.status === "plugin_catalog_changed")
          load();
      },
    });
    return () => {
      closed = true;
      unsubscribe();
      void observation.release().catch(() => undefined);
    };
  }, [client, configuration]);
  const cancelProgress = useCallback(() => {
    frame.current?.contentWindow?.postMessage(
      { type: "cancel-language-progress" },
      window.location.origin,
    );
    setLanguageProgressCancellable(false);
  }, []);
  function send(command: EditorCommand) {
    frame.current?.contentWindow?.postMessage(command, window.location.origin);
  }
  useEffect(() => {
    const languageBridges = new Map<string, () => void>();
    const actor = crypto.randomUUID();
    let historyQueue = Promise.resolve();
    let closed = false;
    const restoring = viewSession
      .load()
      .then((state) => {
        if (!closed) viewState.current = state;
        return undefined;
      })
      .catch((failure: unknown) => {
        if (!closed)
          setViewStateError(
            `Saved editor position could not be restored: ${failure instanceof Error ? failure.message : String(failure)}`,
          );
      });
    revision.current = 0;
    booted.current = false;
    editorReady.current = false;
    pendingNavigation.current = null;
    const timer = window.setTimeout(() => {
      setError("The source editor did not finish loading. Retry to load its local assets.");
      releaseStartup();
      current.current.onReady();
    }, 30000);
    function ready() {
      window.clearTimeout(timer);
      setError(null);
      const values = current.current;
      editorReady.current = true;
      releaseStartup();
      if (pendingNavigation.current !== null) {
        viewSession.navigated(pendingNavigation.current);
        pendingNavigation.current = null;
      }
      values.onReady();
    }
    function connectLanguage(
      event: MessageEvent<unknown>,
      message: Extract<
        EditorEvent,
        {
          type: "language-connect";
        }
      >,
    ) {
      const port = event.ports[0];
      const connection = context.current.client;
      if (!port || !connection) {
        setLanguageError("The workspace host is unavailable for language services.");
        port?.close();
        return;
      }
      languageBridges.set(
        message.channelId,
        connectLanguagePort({
          port,
          client: connection,
          workspaceId: context.current.pane.workspaceId,
          language: message.language,
          provider: languageProviders.current.find((provider) => provider.id === message.language),
          channelId: message.channelId,
          restart: message.restart,
          documents: current.current.document.store,
          onReview: (input) => reviewRef.current(input),
          onError: setLanguageError,
          onReady: () => setLanguageError(null),
        }),
      );
    }
    function disconnectLanguage(channelId: string) {
      languageBridges.get(channelId)?.();
      languageBridges.delete(channelId);
    }
    async function gitRequest(
      message: Extract<
        EditorEvent,
        {
          type: "git-blame-request" | "git-commit-request";
        }
      >,
    ) {
      try {
        const { client: connection, workspaceRoot: root, pane: currentPane } = context.current;
        if (!connection || !root) throw new Error("Workspace host is unavailable for Git history");
        const resolved = resolveWorkspaceFilePaths({
          path: current.current.document.path,
          workspaceRoot: root,
        });
        if (!resolved?.relativePath) throw new Error("Git history requires a workspace file");
        const scope = { workspaceId: currentPane.workspaceId, path: resolved.relativePath };
        const result =
          message.type === "git-blame-request"
            ? await connection.getWorkspaceFileBlame({ ...scope, content: message.content })
            : await connection.getWorkspaceCommitDetails({
                ...scope,
                sha: gitObjectIdSchema.parse(message.sha),
              });
        if (!closed) send({ type: "git-response", requestId: message.requestId, result });
      } catch (failure) {
        if (!closed)
          send({
            type: "git-response",
            requestId: message.requestId,
            result: null,
            error: failure instanceof Error ? failure.message : String(failure),
          });
      }
    }
    function gitAction(
      message: Extract<
        EditorEvent,
        {
          type: "git-copy" | "git-open";
        }
      >,
    ) {
      const task = async () => {
        if (message.type === "git-copy") {
          await copyToClipboard(gitObjectIdSchema.parse(message.text));
          toastRef.current.copied("Commit SHA");
        } else {
          const url = new URL(message.url);
          if (url.protocol !== "https:" && url.protocol !== "http:")
            throw new Error("Only web URLs can open from Git history");
          await openExternalUrl(url.href);
        }
      };
      void task().catch((failure: unknown) =>
        toastRef.current.error(failure instanceof Error ? failure.message : String(failure)),
      );
    }
    function receiveAuxiliary(message: EditorEvent): boolean {
      switch (message.type) {
        case "language-state":
          if (message.filename !== current.current.filename) return true;
          languageState.current = {
            filename: message.filename,
            value: { id: message.id, modes: message.modes },
          };
          statusRegistration.current?.publish(languageState.current.value);
          current.current.document.store.setDetectedLanguage(current.current.document, message.id);
          return true;
        case "git-blame-request":
        case "git-commit-request":
          void gitRequest(message);
          return true;
        case "git-copy":
        case "git-open":
          gitAction(message);
          return true;
        default:
          return false;
      }
    }
    function receive(event: MessageEvent<unknown>) {
      const message = readFrameEvent(event, frame.current?.contentWindow);
      if (!message || receiveAuxiliary(message)) return;
      const values = current.current;
      switch (message.type) {
        case "language-connect": {
          connectLanguage(event, message);
          break;
        }
        case "language-progress":
          setLanguageProgress(message.message);
          setLanguageProgressCancellable(message.cancellable);
          break;
        case "language-error":
          setLanguageError(message.message);
          break;
        case "language-disconnect":
          disconnectLanguage(message.channelId);
          break;
        case "open-location": {
          const location = navigationLocation(message, context.current.workspaceRoot);
          if (location) context.current.pane.openFileInWorkspace({ disposition: "main", location });
          else
            setLanguageError("The definition is outside this workspace and cannot be opened here.");
          break;
        }
        case "booted": {
          void restoring.then(() => {
            if (closed) return;
            booted.current = true;
            pendingNavigation.current = current.current.navigationRevision;
            send({
              type: "configure",
              configuration: configuration(),
            });
            return undefined;
          });
          break;
        }
        case "ready":
          ready();
          break;
        case "view-state":
          viewState.current = { kind: "monaco", state: message.state };
          viewSession.save(viewState.current);
          break;
        case "view-state-error":
          setViewStateError(message.message);
          break;
        case "change":
          revision.current = message.revision;
          if (
            !values.document.store.editFromView({
              document: values.document,
              content: message.content,
              baseVersion: message.baseVersion,
              actor,
              revision: message.revision,
            })
          ) {
            setError(
              "This view changed from an older buffer version. Your draft is preserved below. Copy it before retrying the editor.",
            );
            setRejectedDraft(message.content);
          }
          break;
        case "history":
          historyQueue = historyQueue
            .then(async () => {
              await values.document.store.undo(values.document, message.redo);
              return undefined;
            })
            .catch((failure: unknown) =>
              setLanguageError(failure instanceof Error ? failure.message : String(failure)),
            );
          break;
        case "vim":
          values.onVimModeChange(message.mode);
          break;
        case "save":
          void values.model.save();
          break;
        case "error":
          releaseStartup();
          editorReady.current = false;
          window.clearTimeout(timer);
          setError(message.message);
          values.onReady();
          break;
      }
    }
    window.addEventListener("message", receive);
    // The model remains the sole owner of autosave and conflict reconciliation.
    const unsubscribe = props.model.subscribe(() => {
      if (!booted.current) return;
      const snapshot = props.model.getSnapshot();
      send({
        type: "content",
        content: snapshot.content,
        revision: revision.current,
        bufferVersion: snapshot.version,
        lineSeparator: snapshot.lineSeparator,
      });
    });
    return () => {
      closed = true;
      window.clearTimeout(timer);
      window.removeEventListener("message", receive);
      unsubscribe();
      viewSession.flush();
      props.document.viewRevisions.delete(actor);
      props.document.rejectedViews.delete(actor);
      for (const close of languageBridges.values()) close();
    };
  }, [props.model, props.document, attempt, configuration, viewSession, releaseStartup]);
  useEffect(() => {
    const flush = () => viewSession.flush();
    window.addEventListener("pagehide", flush);
    window.addEventListener("blur", flush);
    return () => {
      window.removeEventListener("pagehide", flush);
      window.removeEventListener("blur", flush);
    };
  }, [viewSession]);
  useEffect(() => {
    if (!booted.current) return;
    send({
      type: "configure",
      configuration: configuration(),
    });
  }, [
    props.filename,
    props.theme,
    props.vimEnabled,
    props.model,
    configuration,
    settings.editor,
    mode,
  ]);
  useEffect(() => {
    if (
      booted.current &&
      props.location.lineStart &&
      viewSession.shouldReveal(props.navigationRevision, viewState.current !== null)
    ) {
      send({
        type: "reveal",
        lineStart: props.location.lineStart,
        lineEnd: props.location.lineEnd,
      });
      if (editorReady.current) viewSession.navigated(props.navigationRevision);
      else pendingNavigation.current = props.navigationRevision;
    }
  }, [props.location.lineStart, props.location.lineEnd, props.navigationRevision, viewSession]);
  return (
    <div style={FRAME_STYLE} data-testid="file-source-editor">
      {dialog}
      {/* oxlint-disable-next-line react/iframe-missing-sandbox -- Trusted bundled editor, not user HTML. Workers require the app origin. */}
      <iframe
        data-mixer-editor=""
        key={attempt}
        ref={frame}
        src="/monaco/index.html"
        title={`Source editor for ${props.filename}`}
        style={EDITOR_STYLE}
      />
      {error && (
        <div role="alert" style={errorStyle}>
          <p>{error}</p>
          {rejectedDraft !== null ? (
            <textarea
              aria-label="Preserved editor draft"
              readOnly
              value={rejectedDraft}
              style={DRAFT_STYLE}
            />
          ) : null}
          <button type="button" onClick={retry}>
            Retry editor
          </button>
        </div>
      )}
      {languageProgress && !languageError && !viewStateError && !error ? (
        <div role="status" style={languageErrorStyle}>
          {languageProgress}
          {languageProgressCancellable ? (
            <button type="button" onClick={cancelProgress}>
              Cancel
            </button>
          ) : null}
        </div>
      ) : null}
      {(viewStateError || languageError) && !error ? (
        <div role="status" style={languageErrorStyle}>
          {viewStateError ?? languageError}{" "}
          <button type="button" onClick={viewStateError ? retry : retryLanguageServices}>
            {viewStateError ? "Retry editor" : "Retry language services"}
          </button>
        </div>
      ) : null}
    </div>
  );
}
const FRAME_STYLE = {
  display: "flex",
  position: "relative",
  flex: 1,
  minHeight: 0,
  minWidth: 0,
} as const;
const EDITOR_STYLE = {
  flex: 1,
  width: "100%",
  height: "100%",
  minHeight: 0,
  border: "none",
} as const;
const ERROR_STYLE = { position: "absolute", inset: 0, padding: 24 } as const;
const DRAFT_STYLE = { width: "100%", height: 240 } as const;
const LANGUAGE_ERROR_STYLE = {
  position: "absolute",
  bottom: 8,
  left: 8,
  right: 8,
  padding: 8,
  fontSize: 12,
} as const;
