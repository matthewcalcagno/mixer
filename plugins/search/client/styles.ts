import { StyleSheet } from "react-native";
import type { PluginTheme } from "@mixer/plugin";

export function createStyles(theme: PluginTheme) {
  const c = theme.colors;
  return StyleSheet.create({
    panel: { flex: 1, minHeight: 0 },
    inputs: { paddingHorizontal: 10, paddingVertical: 6, gap: 6 },
    queryFrame: {
      flexDirection: "row",
      alignItems: "center",
      borderWidth: 1,
      borderColor: c.border,
      backgroundColor: c.surface1,
      borderRadius: 3,
      minHeight: 30,
      paddingRight: 2,
    },
    query: {
      outlineWidth: 0,
      flex: 1,
      minWidth: 0,
      color: c.foreground,
      fontSize: 13,
      paddingHorizontal: 7,
      paddingVertical: 5,
    },
    label: { color: c.foregroundMuted, fontSize: 11, marginTop: 4 },
    filterFrame: {
      flexDirection: "row",
      alignItems: "center",
      borderWidth: 1,
      borderColor: c.border,
      backgroundColor: c.surface1,
      borderRadius: 3,
      paddingRight: 2,
      minHeight: 28,
    },
    filter: {
      outlineWidth: 0,
      flex: 1,
      minWidth: 0,
      color: c.foreground,
      fontSize: 12,
      paddingHorizontal: 7,
      paddingVertical: 5,
    },
    focusedFrame: {
      borderColor: "transparent",
      outlineColor: c.inputFocus,
      outlineStyle: "solid",
      outlineWidth: 2,
      outlineOffset: -2,
    },
    summary: { color: c.foregroundMuted, fontSize: 12, paddingHorizontal: 12, paddingVertical: 7 },
    error: { color: c.statusDanger, fontSize: 12, padding: 12 },
    list: { flex: 1, minHeight: 0 },
    file: { height: 24, flexDirection: "row", alignItems: "center", paddingHorizontal: 8, gap: 5 },
    chevron: { width: 14, flexShrink: 0 },
    filename: { color: c.foreground, fontSize: 13, flexShrink: 1 },
    directory: { color: c.foregroundMuted, fontSize: 11, flex: 1 },
    badge: { color: c.foregroundMuted, fontSize: 11, paddingHorizontal: 5, marginLeft: "auto" },
    hit: {
      height: 24,
      flexDirection: "row",
      alignItems: "center",
      paddingLeft: 32,
      paddingRight: 8,
      gap: 7,
    },
    line: { color: c.foregroundMuted, fontSize: 11, minWidth: 26, textAlign: "right" },
    preview: { color: c.foregroundMuted, fontSize: 12, flex: 1 },
    highlight: { color: c.accent, fontWeight: "600", backgroundColor: c.surface2 },
    pressed: { backgroundColor: c.surface2 },
    footer: { color: c.foregroundMuted, fontSize: 10, paddingHorizontal: 12, paddingVertical: 5 },
  });
}
export type SearchStyles = ReturnType<typeof createStyles>;
