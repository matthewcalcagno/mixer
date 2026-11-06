import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { workspaceIslandStyles } from "@/styles/workspace-islands";

const WorkspaceWidthContext = createContext(0);
export function useWorkspaceWidth() {
  return useContext(WorkspaceWidthContext);
}

/** The host supplies either one island or the canvas for a multi-island workspace. */
export function MainPanelIsland({
  children,
  testID,
  framed = true,
  variant = "main",
}: {
  children?: ReactNode;
  testID?: string;
  framed?: boolean;
  variant?: "main" | "sidebar";
}) {
  const style = useMemo(
    () =>
      framed
        ? [styles.surface, workspaceIslandStyles.frame, variant === "sidebar" && styles.sidebar]
        : styles.canvas,
    [framed, variant],
  );
  return (
    <View style={style} testID={testID}>
      {children}
    </View>
  );
}
/** Use the same gutter and geometry as workspace content beside Explorer. */
export function WorkspaceLayout({ children, testID }: { children?: ReactNode; testID?: string }) {
  const [width, setWidth] = useState(0);
  const onLayout = useCallback<NonNullable<React.ComponentProps<typeof View>["onLayout"]>>(
    (event) => setWidth(event.nativeEvent.layout.width),
    [],
  );
  return (
    <WorkspaceWidthContext value={width}>
      <View
        style={[styles.workspace, workspaceIslandStyles.gutters]}
        testID={testID}
        onLayout={onLayout}
      >
        {children}
      </View>
    </WorkspaceWidthContext>
  );
}
const styles = StyleSheet.create((theme) => ({
  surface: { flex: 1, minWidth: 0, minHeight: 0, backgroundColor: theme.colors.surface0 },
  sidebar: { backgroundColor: theme.colors.surfaceSidebar },
  canvas: { flex: 1, minWidth: 0, minHeight: 0, backgroundColor: theme.colors.background },
  workspace: { flex: 1, minWidth: 0, minHeight: 0, flexDirection: "row", position: "relative" },
}));
