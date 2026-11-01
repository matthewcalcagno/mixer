export function resolveDesktopViewportInset(input: {
  windowHeight: number;
  viewportHeight: number;
  viewportTop: number;
  scale: number;
}): number {
  if (input.scale !== 1) return 0;
  return Math.max(0, input.windowHeight - input.viewportHeight - input.viewportTop);
}

/** Distance the translated surface moves when the desktop viewport is occluded. */
export function resolveKeyboardLift(input: {
  shift: number;
  enabled: boolean;
  bottomClearance: number;
}): number {
  "worklet";
  return input.enabled ? Math.max(0, input.shift - input.bottomClearance) : 0;
}
