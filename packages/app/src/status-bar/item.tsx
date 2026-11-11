import { WORKSPACE_STATUS_BAR_HEIGHT } from "@/constants/layout";
import { useCallback, useMemo, useState, type ReactNode } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { PressHighlight } from "@/components/ui/press-highlight";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { LoadingSpinner } from "@/components/ui/loading-spinner";

interface StatusEntryProps {
  label: string;
  tooltip: string;
  accessibilityLabel?: string;
  icon?: ReactNode;
  color: string;
  onPress?: () => void;
  disabled?: boolean;
  pending?: boolean;
  testID?: string;
}
export function StatusEntry({
  label,
  tooltip,
  accessibilityLabel,
  icon,
  color,
  onPress,
  disabled = false,
  pending = false,
  testID,
}: StatusEntryProps) {
  const [hovered, setHovered] = useState(false);
  const enter = useCallback(() => setHovered(true), []);
  const leave = useCallback(() => setHovered(false), []);
  const textStyle = useMemo(() => ({ color }), [color]);
  const state = useMemo(
    () => ({ disabled: disabled || pending, busy: pending }),
    [disabled, pending],
  );
  const itemStyle = useCallback(
    ({ pressed }: { pressed: boolean }) => [
      styles.item,
      (hovered || pressed) && styles.hover,
      disabled && styles.disabled,
    ],
    [hovered, disabled],
  );
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <PressHighlight
          accessibilityRole={onPress ? "button" : "text"}
          accessibilityLabel={accessibilityLabel ?? tooltip}
          accessibilityState={state}
          disabled={disabled || pending}
          onPress={onPress}
          onHoverIn={enter}
          onHoverOut={leave}
          style={itemStyle}
          testID={testID}
        >
          {pending ? <LoadingSpinner color={color} size={12} /> : icon}
          {!!label && (
            <Text style={[styles.text, textStyle]} numberOfLines={1}>
              {label}
            </Text>
          )}
        </PressHighlight>
      </TooltipTrigger>
      <TooltipContent side="top">
        <Text style={styles.tooltip}>{tooltip}</Text>
      </TooltipContent>
    </Tooltip>
  );
}
const styles = StyleSheet.create((theme) => ({
  item: {
    height: WORKSPACE_STATUS_BAR_HEIGHT,
    minWidth: 0,
    maxWidth: 360,
    paddingHorizontal: 5,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    flexShrink: 1,
  },
  text: { fontSize: theme.fontSize.sm, minWidth: 0, flexShrink: 1 },
  hover: { backgroundColor: theme.colors.interactionHighlight },
  disabled: { opacity: 0.5 },
  tooltip: { color: theme.colors.foreground, fontSize: theme.fontSize.sm },
  custom: {
    height: WORKSPACE_STATUS_BAR_HEIGHT,
    paddingHorizontal: 5,
    maxWidth: 400,
    minWidth: 0,
    overflow: "hidden",
    flexShrink: 1,
    justifyContent: "center",
  },
}));
export function CustomStatusFrame({ children, testID }: { children: ReactNode; testID: string }) {
  return (
    <View style={styles.custom} testID={testID}>
      {children}
    </View>
  );
}
