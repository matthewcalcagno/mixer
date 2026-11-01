import { useCallback } from "react";
import type { ContextMenuProps } from "@mixer/plugin/client/ui";
import { getDesktopHost } from "@/desktop/host";
import { useToast } from "@/contexts/toast-context";

export function ContextMenu({ children, actions, onOpen, onSelect }: ContextMenuProps) {
  const toast = useToast();
  const open = useCallback(async () => {
    onOpen();
    try {
      const show = getDesktopHost()?.menu?.showContextMenu;
      if (!show) throw new Error("Restart the desktop app to enable native context menus.");
      const selected = await show({ kind: "actions", items: [...actions] });
      if (selected === undefined)
        throw new Error("Restart the desktop app to enable native context menus.");
      if (
        typeof selected === "string" &&
        actions.some((action) => action.id === selected && !action.disabled)
      )
        onSelect(selected);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Unable to open context menu");
    }
  }, [actions, onOpen, onSelect, toast]);
  const context = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      event.preventDefault();
      event.stopPropagation();
      void open();
    },
    [open],
  );
  const key = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
      event.preventDefault();
      event.stopPropagation();
      void open();
    },
    [open],
  );
  return (
    <div onContextMenu={context} onKeyDown={key}>
      {children}
    </div>
  );
}
