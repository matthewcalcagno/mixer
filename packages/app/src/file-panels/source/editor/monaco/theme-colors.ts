import normalizeColor from "@react-native/normalize-colors";

/** Monaco parses theme colors as hex, not CSS. Its invalid-color fallback is bright red. */
export function monacoThemeColor(cssColor: string): string {
  const rgba = normalizeColor(cssColor);
  if (rgba === null) throw new Error(`Invalid editor theme color: ${cssColor}`);
  return `#${rgba.toString(16).padStart(8, "0")}`;
}

export function monacoThemeColors(colors: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, color] of Object.entries(colors)) result[name] = monacoThemeColor(color);
  return result;
}
