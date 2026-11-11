import * as monaco from "monaco-editor";
import "./error-lens.css";

const severityClasses = {
  [monaco.MarkerSeverity.Error]: "error",
  [monaco.MarkerSeverity.Warning]: "warning",
  [monaco.MarkerSeverity.Info]: "info",
  [monaco.MarkerSeverity.Hint]: "hint",
} as const;
const MAX_MESSAGE_LENGTH = 180;

function lineDecorations(model: monaco.editor.ITextModel): monaco.editor.IModelDeltaDecoration[] {
  const byLine = new Map<number, { marker: monaco.editor.IMarker; count: number }>();
  const version = model.getVersionId();
  for (const marker of monaco.editor.getModelMarkers({ resource: model.uri })) {
    if (marker.modelVersionId !== undefined && marker.modelVersionId !== version) continue;
    const line = marker.startLineNumber;
    if (line < 1 || line > model.getLineCount()) continue;
    const current = byLine.get(line);
    if (!current) {
      byLine.set(line, { marker, count: 1 });
      continue;
    }
    current.count += 1;
    if (marker.severity > current.marker.severity) current.marker = marker;
  }

  return Array.from(byLine, ([line, { marker, count }]) => {
    const message = marker.message.replace(/\s+/g, " ").trim();
    const excerpt =
      message.length > MAX_MESSAGE_LENGTH
        ? message.slice(0, MAX_MESSAGE_LENGTH - 1) + "…"
        : message;
    const suffix = count > 1 ? ` (+${count - 1})` : "";
    const kind = severityClasses[marker.severity];
    const column = model.getLineMaxColumn(line);
    return {
      range: new monaco.Range(line, column, line, column),
      options: {
        description: "Mixer Error Lens",
        isWholeLine: true,
        className: `mixer-error-lens-line-${kind}`,
        showIfCollapsed: true,
        after: {
          content: `    ${excerpt}${suffix}`,
          inlineClassName: `mixer-error-lens mixer-error-lens-${kind}`,
          cursorStops: monaco.editor.InjectedTextCursorStops.None,
        },
      },
    };
  });
}

/** Bundled editor plugin. Markers are shared by Monaco workers and all host language providers. */
export function installErrorLens(editor: monaco.editor.IStandaloneCodeEditor): monaco.IDisposable {
  const decorations = editor.createDecorationsCollection();
  let frame: number | undefined;
  const schedule = () => {
    if (frame !== undefined) return;
    frame = requestAnimationFrame(() => {
      frame = undefined;
      const model = editor.getModel();
      decorations.set(model && !model.isDisposed() ? lineDecorations(model) : []);
    });
  };
  const markerListener = monaco.editor.onDidChangeMarkers((resources) => {
    const uri = editor.getModel()?.uri.toString();
    if (uri && resources.some((resource) => resource.toString() === uri)) schedule();
  });
  const modelListener = editor.onDidChangeModel(schedule);
  schedule();

  return {
    dispose() {
      if (frame !== undefined) cancelAnimationFrame(frame);
      markerListener.dispose();
      modelListener.dispose();
      decorations.clear();
    },
  };
}
