import { useEffect } from "react";
import { getDesktopHost } from "@/desktop/host";
import type { DesktopMenuBridge } from "@/desktop/host";
import { useToast } from "@/contexts/toast-context";
import type { NativeTabContextMenuInput } from "./tab-native-menu-types";
type MenuRequest = Extract<
  Parameters<NonNullable<DesktopMenuBridge["showContextMenu"]>>[0],
  {
    kind: "actions";
  }
>;
export function useNativeTabContextMenu({
  ref,
  entries,
  openWith,
}: NativeTabContextMenuInput): void {
  const toast = useToast();
  useEffect(() => {
    if (!(ref.current instanceof HTMLElement)) return;
    const node = ref.current;
    async function open() {
      const items: MenuRequest["items"] = [];
      const callbacks = new Map<string, () => void>();
      let separatorBefore = false;
      for (const entry of entries) {
        if (entry.kind === "separator") {
          separatorBefore = true;
          continue;
        }
        if (entry.kind === "file-panel-open-with") {
          if (!openWith) continue;
          items.push({
            id: entry.key,
            label: openWith.label,
            separatorBefore,
            submenu: openWith.items.map(({ onSelect, ...item }) => {
              callbacks.set(item.id, onSelect);
              return item;
            }),
          });
        } else {
          items.push({
            id: entry.key,
            label: entry.label,
            disabled: entry.disabled,
            separatorBefore,
          });
          if (!entry.disabled) callbacks.set(entry.key, entry.onSelect);
        }
        separatorBefore = false;
      }
      if (!items.length) return;
      try {
        const show = getDesktopHost()?.menu?.showContextMenu;
        if (!show) throw new Error("Restart the desktop app to enable native context menus.");
        const selected = await show({ kind: "actions", items });
        if (selected === undefined)
          throw new Error("Restart the desktop app to enable native context menus.");
        if (typeof selected === "string") callbacks.get(selected)?.();
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Unable to open context menu");
      }
    }
    function context(event: MouseEvent) {
      event.preventDefault();
      event.stopPropagation();
      void open();
    }
    function key(event: KeyboardEvent) {
      if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
      event.preventDefault();
      event.stopPropagation();
      void open();
    }
    node.addEventListener("contextmenu", context, true);
    node.addEventListener("keydown", key, true);
    return () => {
      node.removeEventListener("contextmenu", context, true);
      node.removeEventListener("keydown", key, true);
    };
  }, [ref, entries, openWith, toast]);
}
