import { useCallback, useEffect, useState, type ComponentProps, type DragEvent } from "react";
import type { TreeDragSource as Source, TreeDropTarget as Target } from "@mixer/plugin/client/ui";
import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { z } from "zod";

const mime = "application/x-mixer-plugin-tree";
const dragPayload = z.object({ scope: z.string(), path: z.string().min(1).max(512) });
export function TreeDragSource({ scope, path, disabled, children }: ComponentProps<typeof Source>) {
  const start = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      event.stopPropagation();
      event.dataTransfer.setData(mime, JSON.stringify({ scope, path }));
      event.dataTransfer.effectAllowed = "move";
    },
    [scope, path],
  );
  return (
    <div draggable={!disabled} onDragStart={start}>
      {children}
    </div>
  );
}
export function TreeDropTarget({
  scope,
  onDropPath,
  children,
  fill,
  disabled,
}: ComponentProps<typeof Target>) {
  const [active, setActive] = useState(false);
  useEffect(() => {
    if (!active) return;
    const clear = () => setActive(false);
    document.addEventListener("dragend", clear);
    document.addEventListener("drop", clear);
    return () => {
      document.removeEventListener("dragend", clear);
      document.removeEventListener("drop", clear);
    };
  }, [active]);
  const capture = useCallback((event: DragEvent<HTMLDivElement>) => {
    if (
      event.target instanceof Element &&
      event.target.closest("[data-mixer-tree-drop]") !== event.currentTarget
    )
      setActive(false);
  }, []);
  const over = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      if (disabled || !event.dataTransfer.types.includes(mime)) return;
      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer.dropEffect = "move";
      setActive(true);
    },
    [disabled],
  );
  const leave = useCallback((event: DragEvent<HTMLDivElement>) => {
    if (
      !(event.relatedTarget instanceof Node) ||
      !event.currentTarget.contains(event.relatedTarget)
    )
      setActive(false);
  }, []);
  const drop = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      setActive(false);
      if (disabled || !event.dataTransfer.types.includes(mime)) return;
      event.preventDefault();
      event.stopPropagation();
      let value: unknown;
      try {
        value = JSON.parse(event.dataTransfer.getData(mime));
      } catch {
        return;
      }
      const parsed = dragPayload.safeParse(value);
      if (parsed.success && parsed.data.scope === scope) onDropPath(parsed.data.path);
    },
    [scope, onDropPath, disabled],
  );
  return (
    <div
      data-mixer-tree-drop
      onDragOverCapture={capture}
      onDragOver={over}
      onDragLeave={leave}
      onDrop={drop}
      style={fill ? fillStyle : undefined}
    >
      <View style={[fill && styles.fill, active && styles.active]}>{children}</View>
    </div>
  );
}
const fillStyle = { display: "flex", flexDirection: "column", flex: 1, minHeight: 0 } as const;
const styles = StyleSheet.create((theme) => ({
  fill: { flex: 1, minHeight: 0 },
  active: { backgroundColor: theme.colors.interactionHighlight },
}));
