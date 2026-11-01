import type { LayoutRectangle, StyleProp, ViewStyle } from "react-native";

export interface DesktopFrameStyleInput {
  presentation?: "anchored" | "quick-pick";
  viewport?: { width: number; height: number; top: number };
  quickPickBounds?: LayoutRectangle;
  desktopMinWidth: number | undefined;
  desktopLockWidth: boolean;
  referenceWidth: number | null;
  desktopFixedHeight: number | undefined;
  desktopPositionStyle: StyleProp<ViewStyle>;
  shouldHideDesktopContent: boolean;
  availableHeight: number | undefined;
}

export function buildDesktopFrameStyle(input: DesktopFrameStyleInput): StyleProp<ViewStyle> {
  if (input.presentation === "quick-pick" && input.viewport) {
    const bounds = input.quickPickBounds ?? {
      x: 0,
      y: 0,
      width: input.viewport.width,
      height: input.viewport.height,
    };
    const width = Math.min(600, Math.max(0, bounds.width - 32));
    return {
      position: "absolute",
      top: bounds.y + input.viewport.top,
      left: bounds.x + (bounds.width - width) / 2,
      width,
      minWidth: width,
      maxWidth: width,
      maxHeight: Math.max(0, Math.min(560, bounds.height - input.viewport.top - 24)),
    };
  }
  const {
    desktopMinWidth,
    desktopLockWidth,
    referenceWidth,
    desktopFixedHeight,
    desktopPositionStyle,
    shouldHideDesktopContent,
    availableHeight,
  } = input;
  const fixedHeightStyle =
    desktopFixedHeight != null
      ? { minHeight: desktopFixedHeight, maxHeight: desktopFixedHeight }
      : null;
  const hiddenStyle = shouldHideDesktopContent ? { opacity: 0 } : null;
  const availableHeightStyle =
    typeof availableHeight === "number"
      ? { maxHeight: Math.min(availableHeight, desktopFixedHeight ?? 400) }
      : null;
  const floor = Math.max(desktopMinWidth ?? 0, referenceWidth ?? 200);
  const widthStyle = desktopLockWidth
    ? { width: floor, minWidth: floor, maxWidth: floor }
    : { minWidth: floor, maxWidth: Math.max(400, floor) };
  return [
    {
      position: "absolute" as const,
      ...widthStyle,
    },
    fixedHeightStyle,
    desktopPositionStyle,
    hiddenStyle,
    availableHeightStyle,
  ];
}
