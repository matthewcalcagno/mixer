// Shared by workspace tabs and embedded plugin editors.
export const TAB_CHIP_HORIZONTAL_PADDING = 8;
export const TAB_CHIP_GAP = 2;
export const TAB_CHIP_HEIGHT = 24;
export const TAB_ROW_PADDING_HORIZONTAL = 4;

export function createEditorTabStyles(theme: Theme) {
  return {
    tab: {
      height: TAB_CHIP_HEIGHT,
      paddingHorizontal: TAB_CHIP_HORIZONTAL_PADDING,
      borderRadius: theme.borderRadius.base,
      flexDirection: "row",
      alignItems: "center",
      gap: theme.spacing[1],
      userSelect: "none",
    },
    tabDense: { height: TAB_CHIP_HEIGHT - theme.spacing[1], borderRadius: theme.borderRadius.sm },
    tabLabel: {
      flexShrink: 1,
      minWidth: 0,
      color: theme.colors.foregroundMuted,
      fontSize: theme.fontSize.chrome,
      fontWeight: theme.fontWeight.normal,
      userSelect: "none",
    },
    tabLabelActive: { color: theme.colors.foreground },
  } as const;
}
import type { Theme } from "@/styles/theme";
