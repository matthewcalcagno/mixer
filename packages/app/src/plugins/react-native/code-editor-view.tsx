import { useEffect, useRef, useState } from "react";
import { withUnistyles } from "react-native-unistyles";
import { Annotation, Compartment, EditorState, Transaction } from "@codemirror/state";
import { EditorView, drawSelection, keymap } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { search, searchKeymap, SearchQuery, setSearchQuery } from "@codemirror/search";
import { forceParsing, syntaxTree } from "@codemirror/language";
import { linter, lintGutter, type Diagnostic } from "@codemirror/lint";
import { getLanguageForFile } from "@mixer/highlight";
import type { CodeEditorProps } from "@mixer/plugin/client/ui";
import { useAppSettings } from "@/hooks/use-settings";
import type { Theme } from "@/styles/theme";
import {
  editorTheme,
  editorPreferenceExtensions,
  type EditorVisualTheme,
} from "@/file-panels/source/editor/extensions";

import { variableExtensions } from "./code-editor-variables";
const externalUpdate = Annotation.define<boolean>();
const frameStyle = { height: "100%", minHeight: 0, minWidth: 0, overflow: "hidden" } as const;
function filename(language: CodeEditorProps["language"], sourceFilename?: string) {
  return sourceFilename ?? `buffer.${language === "javascript" ? "js" : language}`;
}
function jsonErrors(view: EditorView): Diagnostic[] {
  const text = view.state.doc.toString();
  try {
    JSON.parse(text);
    return [];
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid JSON";
    const nativePosition = /position (\d+)/.exec(message)?.[1];
    let syntaxPosition = text.length;
    syntaxTree(view.state).iterate({
      enter(node) {
        if (node.type.isError) syntaxPosition = Math.min(syntaxPosition, node.from);
      },
    });
    const from = Math.min(
      text.length,
      nativePosition === undefined ? syntaxPosition : Number(nativePosition),
    );
    return [{ from, to: Math.min(text.length, from + 1), severity: "error", message }];
  }
}
function formatJson(view: EditorView) {
  try {
    const text = JSON.stringify(JSON.parse(view.state.doc.toString()), null, 2);
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
    return true;
  } catch {
    return false;
  }
}
function CodeEditorView(props: CodeEditorProps & { visualTheme: EditorVisualTheme }) {
  const host = useRef<HTMLDivElement>(null);
  const editor = useRef<EditorView | null>(null);
  const { settings } = useAppSettings();
  const current = useRef({ props, preferences: settings.editor });
  current.current = { props, preferences: settings.editor };
  const themeSignature = JSON.stringify(props.visualTheme);
  const variablesSignature = JSON.stringify(props.variables);
  const [slots] = useState(() => ({
    theme: new Compartment(),
    language: new Compartment(),
    options: new Compartment(),
    variables: new Compartment(),
  }));
  useEffect(() => {
    if (!host.current) return;
    const view = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: current.current.props.value,
        extensions: [
          history(),
          drawSelection(),
          search({ top: true }),
          keymap.of([
            {
              key: "Shift-Alt-f",
              run: (activeView) =>
                !current.current.props.readOnly &&
                current.current.props.language === "json" &&
                formatJson(activeView),
            },
            ...defaultKeymap.filter((binding) => binding.key !== "Mod-Enter"),
            ...historyKeymap,
            ...searchKeymap,
            indentWithTab,
          ]),
          slots.theme.of([]),
          slots.language.of([]),
          slots.options.of([]),
          slots.variables.of([]),
          EditorView.updateListener.of((update) => {
            if (
              update.docChanged &&
              !update.transactions.some((transaction) => transaction.annotation(externalUpdate))
            )
              current.current.props.onChange?.(update.state.doc.toString());
          }),
        ],
      }),
    });
    editor.current = view;
    return () => {
      editor.current = null;
      view.destroy();
    };
  }, [slots]);
  useEffect(() => {
    if (props.autoFocus) editor.current?.focus();
  }, [props.autoFocus]);
  useEffect(() => {
    const view = editor.current;
    if (!view) return;
    const language = getLanguageForFile(filename(props.language, props.filename))?.extension ?? [];
    const validate = linter(
      (activeView) => {
        const diagnostics = jsonErrors(activeView);
        current.current.props.onDiagnostics?.(
          diagnostics.map((diagnostic) => ({
            message: diagnostic.message,
            line: activeView.state.doc.lineAt(diagnostic.from).number,
          })),
        );
        return diagnostics;
      },
      { delay: 200 },
    );
    let wordWrap = settings.editor.wordWrap;
    if (props.wrap !== undefined) wordWrap = props.wrap ? "on" : "off";
    const preferences = {
      ...settings.editor,
      wordWrap,
      renderLineHighlight: props.readOnly ? ("none" as const) : settings.editor.renderLineHighlight,
    };
    const variables = current.current.props.variables;
    view.dispatch({
      effects: [
        slots.variables.reconfigure(
          variables
            ? variableExtensions(variables, (name) =>
                current.current.props.onInspectVariable?.(name),
              )
            : [],
        ),
        slots.theme.reconfigure(editorTheme(current.current.props.visualTheme, preferences)),
        slots.language.reconfigure([
          language,
          props.language === "json" && !props.readOnly ? [validate, lintGutter()] : [],
        ]),
        slots.options.reconfigure([
          editorPreferenceExtensions(preferences, filename(props.language, props.filename)),
          EditorState.readOnly.of(Boolean(props.readOnly)),
          EditorView.editable.of(!props.readOnly),
          EditorView.contentAttributes.of({
            "aria-label": props.label,
            spellcheck: "false",
            tabindex: "0",
          }),
        ]),
      ],
    });
    forceParsing(view, Math.min(view.state.doc.length, 16000), 20);
    if (props.language !== "json" || props.readOnly) current.current.props.onDiagnostics?.([]);
  }, [
    slots,
    themeSignature,
    variablesSignature,
    props.language,
    props.filename,
    props.readOnly,
    props.wrap,
    props.label,
    settings.editor,
  ]);
  useEffect(() => {
    const view = editor.current;
    if (view && view.state.doc.toString() !== props.value) {
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: props.value },
        annotations: [
          externalUpdate.of(true),
          Transaction.addToHistory.of(!current.current.props.readOnly),
        ],
      });
      forceParsing(view, Math.min(view.state.doc.length, 16000), 20);
    }
  }, [props.value]);
  useEffect(() => {
    const view = editor.current;
    if (view && props.search !== undefined)
      view.dispatch({
        effects: setSearchQuery.of(new SearchQuery({ search: props.search, literal: true })),
      });
  }, [props.search]);
  return <div ref={host} style={frameStyle} data-testid="plugin-code-editor" />;
}
const appearance = (theme: Theme) => ({
  visualTheme: {
    colorScheme: theme.colorScheme,
    background: theme.colors.surface0,
    foreground: theme.colors.foreground,
    cursor: theme.colors.inputFocus,
    foregroundMuted: theme.colors.foregroundMuted,
    border: theme.colors.border,
    selection: theme.colors.terminal.selectionBackground,
    monoFont: theme.fontFamily.mono,
    codeFontSize: theme.fontSize.code,
    syntax: theme.colors.syntax,
  },
});
export default withUnistyles(CodeEditorView, appearance);
