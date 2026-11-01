import { useEffect, useMemo, useRef, useState } from "react";
import { FileFind, FileFindModel } from "../find/index";
import { Compartment, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { getLanguageForFile } from "@mixer/highlight";
import type { WorkspaceFileLocation } from "@/workspace/file-open";
import type { EditorVisualTheme } from "../editor/extensions";
import { editorTheme, editorPreferenceExtensions } from "../editor/extensions";
import { useAppSettings } from "@/hooks/use-settings";
import { FilePanelLoading } from "../../loading";
import type { SourcePresentation } from "./presentation";
import { prepareSyntaxPaint, syntaxFrame } from "../editor/syntax";

interface FileSourceViewProps {
  content: string;
  filename: string;
  location: WorkspaceFileLocation;
  navigationRevision: number;
  presentation: Exclude<SourcePresentation, "unsupported">;
  theme: EditorVisualTheme;
}

const languageCompartment = new Compartment();
const themeCompartment = new Compartment();
const preferencesCompartment = new Compartment();

/** A read-only source view for files Source does not edit. Shows Loading until the editor exists. */
export function FileSourceView({
  content,
  filename,
  location,
  navigationRevision,
  presentation,
  theme,
}: FileSourceViewProps) {
  const { settings } = useAppSettings();
  const preferences = useRef(settings.editor);
  preferences.current = settings.editor;
  const [find] = useState(() => new FileFindModel());
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const errorStyle = useMemo(
    () => ({ color: theme.foreground, background: theme.background }),
    [theme.foreground, theme.background],
  );
  const navigation = useRef(location);
  navigation.current = location;
  const initial = useRef({ content, filename, presentation, theme });

  useEffect(() => {
    if (!hostRef.current) return;
    const values = initial.current;
    const lifetime = new AbortController();
    const view = new EditorView({
      parent: hostRef.current,
      state: EditorState.create({
        doc: values.content,
        extensions: [
          find.extension,
          EditorState.readOnly.of(true),
          EditorView.contentAttributes.of({
            tabindex: "0",
            "aria-label": `Source for ${values.filename}`,
          }),
          EditorView.editable.of(false),
          languageCompartment.of(
            languageFor({ filename: values.filename, presentation: values.presentation }),
          ),
          themeCompartment.of(editorTheme(values.theme, preferences.current)),
          preferencesCompartment.of(
            editorPreferenceExtensions(preferences.current, values.filename),
          ),
        ],
      }),
    });
    viewRef.current = view;
    const prepare = async () => {
      const line = navigation.current.lineStart;
      if (line) {
        const from = view.state.doc.line(Math.min(view.state.doc.lines, line)).from;
        if (!(await prepareSyntaxPaint(view, lifetime.signal, from))) return;
      }
      if (line) {
        await syntaxFrame(lifetime.signal);
      }
      await syntaxFrame(lifetime.signal);
      if (!(await prepareSyntaxPaint(view, lifetime.signal))) return;
      if (!lifetime.signal.aborted) setReady(true);
    };
    void prepare().catch((failure: unknown) => {
      if (!lifetime.signal.aborted) {
        setError(failure instanceof Error ? failure.message : String(failure));
        setReady(true);
      }
    });
    return () => {
      lifetime.abort();
      view.destroy();
      viewRef.current = null;
    };
  }, [find]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view || view.state.doc.toString() === content) return;
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: content } });
  }, [content]);

  useEffect(() => {
    viewRef.current?.dispatch({
      effects: [
        languageCompartment.reconfigure(languageFor({ filename, presentation })),
        themeCompartment.reconfigure(editorTheme(theme, settings.editor)),
        preferencesCompartment.reconfigure(editorPreferenceExtensions(settings.editor, filename)),
      ],
    });
  }, [filename, presentation, theme, settings.editor]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view || !location.lineStart) return;
    const line = Math.min(location.lineStart, view.state.doc.lines);
    const from = view.state.doc.line(line).from;
    view.dispatch({ effects: EditorView.scrollIntoView(from, { y: "center" }) });
  }, [location.lineStart, navigationRevision]);

  return (
    <div style={FRAME_STYLE}>
      {error ? (
        <div role="alert" style={errorStyle}>
          {error}
        </div>
      ) : null}
      <div ref={hostRef} data-testid="file-source-editor" style={HOST_STYLE} />
      <FileFind model={find} editor={viewRef} />
      {ready ? null : <FilePanelLoading />}
    </div>
  );
}

function languageFor(input: {
  filename: string;
  presentation: Exclude<SourcePresentation, "unsupported">;
}) {
  return input.presentation === "highlighted"
    ? (getLanguageForFile(input.filename)?.extension ?? [])
    : [];
}

const FRAME_STYLE = {
  display: "flex",
  position: "relative",
  flex: 1,
  minHeight: 0,
  minWidth: 0,
} as const;
const HOST_STYLE = { flex: 1, minHeight: 0, overflow: "hidden" } as const;
