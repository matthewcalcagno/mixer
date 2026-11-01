import type { BackPressSource } from "./visibility-tracker";
/**
 * Android's hardware Back press.
 *
 * iOS and web have no such press, and `react-native-web`'s `BackHandler` logs an error as soon as
 * anything subscribes, so nothing is registered off Android.
 */
export const systemBackPress: BackPressSource = {
  subscribe() {
    return () => {};
  },
};
