import type { ExplorerEntry } from "@/stores/session-store";

export function isHiddenExplorerPath(path: string): boolean {
  return path
    .split("/")
    .some((segment) => segment !== "." && segment !== ".." && segment.startsWith("."));
}

export function filterVisibleExplorerEntries(
  entries: ExplorerEntry[],
  showHiddenFiles: boolean,
): ExplorerEntry[] {
  return entries.filter(
    (entry) => entry.name !== ".git" && (showHiddenFiles || !entry.name.startsWith(".")),
  );
}
