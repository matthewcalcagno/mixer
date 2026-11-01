import type { SearchMatch, SearchResult } from "../shared/search.js";

export type SearchState =
  | { kind: "idle" }
  | { kind: "pending" }
  | { kind: "cancelled" }
  | { kind: "error"; message: string }
  | { kind: "complete"; result: SearchResult };
export type SearchRow =
  | { kind: "file"; path: string; count: number }
  | { kind: "match"; path: string; match: SearchMatch };

export function resultRows(state: SearchState, collapsed: Set<string>): SearchRow[] {
  if (state.kind !== "complete") return [];
  const rows: SearchRow[] = [];
  for (const file of state.result.files) {
    rows.push({ kind: "file", path: file.path, count: file.matches.length });
    if (!collapsed.has(file.path)) {
      for (const match of file.matches) rows.push({ kind: "match", path: file.path, match });
    }
  }
  return rows;
}
export function statusMessage(state: SearchState): string {
  switch (state.kind) {
    case "idle":
      return "Search for text in this workspace.";
    case "pending":
      return "Searching…";
    case "cancelled":
      return "Search cancelled.";
    case "error":
      return state.message;
    case "complete": {
      const { count, files, limited } = state.result;
      if (!count)
        return limited
          ? "Search stopped before finding matches. Narrow your search."
          : "No results found.";
      const resultsLabel = count === 1 ? "result" : "results";
      const filesLabel = files.length === 1 ? "file" : "files";
      return `${count}${limited ? "+" : ""} ${resultsLabel} in ${files.length} ${filesLabel}`;
    }
  }
}
export function limitMessage(reason: SearchResult["limitReason"]): string {
  switch (reason) {
    case "results":
      return "Showing the first 1,000 matches. Narrow your query or file filters.";
    case "output":
      return "Search output limit reached. Narrow your query or file filters.";
    case "timeout":
      return "Search timed out. Narrow your query or file filters.";
    case null:
      return "";
  }
}
