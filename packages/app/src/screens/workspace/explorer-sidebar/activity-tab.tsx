import { useCallback, useMemo, useState, type ReactNode } from "react";
import { ScrollView, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { ContextMenu, ContextMenuTrigger } from "@/components/ui/context-menu";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { buttonControlHeight } from "@/components/ui/control-geometry";
import { WORKSPACE_SECONDARY_HEADER_HEIGHT, useIsCompactFormFactor } from "@/constants/layout";
import { resolveWorkspaceTabChipBackdrop } from "../workspace-tab-chip-backdrop";
import { ICON_SIZE } from "@/styles/theme";

export function ExplorerActivityRail({
  children,
  testID,
}: {
  children: ReactNode;
  testID?: string;
}) {
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      style={styles.rail}
      contentContainerStyle={styles.items}
      testID={testID}
    >
      {children}
    </ScrollView>
  );
}
export function ExplorerActivityTab({
  label,
  selected,
  focused = true,
  onPress,
  children,
  menu,
  testID,
}: {
  label: string;
  selected: boolean;
  focused?: boolean;
  onPress(): void;
  children: ReactNode;
  menu?: ReactNode;
  testID: string;
}) {
  const compact = useIsCompactFormFactor();
  const [hovered, setHovered] = useState(false);
  const enter = useCallback(() => setHovered(true), []);
  const leave = useCallback(() => setHovered(false), []);
  const state = useMemo(() => ({ selected }), [selected]);
  const backdrop = resolveWorkspaceTabChipBackdrop({
    rail: "sidebar",
    isActiveFocused: selected && focused,
    isFilled: selected || hovered,
  });
  const style = useMemo(
    () => [styles.button, styles.fill(backdrop), { width: compact ? 44 : buttonControlHeight.xs }],
    [backdrop, compact],
  );
  return (
    <View style={styles.slot}>
      <ContextMenu>
        <Tooltip delayDuration={400} enabledOnDesktop enabledOnMobile={false}>
          <TooltipTrigger asChild triggerRefProp="triggerRef">
            <ContextMenuTrigger
              style={style}
              onPress={onPress}
              onHoverIn={enter}
              onHoverOut={leave}
              accessibilityRole="button"
              accessibilityLabel={label}
              accessibilityState={state}
              aria-selected={selected}
              testID={testID}
            >
              <View style={styles.icon}>{children}</View>
            </ContextMenuTrigger>
          </TooltipTrigger>
          <TooltipContent side="bottom" align="center" offset={8}>
            <Text style={styles.tooltip}>{label}</Text>
          </TooltipContent>
        </Tooltip>
        {menu}
      </ContextMenu>
    </View>
  );
}
const styles = StyleSheet.create((theme) => ({
  rail: {
    height: WORKSPACE_SECONDARY_HEADER_HEIGHT,
    flexGrow: 0,
    backgroundColor: theme.colors.surfaceSidebar,
  },
  items: { flexDirection: "row", alignItems: "center", paddingHorizontal: 6, gap: 4 },
  slot: { position: "relative" },
  button: {
    height: buttonControlHeight.xs,
    paddingHorizontal: theme.spacing[1],
    borderRadius: theme.borderRadius.md,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    userSelect: "none",
  },
  fill: (backdrop: ReturnType<typeof resolveWorkspaceTabChipBackdrop>) => ({
    backgroundColor: theme.colors[backdrop],
  }),
  icon: {
    width: ICON_SIZE.md,
    height: ICON_SIZE.md,
    alignItems: "center",
    justifyContent: "center",
  },
  tooltip: { color: theme.colors.foreground, fontSize: theme.fontSize.sm },
}));
