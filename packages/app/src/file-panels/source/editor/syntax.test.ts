// @vitest-environment jsdom
import { afterEach, describe, expect, test, vi } from "vitest";
import { syntaxFrame } from "./syntax";
import {
  editorActiveLineColor,
  editorLineNumberColors,
  editorPreferencesSchema,
} from "./preferences";
import { monacoPreferences } from "./monaco/preferences";
import { monacoThemeColor } from "./monaco/theme-colors";
import { createTextMateHighlighter } from "./monaco/textmate";
import { editorSyntaxThemes } from "@/styles/editor-syntax";
import typescriptGrammar from "shiki/langs/typescript.mjs";
import { EditorState, Compartment } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { indentUnit, foldedRanges, foldCode } from "@codemirror/language";
import { editorPreferenceExtensions, editorBaseExtensions } from "./extensions";

afterEach(() => vi.useRealTimers());

describe("syntax paint scheduling", () => {
  test("uses Turbo token colors in both modes without importing editor or token backgrounds", async () => {
    // Shiki adds its internal defaults when loading a registration. Inspect the authored
    // definitions before that normalization; Monaco still owns every editor UI color.
    for (const theme of Object.values(editorSyntaxThemes)) {
      expect(theme.colors).toEqual({
        "editor.foreground": theme.type === "dark" ? "#E1E4E8" : "#24292E",
      });
      for (const rule of theme.tokenColors ?? []) {
        expect(rule.settings).not.toHaveProperty("background");
      }
    }
    const highlighter = await createTextMateHighlighter();
    try {
      await highlighter.loadLanguage(typescriptGrammar);
      const code = 'const greeting = "hello"; // comment';
      for (const [theme, expected] of [
        ["github-turbo-dark", ["#F97583", "#9ECBFF", "#6A737D"]],
        ["github-turbo-light", ["#D73A49", "#032F62", "#586069"]],
        ["github-turbo-dark", ["#F97583", "#9ECBFF", "#6A737D"]],
      ] as const) {
        const { tokens } = highlighter.codeToTokens(code, { lang: "typescript", theme });
        expect(tokens[0].find((token) => token.content === "const")?.color).toBe(expected[0]);
        expect(tokens[0].find((token) => token.content.includes("hello"))?.color).toBe(expected[1]);
        expect(tokens[0].find((token) => token.content.includes("// comment"))?.color).toBe(
          expected[2],
        );
      }
    } finally {
      highlighter.dispose();
    }
  });

  test("mutes inactive line numbers while keeping the active number bright", () => {
    expect(editorLineNumberColors("dark")).toEqual({ inactive: "#55555e", active: "#f0f0f2" });
    expect(editorLineNumberColors("light")).toEqual({ inactive: "#85858d", active: "#24292f" });
  });
  test("uses the GitHub-style active line color independently of selection colors", () => {
    expect(editorActiveLineColor("dark")).toBe("#272a2e");
    expect(editorActiveLineColor("light")).toBe("#eaeef2");
  });
  test("converts translucent selection colors to Monaco hex without losing alpha", () => {
    expect(monacoThemeColor("rgba(255, 255, 255, 0.2)")).toBe("#ffffff33");
    expect(monacoThemeColor("rgba(0, 0, 0, 0.15)")).toBe("#00000026");
    expect(monacoThemeColor("#3a3d41")).toBe("#3a3d41ff");
  });
  test("disabling browser folding unfolds code and disables the folding shortcut", () => {
    const preferences = new Compartment();
    const view = new EditorView({
      state: EditorState.create({
        doc: "function example() {\n  return true;\n}\n",
        extensions: [
          editorBaseExtensions(() => {}),
          preferences.of(
            editorPreferenceExtensions(editorPreferencesSchema.parse({}), "example.ts"),
          ),
        ],
      }),
    });
    try {
      expect(foldCode(view)).toBe(true);
      expect(foldedRanges(view.state).size).toBe(1);
      view.dispatch({
        effects: preferences.reconfigure(
          editorPreferenceExtensions(
            editorPreferencesSchema.parse({ folding: false }),
            "example.ts",
          ),
        ),
      });
      expect(foldedRanges(view.state).size).toBe(0);
      expect(foldCode(view)).toBe(false);
    } finally {
      view.destroy();
    }
  });
  test("desktop preferences map to Monaco options, independently of shared fonts", () => {
    const preferences = editorPreferencesSchema.parse({
      fontSize: 18,
      fontFamily: "Fira Code",
      lineHeight: 1.8,
      rainbowBrackets: false,
      bracketPairGuides: false,
      minimap: true,
      quickSuggestions: false,
      wordWrap: "on",
    });
    const theme = {
      colorScheme: "dark",
      background: "#000",
      foreground: "#fff",
      cursor: "#fff",
      foregroundMuted: "#888",
      border: "#444",
      selection: "#333",
      monoFont: "monospace",
      codeFontSize: 12,
    } as const;
    expect(monacoPreferences(preferences, theme, "index.ts")).toMatchObject({
      fontFamily: "Fira Code",
      fontSize: 18,
      lineHeight: 1.8,
      wordWrap: "on",
      minimap: { enabled: true },
      bracketPairColorization: { enabled: false },
      guides: { bracketPairs: false },
      quickSuggestions: false,
    });
    const defaults = editorPreferencesSchema.parse({});
    expect(monacoPreferences(defaults, theme, "README.md")).toMatchObject({
      fontFamily: "monospace",
      fontSize: 12,
      wordWrap: "on",
    });
    expect(monacoPreferences(defaults, theme, "index.ts").wordWrap).toBe("off");
    expect(monacoPreferences(defaults, theme, "index.ts").renderLineHighlight).toBe("line");
    expect(
      monacoPreferences({ ...defaults, renderLineHighlight: "all" }, theme, "index.ts")
        .renderLineHighlight,
    ).toBe("line");
  });

  test("browser settings reconfigure indentation and wrapping without replacing the document or selection", () => {
    const preferences = new Compartment();
    const initial = editorPreferencesSchema.parse({});
    let state = EditorState.create({
      doc: "const kept = true;",
      selection: { anchor: 6 },
      extensions: preferences.of(editorPreferenceExtensions(initial, "index.ts")),
    });
    const updated = editorPreferencesSchema.parse({
      tabSize: 2,
      insertSpaces: false,
      wordWrap: "on",
      lineNumbers: "off",
      folding: false,
    });
    state = state.update({
      effects: preferences.reconfigure(editorPreferenceExtensions(updated, "index.ts")),
    }).state;
    expect(state.doc.toString()).toBe("const kept = true;");
    expect(state.selection.main.head).toBe(6);
    expect(state.facet(EditorState.tabSize)).toBe(2);
    expect(state.facet(indentUnit)).toBe("\t");
    const view = new EditorView({ state });
    try {
      expect(view.lineWrapping).toBe(true);
    } finally {
      view.destroy();
    }
  });
  test("closing an editor cancels its pending frame without waiting for another paint", async () => {
    vi.useFakeTimers();
    const lifetime = new AbortController();
    const pending = syntaxFrame(lifetime.signal);
    expect(vi.getTimerCount()).toBe(1);
    lifetime.abort();
    await pending;
    expect(vi.getTimerCount()).toBe(0);
  });
  test("an already closed editor does not schedule more rendering work", async () => {
    vi.useFakeTimers();
    const lifetime = new AbortController();
    lifetime.abort();
    await syntaxFrame(lifetime.signal);
    expect(vi.getTimerCount()).toBe(0);
  });
});
