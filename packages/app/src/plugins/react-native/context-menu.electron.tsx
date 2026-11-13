import { PaneHeaderAction } from "./pane-header-action";
import { useCallback } from "react";
import type { ContextMenuProps } from "@mixer/plugin/client/ui";
import { getDesktopHost } from "@/desktop/host";
import { useToast } from "@/contexts/toast-context";

export function ContextMenu({ children, actions, onOpen, onSelect, fill }: ContextMenuProps) {
  const toast = useToast();
  const open = useCallback(async () => {
    onOpen();
    await showNativeActions(actions, onSelect, toast.error);
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
    <div onContextMenu={context} onKeyDown={key} style={fill ? fillStyle : undefined}>
      {children}
    </div>
  );
}
const fillStyle = { display: "flex", flexDirection: "column", flex: 1, minHeight: 0 } as const;

async function showNativeActions(
  actions: ContextMenuProps["actions"],
  onSelect: ContextMenuProps["onSelect"],
  onError: (message: string) => void,
) {
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
    onError(error instanceof Error ? error.message : "Unable to open context menu");
  }
}

export function ActionMenu({
  label,
  actions,
  onSelect,
}: {
  label: string;
  actions: ContextMenuProps["actions"];
  onSelect: ContextMenuProps["onSelect"];
}) {
  const toast = useToast();
  const open = useCallback(() => {
    void showNativeActions(actions, onSelect, toast.error);
  }, [actions, onSelect, toast]);
  return <PaneHeaderAction icon="Ellipsis" label={label} onPress={open} />;
}
