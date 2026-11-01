import type { ReactNode } from "react";
import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { RetainedPanel } from "@/components/retained-panel";
import { TitlebarDragRegion } from "@/components/desktop/titlebar-drag-region";
import { WindowChromeRegion, WindowChromeSafeArea } from "@/utils/desktop-window";

export function ExplorerDock({ children }: { children: ReactNode }) {
  return (
    <RetainedPanel active>
      <WindowChromeRegion corners="top-right">
        <View style={styles.dock} testID="workspace-explorer-sidebar">
          {children}
        </View>
      </WindowChromeRegion>
    </RetainedPanel>
  );
}
export function ExplorerDockTabs({
  children,
  headerAction,
}: {
  children: ReactNode;
  headerAction?: ReactNode;
}) {
  return (
    <WindowChromeSafeArea placement="inline" style={styles.tabRail}>
      <TitlebarDragRegion />
      <View style={styles.tabRow}>{children}</View>
      {headerAction ? <View style={styles.headerAction}>{headerAction}</View> : null}
    </WindowChromeSafeArea>
  );
}
export function ExplorerDockContent({ children }: { children: ReactNode }) {
  return <View style={styles.content}>{children}</View>;
}
const styles = StyleSheet.create((theme) => ({
  dock: { flex: 1, minWidth: 0, minHeight: 0, backgroundColor: theme.colors.surfaceSidebar },
  tabRail: {
    position: "relative",
    flexDirection: "row",
    alignItems: "center",
    flexShrink: 0,
    backgroundColor: theme.colors.surfaceSidebar,
  },
  tabRow: { flex: 1, minWidth: 0 },
  headerAction: { marginRight: theme.spacing[1] },
  content: { flex: 1, minHeight: 0, backgroundColor: theme.colors.surfaceSidebar },
}));
