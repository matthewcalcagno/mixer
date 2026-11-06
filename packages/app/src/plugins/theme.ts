import type { PluginTheme } from "@mixer/plugin";
import type { Theme } from "@/styles/theme";

export function toPluginTheme(theme: Theme): PluginTheme {
  return {
    colorScheme: theme.colorScheme,
    typography: {
      fontFamily: theme.fontFamily.ui,
      monoFontFamily: theme.fontFamily.mono,
      base: theme.fontSize.base,
      chrome: theme.fontSize.chrome,
      small: theme.fontSize.sm,
      radius: theme.borderRadius.lg,
    },
    colors: {
      surface0: theme.colors.surface0,
      surface1: theme.colors.surface1,
      surface2: theme.colors.surface2,
      border: theme.colors.border,
      foreground: theme.colors.foreground,
      foregroundMuted: theme.colors.foregroundMuted,
      accent: theme.colors.accent,
      inputFocus: theme.colors.inputFocus,
      accentForeground: theme.colors.accentForeground,
      statusSuccess: theme.colors.statusSuccess,
      statusWarning: theme.colors.statusWarning,
      statusDanger: theme.colors.statusDanger,
    },
  };
}
