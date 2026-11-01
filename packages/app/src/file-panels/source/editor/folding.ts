import type { EditorState, Text } from "@codemirror/state";

interface FoldRange {
  from: number;
  to: number;
}
interface Header {
  indent: number;
  start: number;
  end: number;
}
const cache = new WeakMap<Text, { tabSize: number; ranges: Map<number, FoldRange> }>();

function indentation(text: string, tabSize: number): number {
  let column = 0;
  for (const char of text) {
    if (char === " ") column += 1;
    else if (char === "\t") column += tabSize - (column % tabSize);
    else break;
  }
  return column;
}

/** The shared highlighter's bare grammars do not supply CodeMirror foldNodeProp metadata.
 * Use the same indentation fallback as Monaco, computed once per immutable document. */
export function foldByIndentation(state: EditorState, lineStart: number): FoldRange | null {
  let stored = cache.get(state.doc);
  if (!stored || stored.tabSize !== state.tabSize) {
    const ranges = new Map<number, FoldRange>();
    const stack: Header[] = [];
    let end = 0;
    for (let number = 1; number <= state.doc.lines; number += 1) {
      const line = state.doc.line(number);
      if (!line.text.trim()) continue;
      const indent = indentation(line.text, state.tabSize);
      let header = stack.at(-1);
      while (header && header.indent >= indent) {
        stack.pop();
        if (end > header.end) ranges.set(header.start, { from: header.end, to: end });
        header = stack.at(-1);
      }
      stack.push({ indent, start: line.from, end: line.to });
      end = line.to;
    }
    for (const header of stack)
      if (end > header.end) ranges.set(header.start, { from: header.end, to: end });
    stored = { tabSize: state.tabSize, ranges };
    cache.set(state.doc, stored);
  }
  return stored.ranges.get(state.doc.lineAt(lineStart).from) ?? null;
}
