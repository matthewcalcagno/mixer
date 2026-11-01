import type { ReactNode } from "react";
import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { workspaceIslandStyles } from "@/styles/workspace-islands";

/** The host owns main-view chrome; contributed content cannot replace the island frame. */
export function MainPanelIsland({ children, testID }: { children?: ReactNode; testID?: string }) {
  return (
    <View style={[styles.surface, workspaceIslandStyles.frame]} testID={testID}>
      {children}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  surface: { flex: 1, backgroundColor: theme.colors.surface0 },
}));
