import { useCallback, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { flushSync } from "react-dom";
import type { View } from "react-native";
import { stickyFolders, type StickyFolder, type StickyTreeNode } from "./sticky-scroll";

interface TreeScrollHandle {
  getScrollableNode(): unknown;
}

interface StickyLayout {
  nodes: readonly StickyTreeNode[];
  folders: StickyFolder[];
}

export function useExplorerStickyScroll({
  listRef,
  nodes,
  rowHeight,
  paddingTop,
}: {
  listRef: RefObject<TreeScrollHandle | null>;
  nodes: readonly StickyTreeNode[];
  rowHeight: number;
  paddingTop: number;
}) {
  const containerRef = useRef<View>(null);
  const rowRefs = useRef(new Map<number, HTMLElement>());
  const rowCallbacks = useRef(new Map<number, (element: View | null) => void>());
  const viewport = useRef({ scrollOffset: 0, viewportHeight: 0 });
  const [layout, setLayout] = useState<StickyLayout>({ nodes, folders: [] });
  const currentLayout = useRef(layout);
  const folders =
    layout.nodes === nodes
      ? layout.folders
      : stickyFolders({ nodes, rowHeight, paddingTop, ...viewport.current });

  const paint = useCallback(
    (next: readonly StickyFolder[]) => {
      const container = containerRef.current;
      if (!(container instanceof HTMLElement)) return;
      let height = 0;
      for (const folder of next) {
        height = Math.max(height, folder.top + rowHeight);
        const element = rowRefs.current.get(folder.index);
        if (element) element.style.top = `${folder.top}px`;
      }
      container.style.height = `${height}px`;
    },
    [rowHeight],
  );

  const getRowRef = useCallback((index: number) => {
    let callback = rowCallbacks.current.get(index);
    if (!callback) {
      callback = (element: View | null) => {
        if (element instanceof HTMLElement) rowRefs.current.set(index, element);
        else rowRefs.current.delete(index);
      };
      rowCallbacks.current.set(index, callback);
    }
    return callback;
  }, []);

  useLayoutEffect(() => {
    const scroller = listRef.current?.getScrollableNode();
    if (!(scroller instanceof HTMLElement)) {
      currentLayout.current = { nodes, folders: [] };
      paint([]);
      return;
    }
    const update = (synchronous: boolean) => {
      if (scroller.clientWidth > 0 && scroller.clientHeight > 0) {
        viewport.current = {
          scrollOffset: Math.max(0, scroller.scrollTop),
          viewportHeight: scroller.clientHeight,
        };
      }
      const next = stickyFolders({ nodes, rowHeight, paddingTop, ...viewport.current });
      const previous = currentLayout.current;
      const membershipChanged =
        previous.nodes !== nodes ||
        previous.folders.length !== next.length ||
        next.some((folder, index) => folder.index !== previous.folders[index].index);
      currentLayout.current = { nodes, folders: next };
      if (membershipChanged) {
        if (synchronous) flushSync(() => setLayout({ nodes, folders: next }));
        else setLayout({ nodes, folders: next });
      }
      paint(next);
    };
    // RN Web can defer the last throttled scroll tick for 100 ms. Positions must
    // track the actual scroll offset before paint, not that delayed callback.
    const onScroll = () => update(true);
    scroller.addEventListener("scroll", onScroll, { passive: true });
    const observer = new ResizeObserver(() => update(true));
    observer.observe(scroller);
    update(false);
    return () => {
      observer.disconnect();
      scroller.removeEventListener("scroll", onScroll);
    };
  }, [listRef, nodes, rowHeight, paddingTop, paint]);

  useLayoutEffect(() => {
    paint(currentLayout.current.folders);
  });

  return { folders, containerRef, getRowRef };
}
