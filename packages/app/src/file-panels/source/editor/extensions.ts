import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import {
  bracketMatching,
  defaultHighlightStyle,
  indentOnInput,
  syntaxHighlighting,
  foldGutter,
  foldKeymap,
  foldService,
  indentUnit,
} from "@codemirror/language";
import {
  EditorView,
  drawSelection,
  highlightActiveLine,
  keymap,
  lineNumbers,
  scrollPastEnd,
  highlightActiveLineGutter,
  highlightWhitespace,
  highlightTrailingWhitespace,
  gutter,
  GutterMarker,
} from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import {
  DEFAULT_EDITOR_PREFERENCES,
  editorActiveLineColor,
  editorLineNumberColors,
  editorWordWrap,
  type EditorPreferences,
} from "./preferences";
import { createCodeMirrorHighlightStyle, type HighlightStyle } from "@mixer/highlight";
import { foldByIndentation } from "./folding";

export interface EditorVisualTheme {
  colorScheme: "light" | "dark";
  background: string;
  foreground: string;
  cursor: string;
  foregroundMuted: string;
  border: string;
  selection: string;
  monoFont: string;
  codeFontSize: number;
  syntax: Record<HighlightStyle, string>;
}

export function editorBaseExtensions(onSave: () => void) {
  return [
    history(),
    drawSelection(),
    indentOnInput(),
    syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
    keymap.of([
      { key: "Mod-s", preventDefault: true, run: () => (onSave(), true) },
      indentWithTab,
      ...defaultKeymap,
      ...historyKeymap,
    ]),
  ];
}

export function editorTheme(
  theme: EditorVisualTheme,
  preferences: EditorPreferences = DEFAULT_EDITOR_PREFERENCES,
) {
  return [
    EditorView.theme(
      {
        "&": {
          height: "100%",
          backgroundColor: theme.background,
          color: theme.foreground,
          fontFamily: preferences.fontFamily || theme.monoFont,
          fontSize: `${preferences.fontSize ?? theme.codeFontSize}px`,
          letterSpacing: `${preferences.letterSpacing}px`,
          fontVariantLigatures: preferences.fontLigatures ? "normal" : "none",
        },
        ".cm-scroller": {
          overflow: "auto",
          fontFamily: preferences.fontFamily || theme.monoFont,
          lineHeight: String(preferences.lineHeight),
        },
        ".cm-panels": { backgroundColor: theme.background, color: theme.foreground },
        ".cm-panels-top": { borderBottom: "none" },
        ".cm-searchMatch": { backgroundColor: theme.selection },
        ".cm-searchMatch-selected": {
          backgroundColor: theme.selection,
          outline: `1px solid ${theme.cursor}`,
        },
        ".cm-content": { caretColor: theme.foreground, padding: "16px 0" },
        ".cm-line": { paddingLeft: "12px", paddingRight: "16px" },
        ".cm-cursor, .cm-dropCursor": { borderLeftColor: theme.cursor },
        ".cm-gutters": {
          backgroundColor: theme.background,
          color: theme.foregroundMuted,
          borderRight: "none",
          paddingLeft: "12px",
        },
        ".cm-activeLine": { backgroundColor: editorActiveLineColor(theme.colorScheme) },
        ".cm-lineNumbers": { color: editorLineNumberColors(theme.colorScheme).inactive },
        ".cm-activeLineGutter": {
          backgroundColor: "transparent",
          color: editorLineNumberColors(theme.colorScheme).active,
        },
        ".cm-trailingSpace": {
          backgroundColor: "transparent",
          backgroundImage: `radial-gradient(circle at 50% 55%, ${theme.foregroundMuted} 15%, transparent 20%)`,
          backgroundSize: "1ch 100%",
          backgroundRepeat: "repeat-x",
        },
        "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground": {
          backgroundColor: theme.selection,
        },
        ".cm-selectionBackground, ::selection": {
          backgroundColor: theme.selection,
        },
        "&.cm-focused": { outline: "none" },
      },
      { dark: theme.colorScheme === "dark" },
    ),
    syntaxHighlighting(createCodeMirrorHighlightStyle(theme.syntax)),
  ];
}

export function editorPreferenceExtensions(preferences: EditorPreferences, filename: string) {
  return [
    configuredLineNumbers(preferences.lineNumbers),
    preferences.folding
      ? [foldGutter(), foldService.of(foldByIndentation), keymap.of(foldKeymap)]
      : [],
    preferences.scrollBeyondLastLine ? scrollPastEnd() : [],
    preferences.matchBrackets ? bracketMatching() : [],
    preferences.renderLineHighlight === "line" || preferences.renderLineHighlight === "all"
      ? highlightActiveLine()
      : [],
    preferences.renderLineHighlight === "gutter" || preferences.renderLineHighlight === "all"
      ? highlightActiveLineGutter()
      : [],
    preferences.renderWhitespace === "all" ? highlightWhitespace() : [],
    preferences.renderWhitespace === "trailing" ? highlightTrailingWhitespace() : [],
    preferences.autoClosingBrackets ? [closeBrackets(), keymap.of(closeBracketsKeymap)] : [],
    EditorState.tabSize.of(preferences.tabSize),
    indentUnit.of(preferences.insertSpaces ? " ".repeat(preferences.tabSize) : "\t"),
    editorWordWrap(preferences, filename) === "on" ? EditorView.lineWrapping : [],
  ];
}

class RelativeLineNumber extends GutterMarker {
  constructor(readonly number: number) {
    super();
  }
  eq(other: RelativeLineNumber) {
    return this.number === other.number;
  }
  toDOM(view: EditorView) {
    return view.dom.ownerDocument.createTextNode(String(this.number));
  }
}

function configuredLineNumbers(mode: EditorPreferences["lineNumbers"]) {
  if (mode === "off") return [];
  if (mode === "on") return lineNumbers();
  return gutter({
    class: "cm-lineNumbers",
    lineMarker(view, line) {
      const current = view.state.doc.lineAt(view.state.selection.main.head).number;
      const number = view.state.doc.lineAt(line.from).number;
      return new RelativeLineNumber(Math.abs(number - current) || number);
    },
    lineMarkerChange: (update) => update.selectionSet,
    initialSpacer: (view) => new RelativeLineNumber(view.state.doc.lines),
  });
}
