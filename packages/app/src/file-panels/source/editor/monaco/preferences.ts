import type { editor } from "monaco-editor";
import { editorWordWrap, type EditorPreferences } from "../preferences";
import type { MonacoTheme } from "./messages";

export function monacoPreferences(
  preferences: EditorPreferences,
  theme: MonacoTheme,
  filename: string,
): editor.IEditorOptions {
  return {
    fontFamily: preferences.fontFamily || theme.monoFont,
    fontSize: preferences.fontSize ?? theme.codeFontSize,
    lineHeight: preferences.lineHeight,
    letterSpacing: preferences.letterSpacing,
    fontLigatures: preferences.fontLigatures,
    wordWrap: editorWordWrap(preferences, filename),
    lineNumbers: preferences.lineNumbers,
    renderWhitespace: preferences.renderWhitespace,
    renderLineHighlight:
      preferences.renderLineHighlight === "line" || preferences.renderLineHighlight === "all"
        ? "line"
        : "none",
    folding: preferences.folding,
    scrollBeyondLastLine: preferences.scrollBeyondLastLine,
    minimap: { enabled: preferences.minimap },
    stickyScroll: { enabled: preferences.stickyScroll },
    bracketPairColorization: { enabled: preferences.rainbowBrackets },
    guides: {
      bracketPairs: preferences.bracketPairGuides,
      indentation: preferences.indentationGuides,
    },
    matchBrackets: preferences.matchBrackets ? "always" : "never",
    smoothScrolling: preferences.smoothScrolling,
    cursorStyle: preferences.cursorStyle,
    cursorBlinking: preferences.cursorBlinking,
    cursorSmoothCaretAnimation: preferences.smoothCaret ? "on" : "off",
    autoClosingBrackets: preferences.autoClosingBrackets ? "languageDefined" : "never",
    autoClosingQuotes: preferences.autoClosingQuotes ? "languageDefined" : "never",
    quickSuggestions: preferences.quickSuggestions,
    suggestOnTriggerCharacters: preferences.suggestOnTriggerCharacters,
    parameterHints: { enabled: preferences.parameterHints },
    selectionHighlight: preferences.selectionHighlight,
    mouseWheelZoom: preferences.mouseWheelZoom,
  };
}

type AppliedModelPreferences = Pick<
  EditorPreferences,
  "rainbowBrackets" | "detectIndentation" | "insertSpaces" | "tabSize"
>;
const appliedModelPreferences = new WeakMap<editor.ITextModel, AppliedModelPreferences>();

export function applyModelPreferences(
  model: editor.ITextModel | null,
  preferences: EditorPreferences,
) {
  if (!model) return;
  const previous = appliedModelPreferences.get(model);
  // Standalone Monaco keeps bracket colorization on the model separately from editor options.
  if (previous?.rainbowBrackets !== preferences.rainbowBrackets)
    model.updateOptions({
      bracketColorizationOptions: {
        enabled: preferences.rainbowBrackets,
        independentColorPoolPerBracketType: false,
      },
    });
  const indentationChanged =
    !previous ||
    previous.detectIndentation !== preferences.detectIndentation ||
    previous.insertSpaces !== preferences.insertSpaces ||
    previous.tabSize !== preferences.tabSize;
  if (indentationChanged) {
    if (preferences.detectIndentation)
      model.detectIndentation(preferences.insertSpaces, preferences.tabSize);
    else
      model.updateOptions({ insertSpaces: preferences.insertSpaces, tabSize: preferences.tabSize });
  }
  appliedModelPreferences.set(model, {
    rainbowBrackets: preferences.rainbowBrackets,
    detectIndentation: preferences.detectIndentation,
    insertSpaces: preferences.insertSpaces,
    tabSize: preferences.tabSize,
  });
}
