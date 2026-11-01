import { Fragment, useCallback, useState } from "react";
import type { ContextMenuProps } from "@mixer/plugin/client/ui";
import {
  ContextMenu as HostContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { isWeb } from "@/constants/platform";

export function ContextMenu(props: ContextMenuProps) {
  const [snapshot, setSnapshot] = useState<Pick<ContextMenuProps, "actions" | "onSelect"> | null>(
    null,
  );
  const prepare = useCallback(() => {
    setSnapshot({ actions: props.actions, onSelect: props.onSelect });
    props.onOpen();
  }, [props]);
  const openChanged = useCallback((open: boolean) => {
    if (!open) setSnapshot(null);
  }, []);
  return (
    <HostContextMenu onOpenChange={openChanged}>
      <ContextMenuTrigger contextOnly={isWeb} onContextMenu={prepare} onLongPress={prepare}>
        {props.children}
      </ContextMenuTrigger>
      <ContextMenuContent>
        {snapshot?.actions.map((action) => (
          <ContextAction key={action.id} action={action} onSelect={snapshot.onSelect} />
        ))}
      </ContextMenuContent>
    </HostContextMenu>
  );
}

function ContextAction({
  action,
  onSelect,
}: {
  action: ContextMenuProps["actions"][number];
  onSelect(id: string): void;
}) {
  const select = useCallback(() => onSelect(action.id), [action.id, onSelect]);
  return (
    <Fragment>
      {action.separatorBefore ? <ContextMenuSeparator /> : null}
      <ContextMenuItem disabled={action.disabled} onSelect={select}>
        {action.label}
      </ContextMenuItem>
    </Fragment>
  );
}
