/* oxlint-disable import/no-unassigned-import -- Bootstrap modules register syntax providers. */
import * as monaco from "monaco-editor/esm/vs/editor/editor.api.js";
import "monaco-editor/esm/vs/basic-languages/typescript/typescript.contribution.js";
import "monaco-editor/esm/vs/basic-languages/javascript/javascript.contribution.js";
import "monaco-editor/esm/vs/basic-languages/css/css.contribution.js";
import "monaco-editor/esm/vs/basic-languages/html/html.contribution.js";
import "monaco-editor/esm/vs/basic-languages/markdown/markdown.contribution.js";
import "monaco-editor/esm/vs/basic-languages/python/python.contribution.js";
import "monaco-editor/esm/vs/basic-languages/shell/shell.contribution.js";
import "monaco-editor/esm/vs/basic-languages/yaml/yaml.contribution.js";
import { jsonDefaults } from "monaco-editor/esm/vs/language/json/monaco.contribution.js";
import { bundledLanguages, bundledLanguagesInfo } from "shiki/langs";
import {
  createTextMateHighlighter,
  registerTextMateLanguage,
} from "../../../packages/app/src/file-panels/source/editor/monaco/textmate.ts";
import {
  languageForFile,
  grammarForFile,
} from "../../../packages/app/src/file-panels/source/editor/monaco/language.ts";
import { monacoThemeColors } from "../../../packages/app/src/file-panels/source/editor/monaco/theme-colors.ts";
import { installEditorLayoutShortcuts } from "../../../packages/app/src/keyboard/editor-shortcuts-iframe.ts";
import { editorSyntaxThemes } from "../../../packages/app/src/styles/editor-syntax.ts";

installEditorLayoutShortcuts();

const workerUrl = URL.createObjectURL(new Blob([__EDITOR_WORKER__], { type: "text/javascript" }));
const jsonWorkerUrl = URL.createObjectURL(new Blob([__JSON_WORKER__], { type: "text/javascript" }));
self.MonacoEnvironment = {
  getWorker: (_id, label) => new Worker(label === "json" ? jsonWorkerUrl : workerUrl),
};
let editor;
let models;
let loaded = false;
let saving = false;
let baseline;
let applyingDiskUpdate = false;
let pinned = false;
let latestAppearance;
let pendingDiskUpdate;
const send = (message) => parent.postMessage({ source: "source-control-monaco", ...message }, "*");
const highlighter = createTextMateHighlighter();
jsonDefaults.setModeConfiguration({ ...jsonDefaults.modeConfiguration, tokens: false });
const registeredLanguages = new Set(monaco.languages.getLanguages().map((language) => language.id));
for (const language of [...__MONACO_LANGUAGES__, ...bundledLanguagesInfo]) {
  if (!registeredLanguages.has(language.id)) {
    monaco.languages.register(language);
    registeredLanguages.add(language.id);
  }
}
async function prepareLanguage(path) {
  const language = languageForFile(path, monaco.languages.getLanguages());
  const syntax = await highlighter;
  const grammarLanguage = grammarForFile(path, language);
  const loader = bundledLanguages[grammarLanguage];
  if (loader) {
    await syntax.loadLanguage(loader);
    registerTextMateLanguage({ monaco, highlighter: syntax, language, grammarLanguage });
  }
  return language;
}
function keepOpen() {
  if (!pinned) {
    pinned = true;
    send({ type: "pin" });
  }
}
function save() {
  if (
    !editor ||
    editor.getModifiedEditor().getOption(monaco.editor.EditorOption.readOnly) ||
    saving
  )
    return;
  saving = true;
  send({ type: "save", content: models.modified.getValue(), revision: baseline });
}
function primeSyntax() {
  if (!editor) return;
  for (const pane of [editor.getOriginalEditor(), editor.getModifiedEditor()]) {
    const model = pane.getModel();
    if (!model) continue;
    let end = Math.min(pane.getVisibleRanges().at(-1)?.endLineNumber ?? 1, model.getLineCount());
    while (end > 1 && model.getLineLength(end) > 20_000) end -= 1;
    if (model.getLineLength(end) <= 20_000)
      monaco.editor.colorizeModelLine(model, end, model.getOptions().tabSize);
    pane.render(true);
  }
}
function applyBracketColors(enabled) {
  if (!editor || !models) return;
  editor.updateOptions({ bracketPairColorization: { enabled } });
  for (const model of [models.original, models.modified])
    model.updateOptions({
      bracketColorizationOptions: { enabled, independentColorPoolPerBracketType: false },
    });
}
function updateDisk(data) {
  if (!editor) {
    pendingDiskUpdate = data;
    return;
  }
  baseline = data.revision;
  editor.updateOptions({ renderSideBySide: data.original !== "", readOnly: !data.editable });
  if (models.original.getValue() !== data.original) models.original.setValue(data.original);
  if (models.modified.getValue() !== data.modified) {
    const state = editor.getModifiedEditor().saveViewState();
    applyingDiskUpdate = true;
    try {
      models.modified.setValue(data.modified);
    } finally {
      applyingDiskUpdate = false;
    }
    editor.getModifiedEditor().restoreViewState(state);
  }
  primeSyntax();
}
window.addEventListener("message", (messageEvent) => {
  if (messageEvent.source !== parent || messageEvent.data?.source !== "source-control-host") return;
  const data = messageEvent.data;
  if (data.type === "saved") {
    baseline = data.revision;
    saving = false;
    return;
  }
  if (data.type === "save-error") {
    saving = false;
    return;
  }
  if (data.type === "disk-update") {
    updateDisk(data);
    return;
  }
  if (data.type === "appearance") {
    latestAppearance = data;
    if (editor)
      void applyDiffTheme(data).catch((error) => send({ type: "error", message: String(error) }));
    return;
  }
  if (data.type !== "initialize" || loaded) return;
  loaded = true;
  latestAppearance = data;
  void initializeEditor(data).catch((error) =>
    send({ type: "error", message: error instanceof Error ? error.message : String(error) }),
  );
});

async function applyDiffTheme(data) {
  const syntax = await highlighter;
  const light = data.light;
  const { colorMap } = syntax.setTheme(editorSyntaxThemes[light ? "light" : "dark"].name);
  monaco.editor.defineTheme("mixer-source-control", {
    base: light ? "vs" : "vs-dark",
    inherit: true,
    rules: [],
    colors: monacoThemeColors({
      "editor.background": data.background,
      "editor.foreground": data.foreground,
      "editorGutter.background": data.background,
      "editorLineNumber.foreground": data.muted,
      "diffEditor.border": data.border,
      // GitHub Dark Turbo overrides VS Code's text highlights, but inherits its line colors.
      // https://github.com/dubesoftware/github-dark-turbo/blob/master/themes/GitHub%20Dark%20Turbo-color-theme.json
      "diffEditor.insertedLineBackground": "#9bb95533",
      "diffEditor.removedLineBackground": "#ff000033",
      "diffEditor.insertedTextBackground": light ? "#9ccc2c40" : "#28a74530",
      "diffEditor.removedTextBackground": light ? "#ff000033" : "#d73a4930",
    }),
  });
  monaco.editor.setTheme("mixer-source-control");
  monaco.languages.setColorMap(colorMap);
  applyBracketColors(data.bracketPairColorization);
  primeSyntax();
}

async function initializeEditor(data) {
  baseline = data.revision;
  const language = await prepareLanguage(data.path);
  await applyDiffTheme(latestAppearance);
  editor = monaco.editor.createDiffEditor(document.getElementById("editor"), {
    automaticLayout: true,
    renderSideBySide: data.original !== "",
    useInlineViewWhenSpaceIsLimited: false,
    originalEditable: false,
    readOnly: !data.editable,
    fontSize: 13,
    lineHeight: 21,
    fontFamily: "Menlo, Monaco, Consolas, monospace",
    minimap: { enabled: false },
    scrollBeyondLastLine: false,
    padding: { top: 10 },
    renderOverviewRuler: true,
    diffWordWrap: "off",
    stickyScroll: { enabled: false },
    enableSplitViewResizing: true,
    renderIndicators: true,
    hideUnchangedRegions: { enabled: false },
    "semanticHighlighting.enabled": false,
  });
  models = {
    original: monaco.editor.createModel(data.original, language),
    modified: monaco.editor.createModel(data.modified, language),
  };
  editor.setModel(models);
  applyBracketColors(latestAppearance.bracketPairColorization);
  models.modified.onDidChangeContent(() => {
    if (applyingDiskUpdate) return;
    keepOpen();
    send({ type: "changed", content: models.modified.getValue() });
  });
  for (const pane of [editor.getOriginalEditor(), editor.getModifiedEditor()]) {
    pane.onMouseDown((event) => {
      if (
        event.target.type === monaco.editor.MouseTargetType.CONTENT_TEXT ||
        event.target.type === monaco.editor.MouseTargetType.CONTENT_EMPTY ||
        event.target.type === monaco.editor.MouseTargetType.CONTENT_VIEW_ZONE
      )
        keepOpen();
    });
    pane.addAction({
      id: "source-control.keep-open",
      label: "Keep Editor Open",
      contextMenuGroupId: "navigation",
      contextMenuOrder: 0,
      run: keepOpen,
    });
  }
  editor.getModifiedEditor().addAction({
    id: "source-control.save",
    label: "Save Working Tree",
    keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS],
    contextMenuGroupId: "navigation",
    contextMenuOrder: 1,
    run: save,
  });
  window.addEventListener("keydown", (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
      event.preventDefault();
      save();
    }
  });
  editor.getModifiedEditor().focus();
  if (pendingDiskUpdate) {
    updateDisk(pendingDiskUpdate);
    pendingDiskUpdate = null;
  }
  await new Promise((resolve) => requestAnimationFrame(resolve));
  primeSyntax();
  document.getElementById("editor").style.visibility = "visible";
  send({ type: "mounted" });
}
window.addEventListener("beforeunload", () => {
  editor?.dispose();
  models?.original.dispose();
  models?.modified.dispose();
  URL.revokeObjectURL(workerUrl);
  URL.revokeObjectURL(jsonWorkerUrl);
});
send({ type: "ready" });
