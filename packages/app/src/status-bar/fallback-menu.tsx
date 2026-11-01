import { useCallback, type ReactNode } from "react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuTrigger,
  ContextMenuItem,
} from "@/components/ui/context-menu";
import type { StatusChoice, StatusMenuAction } from "./model";

export interface StatusMenuProps {
  children: ReactNode;
  choices: StatusChoice[];
  onAction(action: StatusMenuAction): void;
}
export function StatusBarMenu(props: StatusMenuProps) {
  if (props.choices.length === 0) return props.children;
  return (
    <ContextMenu>
      <ContextMenuTrigger contextOnly>{props.children}</ContextMenuTrigger>
      <ContextMenuContent>
        <StatusMenuItems {...props} />
      </ContextMenuContent>
    </ContextMenu>
  );
}
function VisibilityItem({
  choice,
  onAction,
}: {
  choice: StatusChoice;
  onAction(action: StatusMenuAction): void;
}) {
  const select = useCallback(
    () => onAction({ kind: "toggle-item", id: choice.id, visible: !choice.checked }),
    [choice, onAction],
  );
  return (
    <ContextMenuItem selected={choice.checked} onSelect={select}>
      {choice.label}
    </ContextMenuItem>
  );
}
export function StatusMenuItems({ choices, onAction }: StatusMenuProps) {
  return (
    <>
      {choices.map((choice) => (
        <VisibilityItem key={choice.id} choice={choice} onAction={onAction} />
      ))}
    </>
  );
}
