import { forceParsing, language } from "@codemirror/language";
import type { EditorView } from "@codemirror/view";

export function syntaxFrame(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const finish = () => {
      signal.removeEventListener("abort", cancel);
      resolve();
    };
    const frame = requestAnimationFrame(finish);
    const cancel = () => {
      cancelAnimationFrame(frame);
      finish();
    };
    signal.addEventListener("abort", cancel, { once: true });
  });
}

/** Promote the opening viewport from CodeMirror's idle parser before removing the loading cover. */
export async function prepareSyntaxPaint(
  view: EditorView,
  signal: AbortSignal,
  requestedEnd = 0,
): Promise<boolean> {
  let work = 0;
  let preparedEnd = -1;
  while (!signal.aborted) {
    if (!view.state.facet(language)) return true;
    let end = requestedEnd;
    for (const range of view.visibleRanges) end = Math.max(end, range.to);
    const start = performance.now();
    const complete = forceParsing(view, end, 16);
    work += performance.now() - start;
    if (complete && preparedEnd === end) return true;
    preparedEnd = complete ? end : -1;
    if (work > 1500)
      throw new Error(
        "Syntax highlighting could not finish preparing this viewport. Reopen the file to retry.",
      );
    await syntaxFrame(signal);
  }
  return false;
}
