import type { Resource, ResourceGroup, ResourceNode } from "./resources.js";

export interface ResourceItem {
  group: ResourceGroup;
  file: Resource;
}
export interface ResourceSelection {
  keys: ReadonlySet<string>;
  anchor: string | null;
  focus: string | null;
}
export type SelectionGesture = "replace" | "toggle" | "range" | "add-range";
export type ResourceOperation = "stage" | "unstage" | "discard";
export type ResourceKeyAction =
  | { kind: "all" | "clear" | "toggle" | "open" }
  | {
      kind: "navigate";
      direction: "next" | "previous" | "first" | "last";
      extend: boolean;
      additive: boolean;
    };

export function resourceKey(group: ResourceGroup, path: string): string {
  return JSON.stringify([group, path]);
}

export function emptySelection(): ResourceSelection {
  return { keys: new Set(), anchor: null, focus: null };
}

export function selectResource({
  selection,
  key,
  order,
  gesture,
}: {
  selection: ResourceSelection;
  key: string;
  order: readonly string[];
  gesture: SelectionGesture;
}): ResourceSelection {
  if (!order.includes(key)) return selection;
  if (gesture === "replace") return { keys: new Set([key]), anchor: key, focus: key };
  if (gesture === "toggle") {
    const keys = new Set(selection.keys);
    if (keys.has(key)) keys.delete(key);
    else keys.add(key);
    return { keys, anchor: key, focus: key };
  }
  const end = order.indexOf(key);
  const previous = selection.anchor === null ? -1 : order.indexOf(selection.anchor);
  const start = previous < 0 ? end : previous;
  const range = order.slice(Math.min(start, end), Math.max(start, end) + 1);
  const keys = gesture === "add-range" ? new Set(selection.keys) : new Set<string>();
  for (const entry of range) keys.add(entry);
  return { keys, anchor: order[start], focus: key };
}

export function selectAllResources(
  order: readonly string[],
  previous = emptySelection(),
): ResourceSelection {
  const first = order[0] ?? null;
  const anchor =
    previous.anchor !== null && order.includes(previous.anchor) ? previous.anchor : first;
  const focus = previous.focus !== null && order.includes(previous.focus) ? previous.focus : first;
  return { keys: new Set(order), anchor, focus };
}

export function retainSelection(
  selection: ResourceSelection,
  available: ReadonlySet<string>,
): ResourceSelection {
  const keys = new Set([...selection.keys].filter((key) => available.has(key)));
  const anchor =
    selection.anchor !== null && available.has(selection.anchor) ? selection.anchor : null;
  const focus = selection.focus !== null && available.has(selection.focus) ? selection.focus : null;
  if (keys.size === selection.keys.size && anchor === selection.anchor && focus === selection.focus)
    return selection;
  return { keys, anchor, focus };
}

export function visibleResourceItems({
  nodes,
  group,
  collapsedFolders,
}: {
  nodes: readonly ResourceNode[];
  group: ResourceGroup;
  collapsedFolders: ReadonlySet<string>;
}): ResourceItem[] {
  return nodes.flatMap((node) => {
    if (node.kind === "file") return [{ group, file: node.file }];
    if (collapsedFolders.has(resourceKey(group, node.path))) return [];
    return visibleResourceItems({ nodes: node.children, group, collapsedFolders });
  });
}

export function actionResources({
  selection,
  resources,
  operation,
  context,
}: {
  selection: ResourceSelection;
  resources: readonly ResourceItem[];
  operation: ResourceOperation;
  context?: ResourceItem;
}): ResourceItem[] {
  let candidates = resources.filter((item) =>
    selection.keys.has(resourceKey(item.group, item.file.path)),
  );
  if (context && !selection.keys.has(resourceKey(context.group, context.file.path)))
    candidates = [context];
  return candidates.filter((item) => {
    if (operation === "unstage") return item.group === "staged";
    if (operation === "discard") return item.group === "changes" && item.file.index !== "?";
    return item.group !== "staged";
  });
}
