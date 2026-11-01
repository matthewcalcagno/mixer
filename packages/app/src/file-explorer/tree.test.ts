import { describe, expect, it } from "vitest";
import type { ExplorerEntry } from "@/stores/session-store";
import { fileExplorerRowPaddingLeft, fileExplorerRowMetrics } from "./geometry";
import {
  flattenExplorerTree,
  restoreExpandedDirectories,
  setExpandedDirectoryPath,
  showHiddenFilesAndRestoreExpandedDirectories,
} from "./tree";

function makeDirectoryEntry(name: string, path: string): ExplorerEntry {
  return {
    name,
    path,
    kind: "directory",
    size: 0,
    modifiedAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("file explorer tree", () => {
  it("matches VS Code's default row pitch and narrower tree indentation", () => {
    expect(fileExplorerRowMetrics(13)).toEqual({ minHeight: 22, lineHeight: 18 });
    expect([0, 1, 2, 3].map(fileExplorerRowPaddingLeft)).toEqual([12, 20, 28, 36]);
    expect(fileExplorerRowMetrics(18)).toEqual({ minHeight: 30, lineHeight: 25 });
  });
  it("sorts folders first and numbers naturally within file names", () => {
    const entries: ExplorerEntry[] = [
      { ...makeDirectoryEntry("file10.ts", "file10.ts"), kind: "file" },
      { ...makeDirectoryEntry("file2.ts", "file2.ts"), kind: "file" },
      makeDirectoryEntry("z-folder", "z-folder"),
    ];
    const rows = flattenExplorerTree({
      directories: new Map([[".", { path: ".", entries }]]),
      expandedPaths: new Set(["."]),
      sortOption: "name",
      showHiddenFiles: true,
    });
    expect(rows.map((row) => row.entry.name)).toEqual(["z-folder", "file2.ts", "file10.ts"]);
  });

  it("bounds concurrent restoration reads without limiting saved expansion depth", async () => {
    const entries = Array.from({ length: 20 }, (_, index) =>
      makeDirectoryEntry(`folder-${index}`, `folder-${index}`),
    );
    let active = 0;
    let maximum = 0;
    const result = await restoreExpandedDirectories({
      rootDirectory: { path: ".", entries },
      persistedExpandedPaths: new Set(entries.map((entry) => entry.path)),
      showHiddenFiles: true,
      requestDirectoryListing: async (path) => {
        active += 1;
        maximum = Math.max(maximum, active);
        await Promise.resolve();
        active -= 1;
        return { path, entries: [] };
      },
    });
    expect(maximum).toBe(8);
    expect(result).toHaveLength(21);
  });

  it("flattens a deeply expanded tree without consuming the call stack", () => {
    const depth = 10_000;
    const directories = new Map<string, { path: string; entries: ExplorerEntry[] }>();
    const expandedPaths = new Set<string>(["."]);
    let parentPath = ".";

    for (let index = 1; index <= depth; index += 1) {
      const childPath = `directory-${index}`;
      directories.set(parentPath, {
        path: parentPath,
        entries: [makeDirectoryEntry(childPath, childPath)],
      });
      expandedPaths.add(childPath);
      parentPath = childPath;
    }
    directories.set(parentPath, { path: parentPath, entries: [] });

    const rows = flattenExplorerTree({
      directories,
      expandedPaths,
      sortOption: "name",
      showHiddenFiles: true,
    });

    expect(rows).toHaveLength(depth);
    expect(rows[0]).toEqual({
      entry: makeDirectoryEntry("directory-1", "directory-1"),
      depth: 0,
    });
    expect(rows.at(-1)).toEqual({
      entry: makeDirectoryEntry(`directory-${depth}`, `directory-${depth}`),
      depth: depth - 1,
    });
  });

  it("flattens a large expanded directory without spreading its rows into the parent", () => {
    const fileCount = 150_000;
    const files = Array.from({ length: fileCount }, (_, index): ExplorerEntry => ({
      name: `file-${index.toString().padStart(6, "0")}`,
      path: `generated/file-${index}`,
      kind: "file",
      size: index,
      modifiedAt: "2026-01-01T00:00:00.000Z",
    }));
    const child = makeDirectoryEntry("generated", "generated");
    const directories = new Map([
      [".", { path: ".", entries: [child] }],
      ["generated", { path: "generated", entries: files }],
    ]);

    const rows = flattenExplorerTree({
      directories,
      expandedPaths: new Set([".", "generated"]),
      sortOption: "name",
      showHiddenFiles: true,
    });

    expect(rows).toHaveLength(fileCount + 1);
    expect(rows[0]).toEqual({ entry: child, depth: 0 });
    expect(rows.at(-1)).toEqual({ entry: files[fileCount - 1], depth: 1 });
  });

  it("restores every explicitly expanded level, including folders deeper than five levels", async () => {
    const paths = [
      "generated/cache/level-1",
      "generated/cache/level-1/level-2",
      "generated/cache/level-1/level-2/level-3",
      "generated/cache/level-1/level-2/level-3/level-4",
      "generated/cache/level-1/level-2/level-3/level-4/level-5",
      "generated/cache/level-1/level-2/level-3/level-4/level-5/level-6",
    ];
    const directories = new Map<string, { path: string; entries: ExplorerEntry[] }>();
    const rootDirectory = {
      path: ".",
      entries: [makeDirectoryEntry("level-1", paths[0])],
    };
    directories.set(".", rootDirectory);
    for (let index = 0; index < paths.length - 1; index += 1) {
      directories.set(paths[index], {
        path: paths[index],
        entries: [makeDirectoryEntry(`level-${index + 2}`, paths[index + 1])],
      });
    }
    directories.set(paths[paths.length - 1], { path: paths[paths.length - 1], entries: [] });

    const requestedPaths: string[] = [];
    const expandedPaths = await restoreExpandedDirectories({
      rootDirectory,
      persistedExpandedPaths: new Set(paths),
      showHiddenFiles: true,
      requestDirectoryListing: async (path) => {
        requestedPaths.push(path);
        return directories.get(path) ?? null;
      },
    });

    expect(requestedPaths).toEqual(paths);
    expect(expandedPaths).toEqual([".", ...paths]);
  });

  it("does not restore persisted descendants beneath a collapsed rendered directory", async () => {
    const rootDirectory = {
      path: ".",
      entries: [makeDirectoryEntry("parent", "parent")],
    };
    const requestedPaths: string[] = [];

    const expandedPaths = await restoreExpandedDirectories({
      rootDirectory,
      persistedExpandedPaths: new Set(["parent/child", "parent/child/grandchild"]),
      showHiddenFiles: true,
      requestDirectoryListing: async (path) => {
        requestedPaths.push(path);
        return null;
      },
    });

    expect(requestedPaths).toEqual([]);
    expect(expandedPaths).toEqual(["."]);
  });

  it("does not discard saved expansion intent when a listing fails", async () => {
    const expandedPaths = new Set([".", "parent", "parent/child"]);
    const loaded = await restoreExpandedDirectories({
      rootDirectory: { path: ".", entries: [makeDirectoryEntry("parent", "parent")] },
      persistedExpandedPaths: expandedPaths,
      showHiddenFiles: true,
      requestDirectoryListing: async () => null,
    });
    expect(loaded).toEqual(["."]);
    expect([...expandedPaths]).toEqual([".", "parent", "parent/child"]);
  });

  it("applies a directory click to the latest restored expansion paths", () => {
    const expanded = setExpandedDirectoryPath({
      currentExpandedPaths: [".", "restored"],
      directoryPath: "manual",
      expanded: true,
    });
    const collapsed = setExpandedDirectoryPath({
      currentExpandedPaths: expanded,
      directoryPath: "manual",
      expanded: false,
    });

    expect(expanded).toEqual([".", "restored", "manual"]);
    expect(collapsed).toEqual([".", "restored"]);
  });

  it("shows hidden files before waiting for expanded directories to restore", async () => {
    const rootDirectory = {
      path: ".",
      entries: [makeDirectoryEntry(".hidden", ".hidden")],
    };
    let resolveDirectory!: (directory: { path: string; entries: ExplorerEntry[] }) => void;
    const directoryListing = new Promise<{ path: string; entries: ExplorerEntry[] }>((resolve) => {
      resolveDirectory = resolve;
    });
    let hiddenFilesAreShown = false;

    const restoration = showHiddenFilesAndRestoreExpandedDirectories({
      rootDirectory,
      persistedExpandedPaths: new Set([".hidden"]),
      showHiddenFiles: () => {
        hiddenFilesAreShown = true;
      },
      requestDirectoryListing: () => directoryListing,
    });

    expect(hiddenFilesAreShown).toBe(true);
    resolveDirectory({ path: ".hidden", entries: [] });
    await expect(restoration).resolves.toEqual([".", ".hidden"]);
  });
});
