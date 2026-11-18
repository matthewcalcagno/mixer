export interface StickyTreeRow {
  depth: number;
  directory: boolean;
}

export interface StickyTreeNode {
  parent: number;
  end: number;
  directory: boolean;
}

export interface StickyFolder {
  index: number;
  top: number;
}

// Match VS Code's default tree limits, leaving most of a short pane for its contents.
export function stickyFolderLimit(viewportHeight: number, rowHeight: number): number {
  if (viewportHeight <= 0 || rowHeight <= 0) return 0;
  return Math.max(0, Math.min(7, Math.floor((viewportHeight * 0.4) / rowHeight)));
}

export function indexStickyTree(rows: readonly StickyTreeRow[]): StickyTreeNode[] {
  const nodes: StickyTreeNode[] = [];
  const ancestors: number[] = [];
  for (const [index, row] of rows.entries()) {
    while (ancestors.length && rows[ancestors[ancestors.length - 1]].depth >= row.depth) {
      const ancestor = ancestors.pop();
      if (ancestor !== undefined) nodes[ancestor].end = index;
    }
    nodes.push({ parent: ancestors.at(-1) ?? -1, end: rows.length, directory: row.directory });
    if (row.directory) ancestors.push(index);
  }
  return nodes;
}

export function stickyFolders({
  nodes,
  scrollOffset,
  rowHeight,
  viewportHeight,
  paddingTop,
}: {
  nodes: readonly StickyTreeNode[];
  scrollOffset: number;
  rowHeight: number;
  viewportHeight: number;
  paddingTop: number;
}): StickyFolder[] {
  const result: StickyFolder[] = [];
  const limit = stickyFolderLimit(viewportHeight, rowHeight);
  let parent = -1;
  for (let level = 0; level < limit; level++) {
    const top = level * rowHeight;
    let index = Math.floor((scrollOffset + top - paddingTop) / rowHeight);
    if (index < 0 || index >= nodes.length) break;
    while (nodes[index].parent !== parent && nodes[index].parent !== -1) {
      index = nodes[index].parent;
    }
    const node = nodes[index];
    const sourceTop = paddingTop + index * rowHeight;
    if (
      node.parent !== parent ||
      !node.directory ||
      node.end <= index + 1 ||
      sourceTop >= scrollOffset + top
    )
      break;
    const subtreeBottom = paddingTop + node.end * rowHeight - scrollOffset;
    result.push({ index, top: Math.min(top, subtreeBottom - rowHeight) });
    parent = index;
  }
  return result;
}
