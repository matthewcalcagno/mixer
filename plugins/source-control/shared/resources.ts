import type { RpcOutput } from "@mixer/plugin";
import type { statusRpc } from "./git.js";

export type Resource = RpcOutput<typeof statusRpc>["files"][number];
export type ResourceSort = "path" | "name" | "status";
export type ResourceGroup = "merge" | "staged" | "changes";
const conflicts: Record<string, string> = {
  DD: "Both deleted",
  AU: "Added by us",
  UD: "Deleted by them",
  UA: "Added by them",
  DU: "Deleted by us",
  AA: "Both added",
  UU: "Both modified",
};
export function conflictLabel(file: Resource): string | null {
  return conflicts[file.index + file.worktree] ?? null;
}
export function resourceGroups(files: Resource[]): Record<ResourceGroup, Resource[]> {
  const groups: Record<ResourceGroup, Resource[]> = {
    merge: [],
    staged: [],
    changes: [],
  };
  for (const file of files) {
    if (conflictLabel(file)) groups.merge.push(file);
    else if (file.index === "?") groups.changes.push(file);
    else {
      if (file.index !== " ") groups.staged.push(file);
      if (file.worktree !== " ") groups.changes.push(file);
    }
  }
  return groups;
}
export function visibleResources(
  files: Resource[],
  filter: string,
  sort: ResourceSort,
  staged: boolean,
): Resource[] {
  const query = filter.trim().toLowerCase();
  return files
    .filter((file) => file.path.toLowerCase().includes(query))
    .sort((a, b) => {
      let left = a.path;
      let right = b.path;
      if (sort === "name") {
        left = a.path.split("/").pop() ?? a.path;
        right = b.path.split("/").pop() ?? b.path;
      }
      if (sort === "status") {
        left = staged ? a.index : a.worktree;
        right = staged ? b.index : b.worktree;
      }
      return left.localeCompare(right) || a.path.localeCompare(b.path);
    });
}
export interface ResourceFolder {
  kind: "folder";
  path: string;
  name: string;
  children: ResourceNode[];
  files: Resource[];
}
export interface ResourceFile {
  kind: "file";
  file: Resource;
}
export type ResourceNode = ResourceFolder | ResourceFile;
export function resourceTree(files: Resource[], prefix = ""): ResourceNode[] {
  const folders = new Map<string, Resource[]>();
  const nodes: ResourceNode[] = [];
  for (const file of files) {
    const remaining = file.path.slice(prefix.length);
    const slash = remaining.indexOf("/");
    if (slash < 0) nodes.push({ kind: "file", file });
    else {
      const name = remaining.slice(0, slash);
      const descendants = folders.get(name) ?? [];
      descendants.push(file);
      folders.set(name, descendants);
    }
  }
  const directories: ResourceFolder[] = [];
  for (const [name, descendants] of folders) {
    const path = `${prefix}${name}/`;
    directories.push({
      kind: "folder",
      name,
      path,
      files: descendants,
      children: resourceTree(descendants, path),
    });
  }
  directories.sort((a, b) => a.name.localeCompare(b.name));
  nodes.sort((a, b) =>
    a.kind === "file" && b.kind === "file" ? a.file.path.localeCompare(b.file.path) : 0,
  );
  return [...directories, ...nodes];
}
