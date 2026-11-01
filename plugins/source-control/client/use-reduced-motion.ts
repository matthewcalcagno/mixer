import { useSyncExternalStore } from "react";
import { AccessibilityInfo } from "react-native";

let reduced = true;
const listeners = new Set<() => void>();
let subscription: ReturnType<typeof AccessibilityInfo.addEventListener> | null = null;
function update(value: boolean) {
  if (reduced === value) return;
  reduced = value;
  for (const listener of listeners) listener();
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  if (listeners.size === 1) {
    subscription = AccessibilityInfo.addEventListener("reduceMotionChanged", update);
    void AccessibilityInfo.isReduceMotionEnabled().then(update, () => update(true));
  }
  return () => {
    listeners.delete(listener);
    if (!listeners.size) {
      subscription?.remove();
      subscription = null;
    }
  };
}
export function useReducedMotion() {
  return useSyncExternalStore(subscribe, () => reduced);
}
