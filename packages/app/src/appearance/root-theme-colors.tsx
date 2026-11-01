import { useEffect } from "react";
import { withUnistyles } from "react-native-unistyles";
import type { Theme } from "@/styles/theme";

export function RootThemeColors({ accent }: { accent: string }) {
  useEffect(() => {
    document.documentElement.style.setProperty("--mixer-accent", accent);
  }, [accent]);
  return null;
}

const themeColors = (theme: Theme) => ({ accent: theme.colors.accent });
const ThemedRootThemeColors = withUnistyles(RootThemeColors);

/** Keep global browser focus chrome in sync with built-in, adaptive, and plugin themes. */
export function AppearanceRootThemeColors() {
  return <ThemedRootThemeColors uniProps={themeColors} />;
}
