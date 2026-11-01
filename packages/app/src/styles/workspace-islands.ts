import { StyleSheet } from "react-native-unistyles";

export const workspaceIslandStyles = StyleSheet.create((theme) => ({
  frame: {
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
    overflow: "hidden",
    minWidth: 0,
    minHeight: 0,
  },
  gutters: {
    gap: theme.spacing[1.5],
  },
}));
