import { useCallback, type ReactNode } from "react";
import Animated from "react-native-reanimated";
import { StyleSheet } from "react-native-unistyles";
import { MainPanelIsland, useWorkspaceWidth } from "@/components/main-panel-island";
import { resolveExplorerSidebarWidth } from "@/components/explorer-sidebar-layout";
import { useExplorerGeometry } from "@/screens/workspace/explorer-sidebar/geometry";
import { useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import { selectIsAgentListOpen, usePanelStore } from "@/stores/panel-store";
import { useKeyboardActionHandler } from "@/hooks/use-keyboard-action-handler";
import { toggleDesktopSidebarsWithCheckoutIntent } from "@/utils/desktop-sidebar-toggle";

const actions = ["sidebar.toggle.right", "sidebar.toggle.both"] as const;
export function WorkspaceSidebar({
  children,
  open,
  onOpenChange,
  compact = false,
  persistenceKey,
  testID,
}: {
  children: ReactNode;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  compact?: boolean;
  persistenceKey: string;
  testID?: string;
}) {
  const containerWidth = useWorkspaceWidth();
  const storedWidth = useWorkspaceLayoutStore(
    (state) => state.explorerSidebarWidthByWorkspace[persistenceKey],
  );
  const resize = useWorkspaceLayoutStore((state) => state.resizeExplorerSidebar);
  const onResize = useCallback(
    (width: number) => resize(persistenceKey, width),
    [persistenceKey, resize],
  );
  const geometry = useExplorerGeometry({
    width: resolveExplorerSidebarWidth({ requestedWidth: storedWidth, containerWidth }),
    containerWidth,
    overlay: compact,
    resizeEnabled: open && !compact,
    onResize,
  });
  useKeyboardActionHandler({
    handlerId: `plugin-sidebar:${persistenceKey}`,
    actions,
    enabled: true,
    priority: 100,
    handle: (action) => {
      if (action.id === "sidebar.toggle.right") {
        onOpenChange(!open);
        return true;
      }
      if (action.id !== "sidebar.toggle.both") return false;
      const panel = usePanelStore.getState();
      return toggleDesktopSidebarsWithCheckoutIntent({
        isAgentListOpen: selectIsAgentListOpen(panel, { isCompact: compact }),
        isExplorerOpen: open,
        openAgentList: () => panel.openAgentListForLayout({ isCompact: compact }),
        closeAgentList: () => panel.closeAgentListForLayout({ isCompact: compact }),
        toggleExplorer: () => onOpenChange(!open),
      });
    },
  });
  if (!open) return null;
  return (
    <Animated.View style={[styles.frame, geometry.frameStyle, compact && styles.overlay]}>
      <MainPanelIsland variant="sidebar" testID={testID}>
        {children}
      </MainPanelIsland>
      {!compact && geometry.resizeHandle}
    </Animated.View>
  );
}
const styles = StyleSheet.create({
  frame: { minWidth: 0, minHeight: 0, flexShrink: 0, position: "relative" },
  overlay: {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    width: 340,
    maxWidth: "100%",
    zIndex: 20,
  },
});
