/** LSP positions count UTF-16 code units, as JavaScript string offsets do. */
export function incrementalDocumentChange(before: string, after: string) {
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let oldEnd = before.length;
  let newEnd = after.length;
  while (oldEnd > start && newEnd > start && before[oldEnd - 1] === after[newEnd - 1]) {
    oldEnd--;
    newEnd--;
  }
  // Never split CRLF pairs at either end of the replacement.
  if (start > 0 && before[start - 1] === "\r" && before[start] === "\n") start--;
  if (oldEnd > 0 && before[oldEnd - 1] === "\r" && before[oldEnd] === "\n") {
    oldEnd++;
    newEnd++;
  }
  function position(offset: number) {
    let line = 0;
    let lineStart = 0;
    for (let index = 0; index < offset; index++) {
      if (before[index] === "\n" || (before[index] === "\r" && before[index + 1] !== "\n")) {
        line++;
        lineStart = index + 1;
      }
    }
    return { line, character: offset - lineStart };
  }
  return {
    range: { start: position(start), end: position(oldEnd) },
    text: after.slice(start, newEnd),
  };
}
