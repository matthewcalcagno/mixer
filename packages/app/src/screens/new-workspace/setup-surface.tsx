import type { ReactNode } from "react";
import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { MainPanelIsland } from "@/components/main-panel-island";

/** Setup owns only the main surface; Explorer is mounted by the workspace screen after creation. */
export function NewWorkspaceSetupSurface({
  isCompact,
  children,
}: {
  isCompact: boolean;
  children: ReactNode;
}) {
  if (isCompact) return children;
  return (
    <View style={styles.container} testID="new-workspace-setup-surface">
      <MainPanelIsland testID="new-workspace-main-island">{children}</MainPanelIsland>
    </View>
  );
}
const styles = StyleSheet.create((theme) => ({
  container: { flex: 1, minHeight: 0, backgroundColor: theme.colors.background },
}));
