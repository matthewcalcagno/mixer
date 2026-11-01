import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { FileFind, FileFindModel } from "../find/index";
import {
  Annotation,
  Compartment,
  EditorState,
  EditorSelection,
  Transaction,
  Prec,
} from "@codemirror/state";
import { foldEffect, foldedRanges } from "@codemirror/language";
import { EditorView, keymap } from "@codemirror/view";
import { getLanguageForFile } from "@mixer/highlight";
import { getCM, vim } from "@replit/codemirror-vim";
import type { WorkspaceFileLocation } from "@/workspace/file-open";
import type { FileEditorModel } from "./model";
import type { SharedFileDocument } from "./documents";
import {
  editorBaseExtensions,
  editorTheme,
  editorPreferenceExtensions,
  type EditorVisualTheme,
} from "./extensions";
import { useAppSettings } from "@/hooks/use-settings";
import { usePaneContext } from "@/panels/pane-context";
import { EditorViewSession } from "./view-state";
import { editorStorage } from "./persistence-storage";
import { prepareSyntaxPaint, syntaxFrame } from "./syntax";
import type { EditorViewState } from "./persistence";

interface ViewNavigation {
  location: WorkspaceFileLocation;
  revision: number;
}
interface OpeningView {
  view: EditorView;
  saved: Extract<EditorViewState, { kind: "codemirror" }> | null;
  navigation: ViewNavigation;
  session: EditorViewSession;
  signal: AbortSignal;
}

interface FileEditorViewProps {
  document: SharedFileDocument;
  model: FileEditorModel;
  filename: string;
  location: WorkspaceFileLocation;
  navigationRevision: number;
  vimEnabled: boolean;
  theme: EditorVisualTheme;
  onVimModeChange(mode: string | null): void;
  /** The editor shows the file's content. */
  onReady(): void;
}

const languageCompartment = new Compartment();
const wrappingCompartment = new Compartment();
const themeCompartment = new Compartment();
const vimCompartment = new Compartment();

export function FileEditorView({
  document: sharedDocument,
  model,
  filename,
  location,
  navigationRevision,
  vimEnabled,
  theme,
  onVimModeChange,
  onReady,
}: FileEditorViewProps) {
  const { settings } = useAppSettings();
  const preferences = useRef(settings.editor);
  preferences.current = settings.editor;
  const [find] = useState(() => new FileFindModel());
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const snapshot = useSyncExternalStore(model.subscribe, model.getSnapshot, model.getSnapshot);
  const bufferVersion = useRef(snapshot.version);
  const actor = useRef(crypto.randomUUID());
  const rejected = useRef(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const errorStyle = useMemo(
    () => ({ color: theme.foreground, background: theme.background }),
    [theme.foreground, theme.background],
  );
  const [viewMounted, setViewMounted] = useState(false);
  const pane = usePaneContext();
  const session = useMemo(
    () =>
      new EditorViewSession({
        document: sharedDocument,
        serverId: pane.serverId,
        viewId: JSON.stringify([pane.workspaceId, pane.tabId]),
        storage: editorStorage(),
        onError: setHistoryError,
      }),
    [sharedDocument, pane.serverId, pane.workspaceId, pane.tabId],
  );
  const navigation = useRef<ViewNavigation>({ location, revision: navigationRevision });
  navigation.current = { location, revision: navigationRevision };
  const initial = useRef({
    filename,
    model,
    theme,
    vimEnabled,
    onReady,
    sharedDocument,
  });

  useEffect(() => {
    if (!hostRef.current) return;
    const values = initial.current;
    const host = hostRef.current;
    let closed = false;
    const lifetime = new AbortController();
    const persist = (view: EditorView) => {
      const folds: { from: number; to: number }[] = [];
      foldedRanges(view.state).between(0, view.state.doc.length, (from, to) => {
        folds.push({ from, to });
      });
      session.save({
        kind: "codemirror",
        length: view.state.doc.length,
        ranges: view.state.selection.ranges.map((range) => ({
          anchor: range.anchor,
          head: range.head,
        })),
        mainIndex: view.state.selection.mainIndex,
        scrollTop: view.scrollDOM.scrollTop,
        scrollLeft: view.scrollDOM.scrollLeft,
        folds,
      });
    };
    const mount = async () => {
      const stored = await session.load().catch((error: unknown) => {
        setHistoryError(error instanceof Error ? error.message : String(error));
        return null;
      });
      if (closed) return;
      const saved = stored?.kind === "codemirror" ? stored : null;
      const content = values.model.getSnapshot().content;
      bufferVersion.current = values.model.getSnapshot().version;
      const doc = EditorState.create({ doc: content }).doc;
      const length = doc.length;
      const ranges = saved?.ranges.map((range) =>
        EditorSelection.range(Math.min(range.anchor, length), Math.min(range.head, length)),
      );
      const view = new EditorView({
        parent: host,
        state: EditorState.create({
          doc,
          selection:
            ranges && saved
              ? EditorSelection.create(ranges, Math.min(saved.mainIndex, ranges.length - 1))
              : undefined,
          extensions: [
            EditorView.domEventHandlers({
              scroll: (_event, editor) => {
                persist(editor);
                return false;
              },
              blur: (_event, editor) => {
                persist(editor);
                session.flush();
                return false;
              },
            }),
            Prec.highest(
              keymap.of([
                {
                  key: "Mod-z",
                  run: () => {
                    void values.sharedDocument.store
                      .undo(values.sharedDocument)
                      .catch((error: unknown) =>
                        setHistoryError(error instanceof Error ? error.message : String(error)),
                      );
                    return true;
                  },
                },
                {
                  key: "Mod-Shift-z",
                  run: () => {
                    void values.sharedDocument.store
                      .undo(values.sharedDocument, true)
                      .catch((error: unknown) =>
                        setHistoryError(error instanceof Error ? error.message : String(error)),
                      );
                    return true;
                  },
                },
              ]),
            ),
            vimCompartment.of(values.vimEnabled ? vim() : []),
            find.extension,
            ...editorBaseExtensions(() => void values.model.save()),
            languageCompartment.of(getLanguageForFile(values.filename)?.extension ?? []),
            wrappingCompartment.of(
              editorPreferenceExtensions(preferences.current, values.filename),
            ),
            themeCompartment.of(editorTheme(values.theme, preferences.current)),
            EditorView.updateListener.of((update) => {
              persist(update.view);
              if (
                update.docChanged &&
                !update.transactions.some((tr) => tr.annotation(remoteUpdate))
              ) {
                const { lineSeparator } = values.model.getSnapshot();
                const accepted = values.sharedDocument.store.edit(
                  values.sharedDocument,
                  update.state.doc.sliceString(0, undefined, lineSeparator),
                  bufferVersion.current,
                  actor.current,
                );
                if (!accepted) {
                  rejected.current = true;
                  setHistoryError(
                    "This buffer changed in another view. Your draft remains in this editor; copy it before reopening the file.",
                  );
                } else bufferVersion.current = values.model.getSnapshot().version;
              }
            }),
          ],
        }),
      });
      viewRef.current = view;
      setViewMounted(true);
      if (
        !(await restoreOpeningView({
          view,
          saved,
          navigation: navigation.current,
          session,
          signal: lifetime.signal,
        }))
      )
        return;
      if (!closed) values.onReady();
    };
    void mount().catch((error: unknown) => {
      if (!closed) {
        setHistoryError(error instanceof Error ? error.message : String(error));
        values.onReady();
      }
    });
    return () => {
      closed = true;
      lifetime.abort();
      const view = viewRef.current;
      if (view) {
        persist(view);
        view.destroy();
      }
      session.flush();
      viewRef.current = null;
    };
  }, [find, session]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view || rejected.current) return;
    bufferVersion.current = snapshot.version;
    const document = view.state.toText(snapshot.content);
    if (view.state.doc.eq(document)) return;
    const head = Math.min(view.state.selection.main.head, document.length);
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: document },
      selection: { anchor: head },
      annotations: [remoteUpdate.of(true), Transaction.addToHistory.of(false)],
    });
  }, [snapshot.content, snapshot.version]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view || !location.lineStart || !session.shouldReveal(navigationRevision, true)) return;
    reveal(view, location);
    session.navigated(navigationRevision);
  }, [location, navigationRevision, session]);

  useEffect(() => {
    viewRef.current?.dispatch({
      effects: [
        languageCompartment.reconfigure(getLanguageForFile(filename)?.extension ?? []),
        wrappingCompartment.reconfigure(editorPreferenceExtensions(settings.editor, filename)),
      ],
    });
  }, [filename, viewMounted, settings.editor]);

  useEffect(() => {
    viewRef.current?.dispatch({
      effects: themeCompartment.reconfigure(editorTheme(theme, settings.editor)),
    });
  }, [theme, viewMounted, settings.editor]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({ effects: vimCompartment.reconfigure(vimEnabled ? vim() : []) });
    if (!vimEnabled) {
      onVimModeChange(null);
      return;
    }
    const cm = getCM(view);
    if (!cm) return;
    function handleModeChange(event: { mode?: string }) {
      onVimModeChange((event.mode ?? "normal").toUpperCase());
    }
    cm.on("vim-mode-change", handleModeChange);
    onVimModeChange("NORMAL");
    return () => cm.off("vim-mode-change", handleModeChange);
  }, [onVimModeChange, vimEnabled, viewMounted]);

  return (
    <div style={FRAME_STYLE}>
      {historyError ? (
        <div role="alert" style={errorStyle}>
          {historyError}
        </div>
      ) : null}
      <div
        ref={hostRef}
        data-pmono=""
        data-testid="file-source-editor"
        aria-label={`Source editor for ${filename}`}
        style={HOST_STYLE}
      />
      <FileFind model={find} editor={viewRef} />
    </div>
  );
}

async function restoreOpeningView({
  view,
  saved,
  navigation,
  session,
  signal,
}: OpeningView): Promise<boolean> {
  if (saved && saved.length === view.state.doc.length) {
    const folds = saved.folds.filter(
      (fold) => fold.from < fold.to && fold.to <= view.state.doc.length,
    );
    view.dispatch({ effects: folds.map((fold) => foldEffect.of(fold)) });
  }
  if (navigation.location.lineStart && session.shouldReveal(navigation.revision, saved !== null)) {
    reveal(view, navigation.location);
    session.navigated(navigation.revision);
  } else if (saved)
    view.requestMeasure({
      read: () => null,
      write: () => {
        view.scrollDOM.scrollTop = saved.scrollTop;
        view.scrollDOM.scrollLeft = saved.scrollLeft;
      },
    });
  const target = navigation.location.lineStart;
  // Prime lexical context before scroll restoration lets the background parser skip ahead.
  const openingEnd = target
    ? view.state.doc.line(Math.min(view.state.doc.lines, target)).from
    : view.state.selection.main.head;
  if (!(await prepareSyntaxPaint(view, signal, openingEnd))) return false;
  if (target || saved?.scrollTop || saved?.scrollLeft) {
    await syntaxFrame(signal);
  }
  // Measure the real viewport before revealing text; the constructor's estimated viewport
  // can be smaller than the visible region, particularly with restored folds and wrapping.
  await syntaxFrame(signal);
  return prepareSyntaxPaint(view, signal);
}

function reveal(view: EditorView, location: WorkspaceFileLocation) {
  if (!location.lineStart) return;
  const lineStart = Math.min(location.lineStart, view.state.doc.lines);
  const lineEnd = Math.min(location.lineEnd ?? lineStart, view.state.doc.lines);
  const from = view.state.doc.line(lineStart).from;
  const to = view.state.doc.line(Math.max(lineStart, lineEnd)).to;
  view.dispatch({
    selection: { anchor: from, head: lineEnd > lineStart ? to : from },
    effects: EditorView.scrollIntoView(from, { y: "center" }),
  });
}

const remoteUpdate = Annotation.define<boolean>();
const FRAME_STYLE = {
  display: "flex",
  position: "relative",
  flex: 1,
  minHeight: 0,
  minWidth: 0,
} as const;
// CodeMirror's scrollIntoView scrolls every overflowing ancestor and stops at a fixed or sticky
// one. Sticky (with no offsets it lays out like relative) keeps line reveals inside the editor, so
// they don't shift the host around it, such as the compact workspace sheet.
const HOST_STYLE = { flex: 1, minHeight: 0, overflow: "hidden", position: "sticky" } as const;
