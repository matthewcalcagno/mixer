import * as monaco from "monaco-editor";
import {
  LEGACY_LANGUAGE_PROVIDERS,
  providerForDocument,
  providerForLanguage,
  type LanguageProvider,
} from "@mixer/protocol/language-services";
import { GitAnnotations } from "./git-annotations";
import { installErrorLens } from "./plugins/error-lens";
import { monacoThemeColors } from "./theme-colors";
import { monacoPreferences, applyModelPreferences } from "./preferences";
import { editorActiveLineColor, editorLineNumberColors } from "../preferences";
import { createTextMateHighlighter, registerTextMateLanguage } from "./textmate";
import { bundledLanguages, bundledLanguagesInfo } from "shiki/langs";
import { initVimMode, VimMode } from "monaco-vim";
import { connectJsonLanguageServer } from "./json-client";
import {
  connectProjectLanguageService,
  disableStandaloneTypeScriptServices,
} from "./project-language-client";
import {
  buildLanguageModes,
  resolveLanguageMode,
  languageServiceId,
  type LanguageMode,
} from "../language-modes";
import { isEditorCancellation } from "./errors";
import {
  editorCommandSchema,
  type EditorConfiguration,
  type EditorEvent,
  type MonacoTheme,
} from "./messages";

function emit(event: EditorEvent) {
  window.parent.postMessage(event, window.location.origin);
}

const MAX_TOKENIZATION_LINE_LENGTH = 20_000;

self.MonacoEnvironment = {
  getWorker(_moduleId, label) {
    let name = "editor";
    if (label === "typescript" || label === "javascript") name = "ts";
    else if (label === "json") name = "json";
    else if (["css", "scss", "less"].includes(label)) name = "css";
    else if (["html", "handlebars", "razor"].includes(label)) name = "html";
    return new Worker(new URL(`./${name}.worker.js`, window.location.href));
  },
};

let editor: monaco.editor.IStandaloneCodeEditor | null = null;
let textModel: monaco.editor.ITextModel | null = null;
let revision = 0;
let bufferVersion = 0;
let applyingUpdate = false;
let lineSeparator: EditorConfiguration["lineSeparator"] = "\n";
let vim: ReturnType<typeof initVimMode> | null = null;
let pendingConfiguration: EditorConfiguration | null = null;
let languageProviders: LanguageProvider[] = [];
let activeLanguageProvider = "";
let extendedLanguageFeatures = false;
let restartLanguageServices = false;
let configuring = false;
let disposed = false;
let jsonConnection: monaco.IDisposable | null = null;
let jsonConnectionAttempt = 0;
let jsonConnectionPending = false;
let projectConnection: monaco.IDisposable | null = null;
let gitAnnotations: GitAnnotations | null = null;
let errorLens: monaco.IDisposable | null = null;
let diffEditor: monaco.editor.IStandaloneDiffEditor | null = null;
let diffModels: monaco.editor.ITextModel[] = [];
let diffViewModel: monaco.editor.IDiffEditorViewModel | null = null;
let stateTimer: ReturnType<typeof setTimeout> | null = null;
let pendingReveal: { lineStart: number; lineEnd?: number } | null = null;

function saveViewState() {
  if (stateTimer) clearTimeout(stateTimer);
  stateTimer = null;
  const state = editor?.saveViewState();
  if (state) emit({ type: "view-state", state });
}

function reveal(location: { lineStart: number; lineEnd?: number }) {
  if (!editor || !textModel) {
    pendingReveal = location;
    return;
  }
  const start = Math.min(location.lineStart, textModel.getLineCount());
  const end = Math.max(start, Math.min(location.lineEnd ?? start, textModel.getLineCount()));
  editor.setSelection({
    startLineNumber: start,
    startColumn: 1,
    endLineNumber: end,
    endColumn: end === start ? 1 : textModel.getLineMaxColumn(end),
  });
  editor.revealLineInCenter(start, monaco.editor.ScrollType.Immediate);
}
let editorOwnsHistory = false;
function changeHistory(redo: boolean) {
  if (!editorOwnsHistory) {
    emit({ type: "history", redo });
    return;
  }
  if (redo) void textModel?.redo();
  else void textModel?.undo();
}
VimMode.commands.undo = () => changeHistory(false);
VimMode.commands.redo = () => changeHistory(true);
let pendingContent: Pick<
  EditorConfiguration,
  "content" | "revision" | "lineSeparator" | "bufferVersion"
> | null = null;

monaco.json.jsonDefaults.setModeConfiguration({
  completionItems: false,
  hovers: false,
  diagnostics: false,
  documentFormattingEdits: false,
  documentRangeFormattingEdits: false,
  documentSymbols: true,
  colors: true,
  foldingRanges: true,
  selectionRanges: true,
  tokens: false,
});
monaco.typescript.typescriptDefaults.setCompilerOptions({
  target: monaco.typescript.ScriptTarget.ESNext,
  module: monaco.typescript.ModuleKind.ESNext,
  jsx: monaco.typescript.JsxEmit.ReactJSX,
  allowNonTsExtensions: true,
  allowJs: true,
  strict: true,
});

// Shiki supplies the TextMate registry, embedded grammars, Oniguruma WASM, and
// Monaco's encoded token provider. All grammar chunks are bundled on this origin.
const highlighter = createTextMateHighlighter();
const tokenProviders = new Map<string, { grammar: string; provider: monaco.IDisposable }>();
let selectedLanguageMode: LanguageMode | null = null;
let appliedTheme: string | null = null;
const registeredLanguages = new Set(monaco.languages.getLanguages().map((language) => language.id));
for (const language of bundledLanguagesInfo) {
  if (!registeredLanguages.has(language.id))
    monaco.languages.register({ id: language.id, aliases: language.aliases });
}
const languageModes = buildLanguageModes(monaco.languages.getLanguages(), bundledLanguagesInfo);

async function configureTheme(theme: MonacoTheme) {
  const key = JSON.stringify([
    theme.colorScheme,
    theme.background,
    theme.foreground,
    theme.cursor,
    theme.foregroundMuted,
    theme.border,
    theme.selection,
  ]);
  // Reapplying Monaco's color map invalidates model tokens. Buffer/status updates and font
  // changes must not restart tokenization after the opening viewport has already been painted.
  if (key === appliedTheme) return;
  const syntax = await highlighter;
  const base = `github-turbo-${theme.colorScheme}`;
  const { colorMap } = syntax.setTheme(base);
  monaco.editor.defineTheme("mixer", {
    base: theme.colorScheme === "dark" ? "vs-dark" : "vs",
    inherit: true,
    rules: [],
    colors: monacoThemeColors({
      "editor.background": theme.background,
      "editor.foreground": theme.foreground,
      "editorCursor.foreground": theme.cursor,
      "editorLineNumber.foreground": editorLineNumberColors(theme.colorScheme).inactive,
      "editorLineNumber.activeForeground": editorLineNumberColors(theme.colorScheme).active,
      "editor.lineHighlightBorder": "#00000000",
      "editor.lineHighlightBackground": editorActiveLineColor(theme.colorScheme),
      "editor.selectionBackground": theme.selection,
      "editor.inactiveSelectionBackground": theme.selection,
      "editorWidget.background": theme.background,
      "editorWidget.border": theme.border,
      "editorSuggestWidget.background": theme.background,
      "editorSuggestWidget.foreground": theme.foreground,
      "editorSuggestWidget.border": theme.border,
    }),
  });
  monaco.editor.setTheme("mixer");
  monaco.languages.setColorMap(colorMap);
  appliedTheme = key;
}

async function configureLanguage(filename: string, selection?: LanguageMode): Promise<string> {
  const mode =
    selection ??
    resolveLanguageMode({
      filename,
      content: "",
      override: null,
      associations: {},
      modes: languageModes,
      registrations: monaco.languages.getLanguages(),
    });
  const language = mode.monacoId;
  if (!monaco.languages.getLanguages().some((item) => item.id === language))
    monaco.languages.register({ id: language });
  const syntax = await highlighter;
  if (disposed) return language;
  const grammarLanguage = mode.grammar;
  if (Object.hasOwn(bundledLanguages, grammarLanguage)) {
    // Narrow through Shiki's exported registry rather than asserting language IDs.
    const registration = Object.entries(bundledLanguages).find(([id]) => id === grammarLanguage);
    if (registration) {
      await syntax.loadLanguage(registration[1]);
      if (tokenProviders.get(language)?.grammar !== grammarLanguage) {
        tokenProviders.get(language)?.provider.dispose();
        const provider = registerTextMateLanguage({
          monaco,
          highlighter: syntax,
          language,
          grammarLanguage,
        });
        tokenProviders.set(language, { grammar: grammarLanguage, provider });
      }
    }
  }
  return language;
}

async function configureProviderLanguage(configuration: EditorConfiguration): Promise<string> {
  for (const provider of languageProviders)
    for (const document of provider.documents) {
      if (languageModes.some((mode) => mode.id === document.languageId)) continue;
      monaco.languages.register({
        id: document.languageId,
        extensions: document.extensions,
        filenames: document.filenames,
      });
      languageModes.push({
        id: document.languageId,
        label: provider.label,
        monacoId: document.languageId,
        grammar: "",
        extensions: document.extensions,
        filenames: document.filenames ?? [],
      });
    }
  languageModes.sort((a, b) => a.label.localeCompare(b.label));
  selectedLanguageMode = resolveLanguageMode({
    filename: configuration.filename,
    content: configuration.content,
    override: configuration.languageMode ?? null,
    providers: languageProviders,
    associations: configuration.preferences.fileAssociations,
    modes: languageModes,
    registrations: monaco.languages.getLanguages(),
  });
  // COMPAT(workspaceLanguageServices): added in v0.14.0, remove after 2027-04-29 with the old-host worker path.
  if (
    configuration.projectLanguageServices &&
    ["typescript", "javascript"].includes(selectedLanguageMode.monacoId)
  )
    disableStandaloneTypeScriptServices();
  return configureLanguage(configuration.filename, selectedLanguageMode);
}

async function configure(configuration: EditorConfiguration) {
  editorOwnsHistory = configuration.historyOwner === "editor";
  extendedLanguageFeatures = configuration.extendedLanguageFeatures === true;
  languageProviders = configuration.projectLanguageServices
    ? (configuration.languageProviders ?? LEGACY_LANGUAGE_PROVIDERS)
    : [];
  const language = await configureProviderLanguage(configuration);
  await configureTheme(configuration.theme);
  if (disposed) return;
  lineSeparator = configuration.lineSeparator;
  if (!editor) {
    const host = document.getElementById("editor");
    if (!host) throw new Error("Source editor container is missing.");
    const path = configuration.filename.replace(/\\/g, "/");
    const uri = monaco.Uri.from({ scheme: "file", path: path.startsWith("/") ? path : `/${path}` });
    textModel = monaco.editor.createModel(configuration.content, language, uri);
    editor = monaco.editor.create(host, {
      model: textModel,
      maxTokenizationLineLength: MAX_TOKENIZATION_LINE_LENGTH,
      automaticLayout: true,
      fontWeight: "400",
      lineNumbersMinChars: 3,
      lineDecorationsWidth: 12,
      renderLineHighlightOnlyWhenFocus: false,
      padding: { top: 16, bottom: 16 },
      overviewRulerBorder: false,
      scrollbar: {
        verticalScrollbarSize: 10,
        horizontalScrollbarSize: 10,
        useShadows: false,
      },
      "semanticHighlighting.enabled": false,
      fixedOverflowWidgets: true,
      ...monacoPreferences(configuration.preferences, configuration.theme, configuration.filename),
    });
    if (configuration.viewState) {
      try {
        editor.restoreViewState(configuration.viewState);
      } catch {
        emit({
          type: "view-state-error",
          message: "The saved editor position could not be restored.",
        });
      }
    }
    const location = pendingReveal ?? configuration.initialLocation;
    pendingReveal = null;
    if (location) reveal(location);
    editor.onDidChangeCursorSelection(saveViewState);
    editor.onDidLayoutChange(() => {
      if (!disposed && editor) renderHighlightedViewport(editor);
    });
    editor.onDidChangeHiddenAreas(saveViewState);
    editor.onDidBlurEditorWidget(saveViewState);
    editor.onDidScrollChange(() => {
      if (stateTimer) clearTimeout(stateTimer);
      stateTimer = setTimeout(saveViewState, 75);
    });
    revision = configuration.revision;
    bufferVersion = configuration.bufferVersion;
    if (pendingContent) {
      updateContent(pendingContent);
      pendingContent = null;
    }
    editor.onDidChangeModelContent(() => {
      if (applyingUpdate || !textModel) return;
      revision += 1;
      const content = textModel.getValue().replace(/\r\n|\r|\n/g, lineSeparator);
      const baseVersion = bufferVersion++;
      emit({ type: "change", content, revision, baseVersion });
    });
    registerEditingActions(editor);
    errorLens = installErrorLens(editor);
    gitAnnotations = new GitAnnotations({
      editor,
      model: textModel,
      configuration,
      emit,
      prepareDiffSyntax: async () => {
        await configureLanguage("git-history.diff");
      },
    });
  } else {
    if (textModel) monaco.editor.setModelLanguage(textModel, language);
    editor.updateOptions(
      monacoPreferences(configuration.preferences, configuration.theme, configuration.filename),
    );
    updateContent(configuration);
  }
  applyModelPreferences(textModel, configuration.preferences);
  if (textModel) updateJsonLanguageService(textModel);
  if (textModel)
    startProjectLanguageService({
      codeEditor: editor,
      model: textModel,
      filename: configuration.filename,
      restart: restartLanguageServices,
    });
  restartLanguageServices = false;
  gitAnnotations?.configure(configuration);
  configureVim(editor, configuration.vimEnabled);
  if (selectedLanguageMode)
    emit({
      type: "language-state",
      filename: configuration.filename,
      id: selectedLanguageMode.id,
      modes: languageModes,
    });
  renderHighlightedViewport(editor);
  emit({ type: "ready" });
}

function configureVim(codeEditor: monaco.editor.IStandaloneCodeEditor, enabled: boolean) {
  const status = document.getElementById("vim-status");
  if (enabled && !vim && status) {
    vim = initVimMode(codeEditor, status);
    vim.on("vim-mode-change", (event: unknown) => {
      if (
        typeof event === "object" &&
        event !== null &&
        "mode" in event &&
        typeof event.mode === "string"
      ) {
        emit({ type: "vim", mode: event.mode.toUpperCase() });
      }
    });
    emit({ type: "vim", mode: "NORMAL" });
  } else if (!enabled && vim) {
    vim.dispose();
    vim = null;
    emit({ type: "vim", mode: null });
  }
}

function renderHighlightedViewport(codeEditor: monaco.editor.ICodeEditor) {
  const model = codeEditor.getModel();
  if (!model) return;
  let end = 1;
  for (const range of codeEditor.getVisibleRanges()) end = Math.max(end, range.endLineNumber);
  end = Math.min(end, model.getLineCount());
  const maximum = MAX_TOKENIZATION_LINE_LENGTH;
  // Keep Monaco's long-line limit. The colorizer also builds HTML, so never use a giant
  // minified line merely to prime the cache for the otherwise visible short lines.
  while (end > 1 && model.getLineLength(end) > maximum) end -= 1;
  // This public API forces accurate TextMate state through the viewport, unlike idle/heuristic
  // tokenization. Discard its HTML; Monaco renders the model's now-populated token cache.
  if (model.getLineLength(end) <= maximum)
    monaco.editor.colorizeModelLine(model, end, model.getOptions().tabSize);
  codeEditor.render(true);
}

function updateJsonLanguageService(model: monaco.editor.ITextModel) {
  const local =
    selectedLanguageMode?.id === "json" && !providerForLanguage("json", languageProviders);
  if (!local) {
    jsonConnectionAttempt++;
    jsonConnectionPending = false;
    jsonConnection?.dispose();
    jsonConnection = null;
    return;
  }
  if (!jsonConnection && !jsonConnectionPending) startJsonLanguageService(model);
}

function startJsonLanguageService(model: monaco.editor.ITextModel) {
  const attempt = ++jsonConnectionAttempt;
  jsonConnectionPending = true;
  void connectJsonLanguageServer(model)
    .then((connection) => {
      if (disposed || attempt !== jsonConnectionAttempt) connection.dispose();
      else jsonConnection = connection;
      return undefined;
    })
    .catch((error: unknown) => {
      if (!disposed && attempt === jsonConnectionAttempt)
        emit({
          type: "language-error",
          message: error instanceof Error ? error.message : String(error),
        });
    })
    .finally(() => {
      if (attempt === jsonConnectionAttempt) jsonConnectionPending = false;
    });
}

function registerEditingActions(codeEditor: monaco.editor.IStandaloneCodeEditor) {
  codeEditor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyF, () => {
    // Run Monaco's Find action, which opens the widget and focuses its search input.
    codeEditor.trigger("keyboard", "actions.find", null);
  });
  codeEditor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => emit({ type: "save" }));
  for (const [id, redo] of [
    ["undo", false],
    ["redo", true],
  ] as const) {
    monaco.editor.registerCommand(id, () => changeHistory(redo));
    codeEditor.addAction({
      id: `mixer.${id}`,
      label: redo ? "Redo" : "Undo",
      keybindings: [monaco.KeyMod.CtrlCmd | (redo ? monaco.KeyMod.Shift : 0) | monaco.KeyCode.KeyZ],
      run: () => changeHistory(redo),
    });
  }
}

async function showReview(
  command: Extract<import("./messages").EditorCommand, { type: "review" }>,
) {
  const language = await configureLanguage(command.filename);
  await configureTheme(command.theme);
  if (disposed) return;
  const host = document.getElementById("editor");
  if (!host) throw new Error("Diff editor container is missing");
  diffEditor ??= monaco.editor.createDiffEditor(host, {
    automaticLayout: true,
    readOnly: true,
    originalEditable: false,
    fontFamily: command.theme.monoFont,
    fontSize: command.theme.codeFontSize,
    minimap: { enabled: false },
    renderSideBySide: true,
  });
  diffEditor.updateOptions(monacoPreferences(command.preferences, command.theme, command.filename));
  const before = monaco.editor.createModel(command.before, language);
  const after = monaco.editor.createModel(command.after, language);
  applyModelPreferences(before, command.preferences);
  applyModelPreferences(after, command.preferences);
  const previous = diffViewModel;
  const viewModel = diffEditor.createViewModel({ original: before, modified: after });
  diffViewModel = viewModel;
  diffEditor.setModel(viewModel);
  previous?.dispose();
  for (const model of diffModels) model.dispose();
  diffModels = [before, after];
  renderHighlightedViewport(diffEditor.getOriginalEditor());
  renderHighlightedViewport(diffEditor.getModifiedEditor());
  await viewModel.waitForDiff();
  if (!disposed && diffViewModel === viewModel) emit({ type: "ready" });
}

let projectConnectionAttempt = 0;
function startProjectLanguageService({
  codeEditor,
  model,
  filename,
  restart = false,
}: {
  codeEditor: monaco.editor.IStandaloneCodeEditor;
  model: monaco.editor.ITextModel;
  filename: string;
  restart?: boolean;
}) {
  const mode = selectedLanguageMode?.id;
  const provider = mode
    ? providerForLanguage(languageServiceId(mode), languageProviders)
    : providerForDocument(filename, languageProviders);
  const key = JSON.stringify([mode, provider]);
  if (!restart && key === activeLanguageProvider) return;
  activeLanguageProvider = key;
  projectConnection?.dispose();
  projectConnection = null;
  const attempt = ++projectConnectionAttempt;
  if (!provider) return;
  jsonConnection?.dispose();
  jsonConnection = null;
  if (provider.status === "missing") {
    emit({
      type: "language-error",
      message: provider.message ?? `${provider.label} is not installed on the workspace host.`,
    });
    return;
  }
  void connectProjectLanguageService({
    editor: codeEditor,
    model,
    language: provider.id,
    extendedFeatures: extendedLanguageFeatures,
    restart,
    onError: (message) => emit({ type: "language-error", message }),
    onProgress: (message, cancel) => {
      cancelLanguageProgress = cancel;
      emit({ type: "language-progress", message, cancellable: !!cancel });
    },
    openLocation: (targetUri, lineStart, lineEnd) =>
      emit({ type: "open-location", uri: targetUri, lineStart, lineEnd }),
  })
    .then((connection) => {
      if (disposed || attempt !== projectConnectionAttempt) connection.dispose();
      else projectConnection = connection;
      return undefined;
    })
    .catch((error: unknown) => {
      if (disposed || attempt !== projectConnectionAttempt) return;
      emit({
        type: "language-error",
        message: error instanceof Error ? error.message : String(error),
      });
    });
}

function updateContent(
  update: Pick<EditorConfiguration, "content" | "revision" | "lineSeparator" | "bufferVersion">,
) {
  if (!textModel) {
    pendingContent = update;
    return;
  }
  if (update.revision < revision) return;
  bufferVersion = update.bufferVersion;
  lineSeparator = update.lineSeparator;
  if (textModel.getValue().replace(/\r\n|\r|\n/g, lineSeparator) === update.content) return;
  applyingUpdate = true;
  const position = editor?.getPosition();
  const state = editor?.saveViewState();
  // A disk reload establishes a new undo baseline, as in the existing editor.
  textModel.setValue(update.content);
  if (state) editor?.restoreViewState(state);
  else if (position) editor?.setPosition(position);
  applyingUpdate = false;
  if (editor) renderHighlightedViewport(editor);
}

async function drainConfiguration() {
  if (configuring) return;
  configuring = true;
  try {
    while (pendingConfiguration) {
      const next = pendingConfiguration;
      pendingConfiguration = null;
      await configure(next);
    }
  } catch (error) {
    emit({
      type: "error",
      message: error instanceof Error ? error.message : "Unable to load source editor.",
    });
  } finally {
    configuring = false;
  }
}

let cancelLanguageProgress: (() => void) | undefined;

window.addEventListener("message", (event: MessageEvent<unknown>) => {
  if (event.source !== window.parent || event.origin !== window.location.origin) return;
  const parsed = editorCommandSchema.safeParse(event.data);
  if (!parsed.success) return;
  const command = parsed.data;
  switch (command.type) {
    case "cancel-language-progress":
      cancelLanguageProgress?.();
      cancelLanguageProgress = undefined;
      break;
    case "focus":
      editor?.focus();
      break;
    case "git-response":
      gitAnnotations?.accept(command);
      break;
    case "retry-language-services":
      if (editor && textModel) {
        projectConnection?.dispose();
        projectConnection = null;
        startProjectLanguageService({
          codeEditor: editor,
          model: textModel,
          filename: textModel.uri.path,
          restart: true,
        });
      }
      break;
    case "review":
      void showReview(command);
      break;
    case "configure":
      if (command.restartLanguageServices) restartLanguageServices = true;
      pendingConfiguration = command.configuration;
      void drainConfiguration();
      break;
    case "content":
      updateContent(command);
      break;
    case "reveal": {
      reveal(command);
      break;
    }
  }
});

window.addEventListener("pagehide", () => {
  saveViewState();
  disposed = true;
  jsonConnection?.dispose();
  projectConnection?.dispose();
  gitAnnotations?.dispose();
  errorLens?.dispose();
  vim?.dispose();
  editor?.dispose();
  textModel?.dispose();
  diffEditor?.dispose();
  diffViewModel?.dispose();
  for (const model of diffModels) model.dispose();
  for (const { provider } of tokenProviders.values()) provider.dispose();
  void highlighter.then((syntax) => syntax.dispose());
});

window.addEventListener("unhandledrejection", (event: PromiseRejectionEvent) => {
  const reason: unknown = event.reason;
  if (isEditorCancellation(reason)) {
    event.preventDefault();
    return;
  }
  emit({
    type: "error",
    message: reason instanceof Error ? reason.message : "Source editor language service failed.",
  });
});

emit({ type: "booted" });
