import { createElement, useEffect, useMemo, useState, type ReactNode } from "react";
import type { ViewStyle } from "react-native";
import { useAnimatedStyle, useSharedValue, type SharedValue } from "react-native-reanimated";
import { KeyboardShiftContext, SettledKeyboardShiftContext, useKeyboardShift } from "./context";
import { resolveDesktopViewportInset } from "./policy";

type KeyboardShiftMode = "translate" | "padding";

/** Track the Electron visual viewport, without native keyboard animation drivers. */
export function KeyboardShiftProvider({ children }: { children: ReactNode }) {
  const shift = useSharedValue(0);
  const layoutShift = useSharedValue(0);
  const isMoving = useSharedValue(false);
  const bottomInset = useSharedValue(0);
  const [settledShift, setSettledShift] = useState(0);
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    const update = () => {
      const inset = resolveDesktopViewportInset({
        windowHeight: window.innerHeight,
        viewportHeight: viewport.height,
        viewportTop: viewport.offsetTop,
        scale: viewport.scale,
      });
      shift.value = inset;
      layoutShift.value = inset;
      setSettledShift(inset);
    };
    update();
    viewport.addEventListener("resize", update);
    viewport.addEventListener("scroll", update);
    return () => {
      viewport.removeEventListener("resize", update);
      viewport.removeEventListener("scroll", update);
    };
  }, [layoutShift, shift]);
  const value = useMemo(
    () => ({ shift, layoutShift, isMoving, bottomInset }),
    [bottomInset, isMoving, layoutShift, shift],
  );
  return createElement(
    KeyboardShiftContext.Provider,
    { value },
    createElement(SettledKeyboardShiftContext.Provider, { value: settledShift }, children),
  );
}

export function useKeyboardShiftStyle(input: { mode: KeyboardShiftMode; enabled?: boolean }): {
  shift: SharedValue<number>;
  style: ReturnType<typeof useAnimatedStyle<ViewStyle>>;
} {
  const { shift, bottomInset } = useKeyboardShift();
  const { mode, enabled = true } = input;
  const style = useAnimatedStyle<ViewStyle>(() => {
    if (mode === "padding") return { paddingBottom: enabled ? bottomInset.value + shift.value : 0 };
    return { transform: [{ translateY: enabled ? -shift.value : 0 }] };
  }, [enabled, mode]);
  return { shift, style };
}
