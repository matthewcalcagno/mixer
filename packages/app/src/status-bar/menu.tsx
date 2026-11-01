import { useCallback, type MouseEvent } from "react";
import { getDesktopHost } from "@/desktop/host";
import { getIsElectron } from "@/constants/platform";
import { useToast } from "@/contexts/toast-context";
import { useTranslation } from "react-i18next";
import { StatusBarMenu as FallbackMenu, type StatusMenuProps } from "./fallback-menu";

export function StatusBarMenu(props: StatusMenuProps) {
  if (!getIsElectron()) return <FallbackMenu {...props} />;
  return <NativeStatusBarMenu {...props} />;
}
function NativeStatusBarMenu({ children, choices, onAction }: StatusMenuProps) {
  const toast = useToast();
  const { t } = useTranslation();
  const open = useCallback(
    (event: MouseEvent<HTMLDivElement>) => {
      event.preventDefault();
      event.stopPropagation();
      if (choices.length === 0) return;
      const show = getDesktopHost()?.menu?.showStatusBarMenu;
      if (!show) {
        toast.error(t("statusBar.menuError"));
        return;
      }
      void show({ items: choices })
        .then((action) => {
          if (action) onAction(action);
          return undefined;
        })
        .catch(() => toast.error(t("statusBar.menuError")));
    },
    [choices, onAction, toast, t],
  );
  return (
    <div onContextMenuCapture={open} style={MENU_STYLE}>
      {children}
    </div>
  );
}
const MENU_STYLE = { display: "flex", flexShrink: 0, minWidth: 0, width: "100%" } as const;
