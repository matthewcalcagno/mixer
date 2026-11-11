import { z } from "zod";

/** Local preferences, shared by storage and the trusted editor-frame boundary. */
export const editorPreferencesSchema = z.object({
  fontFamily: z
    .string()
    .max(200)
    .catch("JetBrains Mono, SF Mono, Menlo, Monaco, 'Courier New', monospace"),
  fontSize: z.number().min(8).max(40).nullable().catch(14.3),
  lineHeight: z.number().min(1).max(3).catch(1.6),
  letterSpacing: z.number().min(-2).max(10).catch(0),
  fontLigatures: z.boolean().catch(true),
  tabSize: z.number().int().min(1).max(8).catch(4),
  insertSpaces: z.boolean().catch(true),
  detectIndentation: z.boolean().catch(true),
  fileAssociations: z.record(z.string().max(512), z.string().max(64)).catch({}),
  wordWrap: z.enum(["default", "off", "on"]).catch("default"),
  lineNumbers: z.enum(["on", "off", "relative"]).catch("on"),
  renderWhitespace: z.enum(["none", "trailing", "all"]).catch("none"),
  renderLineHighlight: z.enum(["none", "gutter", "line", "all"]).catch("line"),
  folding: z.boolean().catch(true),
  scrollBeyondLastLine: z.boolean().catch(true),
  minimap: z.boolean().catch(false),
  stickyScroll: z.boolean().catch(false),
  gitBlame: z.boolean().catch(true),
  gitCodeLens: z.boolean().catch(true),
  gitHover: z.boolean().catch(true),
  rainbowBrackets: z.boolean().catch(true),
  bracketPairGuides: z.boolean().catch(true),
  indentationGuides: z.boolean().catch(true),
  matchBrackets: z.boolean().catch(true),
  smoothScrolling: z.boolean().catch(false),
  cursorStyle: z
    .enum(["line", "block", "underline", "line-thin", "block-outline", "underline-thin"])
    .catch("line"),
  cursorBlinking: z.enum(["blink", "smooth", "phase", "expand", "solid"]).catch("blink"),
  smoothCaret: z.boolean().catch(false),
  autoClosingBrackets: z.boolean().catch(true),
  autoClosingQuotes: z.boolean().catch(true),
  quickSuggestions: z.boolean().catch(true),
  suggestOnTriggerCharacters: z.boolean().catch(true),
  parameterHints: z.boolean().catch(true),
  selectionHighlight: z.boolean().catch(true),
  mouseWheelZoom: z.boolean().catch(false),
});

export type EditorPreferences = z.infer<typeof editorPreferencesSchema>;
export const DEFAULT_EDITOR_PREFERENCES = editorPreferencesSchema.parse({});

export function editorActiveLineColor(colorScheme: "dark" | "light"): string {
  return colorScheme === "dark" ? "#272a2e" : "#eaeef2";
}

export function editorLineNumberColors(colorScheme: "dark" | "light") {
  return colorScheme === "dark"
    ? { inactive: "#55555e", active: "#f0f0f2" }
    : { inactive: "#85858d", active: "#24292f" };
}

export function editorWordWrap(preferences: EditorPreferences, filename: string): "on" | "off" {
  if (preferences.wordWrap !== "default") return preferences.wordWrap;
  return /\.(md|markdown)$/i.test(filename) ? "on" : "off";
}
