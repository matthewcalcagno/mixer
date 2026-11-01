import * as monaco from "monaco-editor";
import { z } from "zod";
import { LanguageEditCommandSchema } from "@mixer/protocol/messages";
import { BrowserMessageReader, BrowserMessageWriter } from "vscode-jsonrpc/browser";
import {
  createProtocolConnection,
  InitializeRequest,
  InitializedNotification,
  DidOpenTextDocumentNotification,
  DidChangeTextDocumentNotification,
  DidCloseTextDocumentNotification,
  CompletionRequest,
  CompletionResolveRequest,
  HoverRequest,
  SignatureHelpRequest,
  DefinitionRequest,
  ReferencesRequest,
  RenameRequest,
  PrepareRenameRequest,
  DocumentSymbolRequest,
  DocumentFormattingRequest,
  CodeActionRequest,
  CodeActionResolveRequest,
  PublishDiagnosticsNotification,
  MarkupContent,
  TextEdit,
  Command,
  LocationLink,
  Range,
  ResponseError,
  CompletionItemKind as LspCompletionKind,
  InsertTextFormat,
  type CompletionItem,
  type Diagnostic,
  type MarkedString,
  type DocumentSymbol,
} from "vscode-languageserver-protocol/browser";
import { languageForFile } from "./language";
import { registerProjectLanguageFeatures } from "./project-language-features";

const kinds: Record<number, monaco.languages.CompletionItemKind> = {
  [LspCompletionKind.Text]: monaco.languages.CompletionItemKind.Text,
  [LspCompletionKind.Method]: monaco.languages.CompletionItemKind.Method,
  [LspCompletionKind.Function]: monaco.languages.CompletionItemKind.Function,
  [LspCompletionKind.Constructor]: monaco.languages.CompletionItemKind.Constructor,
  [LspCompletionKind.Field]: monaco.languages.CompletionItemKind.Field,
  [LspCompletionKind.Variable]: monaco.languages.CompletionItemKind.Variable,
  [LspCompletionKind.Class]: monaco.languages.CompletionItemKind.Class,
  [LspCompletionKind.Interface]: monaco.languages.CompletionItemKind.Interface,
  [LspCompletionKind.Module]: monaco.languages.CompletionItemKind.Module,
  [LspCompletionKind.Property]: monaco.languages.CompletionItemKind.Property,
  [LspCompletionKind.Unit]: monaco.languages.CompletionItemKind.Unit,
  [LspCompletionKind.Value]: monaco.languages.CompletionItemKind.Value,
  [LspCompletionKind.Enum]: monaco.languages.CompletionItemKind.Enum,
  [LspCompletionKind.Keyword]: monaco.languages.CompletionItemKind.Keyword,
  [LspCompletionKind.Snippet]: monaco.languages.CompletionItemKind.Snippet,
  [LspCompletionKind.Color]: monaco.languages.CompletionItemKind.Color,
  [LspCompletionKind.File]: monaco.languages.CompletionItemKind.File,
  [LspCompletionKind.Reference]: monaco.languages.CompletionItemKind.Reference,
  [LspCompletionKind.Folder]: monaco.languages.CompletionItemKind.Folder,
  [LspCompletionKind.EnumMember]: monaco.languages.CompletionItemKind.EnumMember,
  [LspCompletionKind.Constant]: monaco.languages.CompletionItemKind.Constant,
  [LspCompletionKind.Struct]: monaco.languages.CompletionItemKind.Struct,
  [LspCompletionKind.Event]: monaco.languages.CompletionItemKind.Event,
  [LspCompletionKind.Operator]: monaco.languages.CompletionItemKind.Operator,
  [LspCompletionKind.TypeParameter]: monaco.languages.CompletionItemKind.TypeParameter,
};
const severities: Record<number, monaco.MarkerSeverity> = {
  1: monaco.MarkerSeverity.Error,
  2: monaco.MarkerSeverity.Warning,
  3: monaco.MarkerSeverity.Info,
  4: monaco.MarkerSeverity.Hint,
};
const jsxLanguages: Record<string, string> = { tsx: "typescriptreact", jsx: "javascriptreact" };

function range(value: Range): monaco.IRange {
  return {
    startLineNumber: value.start.line + 1,
    startColumn: value.start.character + 1,
    endLineNumber: value.end.line + 1,
    endColumn: value.end.character + 1,
  };
}
function position(value: monaco.IPosition) {
  return { line: value.lineNumber - 1, character: value.column - 1 };
}
function markdown(value: MarkedString | MarkupContent): monaco.IMarkdownString {
  if (typeof value === "string") return { value, isTrusted: false };
  if (MarkupContent.is(value)) return { value: value.value, isTrusted: false };
  return { value: `\`\`\`${value.language}\n${value.value}\n\`\`\``, isTrusted: false };
}
function symbol(value: DocumentSymbol): monaco.languages.DocumentSymbol {
  return {
    name: value.name,
    detail: value.detail ?? "",
    kind: value.kind - 1,
    tags: value.tags ?? [],
    range: range(value.range),
    selectionRange: range(value.selectionRange),
    children: value.children?.map(symbol),
  };
}

/** Refuse edits to unopened buffers rather than silently dropping the rest of a refactor. */
interface ProjectLanguageClientOptions {
  editor: monaco.editor.IStandaloneCodeEditor;
  model: monaco.editor.ITextModel;
  language: string;
  extendedFeatures?: boolean;
  onError(message: string): void;
  openLocation(uri: string, lineStart: number, lineEnd: number): void;
  restart?: boolean;
}

export function disableStandaloneTypeScriptServices(): void {
  for (const defaults of [
    monaco.typescript.typescriptDefaults,
    monaco.typescript.javascriptDefaults,
  ]) {
    defaults.setDiagnosticsOptions({
      noSemanticValidation: true,
      noSyntaxValidation: true,
      noSuggestionDiagnostics: true,
    });
    defaults.setModeConfiguration({
      completionItems: false,
      hovers: false,
      signatureHelp: false,
      definitions: false,
      references: false,
      documentSymbols: false,
      rename: false,
      documentRangeFormattingEdits: false,
      codeActions: false,
      diagnostics: false,
      inlayHints: false,
    });
  }
}

export async function connectProjectLanguageService(
  options: ProjectLanguageClientOptions,
): Promise<monaco.IDisposable> {
  const { model, editor, language, onError } = options;
  const ports = new MessageChannel();
  const connection = createProtocolConnection(
    new BrowserMessageReader(ports.port1),
    new BrowserMessageWriter(ports.port1),
  );
  const channelId = crypto.randomUUID();
  let uri = model.uri.toString();
  let textDocument = { uri };
  let serverRoot = "";
  let workspaceRoot = "";
  function editorUri(target: string): string {
    if (target === uri) return model.uri.toString();
    return serverRoot && target.startsWith(serverRoot)
      ? workspaceRoot + target.slice(serverRoot.length)
      : target;
  }
  const registrations: monaco.IDisposable[] = [];
  const extraModels = new Set<monaco.editor.ITextModel>();
  let diagnostics: Diagnostic[] = [];
  let disposed = false;
  let readBytes = 0;
  const fail = (error: unknown) => {
    if (error instanceof ResponseError && [-32800, -32801, -32802].includes(error.code)) return;
    if (!disposed) onError(error instanceof Error ? error.message : String(error));
  };
  async function read<T>(request: () => Promise<T>): Promise<T | undefined> {
    try {
      const value = await request();
      return !disposed && !model.isDisposed() ? value : undefined;
    } catch (error) {
      fail(error);
      return undefined;
    }
  }
  async function fresh<T>(request: () => Promise<T>): Promise<T | undefined> {
    const version = model.getVersionId();
    const value = await read(request);
    return !model.isDisposed() && version === model.getVersionId() ? value : undefined;
  }
  async function loadReference(target: string) {
    if (target === model.uri.toString()) return;
    const reference = monaco.Uri.parse(target);
    if (reference.scheme !== "file")
      throw new Error("Language-service navigation requires a workspace file");
    const data = z
      .object({ content: z.string() })
      .parse(await connection.sendRequest("workspace/readFile", { uri: target }));
    if (disposed || model.isDisposed()) return;
    const existing = monaco.editor.getModel(reference);
    if (existing) {
      if (!extraModels.has(existing)) return;
      if (existing.getValue() !== data.content) existing.setValue(data.content);
      return;
    }
    readBytes += data.content.length * 2;
    if (extraModels.size >= 64 || readBytes > 8 * 1024 * 1024)
      throw new Error("Too many reference files to preview. Narrow the reference search.");
    extraModels.add(
      monaco.editor.createModel(
        data.content,
        languageForFile(reference.path, monaco.languages.getLanguages()),
        reference,
      ),
    );
  }
  connection.onNotification(PublishDiagnosticsNotification.type, (message) => {
    if (message.uri !== uri || disposed || model.isDisposed()) return;
    if (message.version !== undefined && message.version !== model.getVersionId()) return;
    diagnostics = message.diagnostics;
    monaco.editor.setModelMarkers(
      model,
      "workspace-lsp",
      diagnostics.map((diagnostic) => ({
        ...range(diagnostic.range),
        message: diagnostic.message,
        source: diagnostic.source ?? language,
        severity: severities[diagnostic.severity ?? 1] ?? monaco.MarkerSeverity.Error,
        code: diagnostic.code === undefined ? undefined : String(diagnostic.code),
        tags: diagnostic.tags,
      })),
    );
  });
  connection.onNotification("window/logMessage", (value: unknown) => {
    const message = z.object({ type: z.number(), message: z.string() }).safeParse(value);
    if (message.success && message.data.type === 1) onError(message.data.message);
  });
  connection.onNotification("mixer/languageServiceState", (value: unknown) => {
    const state = z
      .discriminatedUnion("state", [
        z.object({ state: z.literal("restarting") }),
        z.object({ state: z.literal("ready") }),
        z.object({ state: z.literal("failed"), message: z.string() }),
      ])
      .parse(value);
    if (disposed) return;
    const surface = document.getElementById("editor");
    surface?.setAttribute("data-language-service-state", state.state);
    if (surface && state.state === "restarting") {
      surface.setAttribute(
        "data-language-service-restarts",
        String(Number(surface.getAttribute("data-language-service-restarts") ?? "0") + 1),
      );
    }
    if (state.state === "ready") onError("");
    else if (state.state === "failed") onError(state.message);
    else onError("Reconnecting language services…");
  });
  connection.listen();
  window.parent.postMessage(
    { type: "language-connect", language, channelId, restart: options.restart },
    window.location.origin,
    [ports.port2],
  );
  let initialized;
  try {
    initialized = await connection.sendRequest(InitializeRequest.type, {
      processId: null,
      rootUri: null,
      capabilities: {},
    });
    const roots = z.object({ rootUri: z.string(), workspaceUri: z.string() }).parse(initialized);
    serverRoot = roots.rootUri.replace(/\/$/, "") + "/";
    workspaceRoot = roots.workspaceUri.replace(/\/$/, "") + "/";
    if (uri.startsWith(workspaceRoot)) uri = serverRoot + uri.slice(workspaceRoot.length);
    textDocument = { uri };
    if (model.isDisposed()) {
      window.parent.postMessage({ type: "language-disconnect", channelId }, window.location.origin);
      connection.dispose();
      ports.port1.close();
      return { dispose() {} };
    }
    await connection.sendNotification(InitializedNotification.type, {});
    const languageId = jsxLanguages[model.uri.path.split(".").pop() ?? ""] ?? model.getLanguageId();
    await connection.sendNotification(DidOpenTextDocumentNotification.type, {
      textDocument: { uri, languageId, text: model.getValue(), version: model.getVersionId() },
    });
    // sendNotification only queues a MessagePort write. Wait for a document round trip before
    // advertising ready providers; the host and language server must have processed didOpen.
    if (initialized.capabilities.documentSymbolProvider)
      await connection.sendRequest(DocumentSymbolRequest.type, { textDocument });
  } catch (error) {
    window.parent.postMessage({ type: "language-disconnect", channelId }, window.location.origin);
    connection.dispose();
    ports.port1.close();
    throw error;
  }
  const capabilities = initialized.capabilities;
  const selector = model.getLanguageId();
  registrations.push(
    ...registerProjectLanguageFeatures({
      enabled: options.extendedFeatures,
      connection,
      capabilities,
      model,
      editor,
      textDocument,
      fresh,
      editorUri,
      loadReference,
    }),
  );
  if (language === "typescript") {
    disableStandaloneTypeScriptServices();
    monaco.editor.setModelMarkers(model, model.getLanguageId(), []);
  }
  registrations.push(
    model.onDidChangeContent(() => {
      diagnostics = [];
      monaco.editor.setModelMarkers(model, "workspace-lsp", []);
      void connection.sendNotification(DidChangeTextDocumentNotification.type, {
        textDocument: { uri, version: model.getVersionId() },
        contentChanges: [{ text: model.getValue() }],
      });
    }),
  );
  registrations.push(
    monaco.editor.registerEditorOpener({
      openCodeEditor(_source, resource, selection) {
        if (resource.toString() === uri) return false;
        let start = 1,
          end = 1;
        if (selection && "startLineNumber" in selection) {
          start = selection.startLineNumber;
          end = selection.endLineNumber;
        } else if (selection) {
          start = selection.lineNumber;
          end = selection.lineNumber;
        }
        options.openLocation(resource.toString(), start, end);
        return true;
      },
    }),
  );
  // Monaco's reference peek contains embedded editors. Only the actual file tab can edit/save.
  registrations.push(
    monaco.editor.onDidCreateEditor((candidate) => {
      if (candidate !== editor) candidate.updateOptions({ readOnly: true });
    }),
  );
  const completionItems = new WeakMap<monaco.languages.CompletionItem, CompletionItem>();
  if (capabilities.completionProvider)
    registrations.push(
      monaco.languages.registerCompletionItemProvider(selector, {
        triggerCharacters: capabilities.completionProvider.triggerCharacters,
        async provideCompletionItems(document, cursor, _context, token) {
          if (document !== model) return { suggestions: [] };
          // Monaco tracks typing within the completion range and cancels invalid contexts itself.
          // Rejecting every document-version change loses suggestions during normal fast typing.
          const result = await read(() =>
            connection.sendRequest(
              CompletionRequest.type,
              { textDocument, position: position(cursor) },
              token,
            ),
          );
          if (!result || token.isCancellationRequested) return { suggestions: [] };
          const items = Array.isArray(result) ? result : result.items;
          const word = model.getWordUntilPosition(cursor);
          return {
            incomplete: !Array.isArray(result) && result.isIncomplete,
            suggestions: items.map((item) => {
              const primaryEdit = item.textEdit;
              const suggestion: monaco.languages.CompletionItem = {
                label: item.label,
                kind:
                  kinds[item.kind ?? LspCompletionKind.Text] ??
                  monaco.languages.CompletionItemKind.Text,
                insertText: primaryEdit?.newText ?? item.insertText ?? item.label,
                range: primaryEdit
                  ? range(TextEdit.is(primaryEdit) ? primaryEdit.range : primaryEdit.replace)
                  : {
                      startLineNumber: cursor.lineNumber,
                      endLineNumber: cursor.lineNumber,
                      startColumn: word.startColumn,
                      endColumn: word.endColumn,
                    },
                detail: item.detail,
                sortText: item.sortText,
                filterText: item.filterText,
                commitCharacters: item.commitCharacters,
                documentation: item.documentation ? markdown(item.documentation) : undefined,
                additionalTextEdits: item.additionalTextEdits?.map((edit) => ({
                  range: range(edit.range),
                  text: edit.newText,
                })),
                insertTextRules:
                  item.insertTextFormat === InsertTextFormat.Snippet
                    ? monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet
                    : undefined,
              };
              completionItems.set(suggestion, item);
              return suggestion;
            }),
          };
        },
        async resolveCompletionItem(suggestion, token) {
          if (!capabilities.completionProvider?.resolveProvider) return suggestion;
          const saved = completionItems.get(suggestion);
          if (!saved) return suggestion;
          const item = await fresh(() =>
            connection.sendRequest(CompletionResolveRequest.type, saved, token),
          );
          if (!item) return suggestion;
          return {
            ...suggestion,
            detail: item.detail,
            documentation: item.documentation ? markdown(item.documentation) : undefined,
            additionalTextEdits: item.additionalTextEdits?.map((edit) => ({
              range: range(edit.range),
              text: edit.newText,
            })),
          };
        },
      }),
    );
  if (capabilities.hoverProvider)
    registrations.push(
      monaco.languages.registerHoverProvider(selector, {
        async provideHover(document, cursor, token) {
          if (document !== model) return null;
          const hover = await fresh(() =>
            connection.sendRequest(
              HoverRequest.type,
              { textDocument, position: position(cursor) },
              token,
            ),
          );
          if (!hover) return null;
          return {
            range: hover.range ? range(hover.range) : undefined,
            contents: Array.isArray(hover.contents)
              ? hover.contents.map(markdown)
              : [markdown(hover.contents)],
          };
        },
      }),
    );
  if (capabilities.signatureHelpProvider)
    registrations.push(
      monaco.languages.registerSignatureHelpProvider(selector, {
        signatureHelpTriggerCharacters: capabilities.signatureHelpProvider.triggerCharacters,
        async provideSignatureHelp(document, cursor, token) {
          if (document !== model) return null;
          const help = await fresh(() =>
            connection.sendRequest(
              SignatureHelpRequest.type,
              { textDocument, position: position(cursor) },
              token,
            ),
          );
          if (!help) return null;
          return {
            value: {
              signatures: help.signatures.map((signature) => ({
                label: signature.label,
                documentation: signature.documentation
                  ? markdown(signature.documentation)
                  : undefined,
                parameters: (signature.parameters ?? []).map((parameter) => ({
                  label: parameter.label,
                  documentation: parameter.documentation
                    ? markdown(parameter.documentation)
                    : undefined,
                })),
              })),
              activeSignature: help.activeSignature ?? 0,
              activeParameter: help.activeParameter ?? 0,
            },
            dispose() {},
          };
        },
      }),
    );
  if (capabilities.definitionProvider)
    registrations.push(
      monaco.languages.registerDefinitionProvider(selector, {
        async provideDefinition(document, cursor, token) {
          if (document !== model) return null;
          return (
            (await fresh(async () => {
              const result = await connection.sendRequest(
                DefinitionRequest.type,
                { textDocument, position: position(cursor) },
                token,
              );
              if (!result) return [];
              const locations = Array.isArray(result) ? result : [result];
              const values = locations
                .map((location) =>
                  LocationLink.is(location)
                    ? { uri: location.targetUri, range: location.targetSelectionRange }
                    : location,
                )
                .map((value) => ({ range: value.range, uri: editorUri(value.uri) }));
              await Promise.all([...new Set(values.map((value) => value.uri))].map(loadReference));
              return values.map((value) => ({
                uri: monaco.Uri.parse(value.uri),
                range: range(value.range),
              }));
            })) ?? null
          );
        },
      }),
    );
  if (capabilities.referencesProvider)
    registrations.push(
      monaco.languages.registerReferenceProvider(selector, {
        async provideReferences(document, cursor, context, token) {
          if (document !== model) return [];
          return (
            (await fresh(async () => {
              const found =
                (await connection.sendRequest(
                  ReferencesRequest.type,
                  {
                    textDocument,
                    position: position(cursor),
                    context: { includeDeclaration: context.includeDeclaration },
                  },
                  token,
                )) ?? [];
              const results = found.map((value) => ({
                range: value.range,
                uri: editorUri(value.uri),
              }));
              await Promise.all([...new Set(results.map((value) => value.uri))].map(loadReference));
              return results.map((value) => ({
                uri: monaco.Uri.parse(value.uri),
                range: range(value.range),
              }));
            })) ?? []
          );
        },
      }),
    );
  if (capabilities.documentSymbolProvider)
    registrations.push(
      monaco.languages.registerDocumentSymbolProvider(selector, {
        async provideDocumentSymbols(document, token) {
          if (document !== model) return [];
          const symbols = await fresh(() =>
            connection.sendRequest(DocumentSymbolRequest.type, { textDocument }, token),
          );
          return (
            symbols?.map((value) =>
              "location" in value
                ? {
                    name: value.name,
                    detail: value.containerName ?? "",
                    kind: value.kind - 1,
                    tags: value.tags ?? [],
                    range: range(value.location.range),
                    selectionRange: range(value.location.range),
                  }
                : symbol(value),
            ) ?? []
          );
        },
      }),
    );
  if (capabilities.renameProvider)
    registrations.push(
      monaco.languages.registerRenameProvider(selector, {
        async resolveRenameLocation(document, cursor, token) {
          if (document !== model)
            return {
              range: new monaco.Range(1, 1, 1, 1),
              text: "",
              rejectReason: "This document is not editable here",
            };
          const word = model.getWordAtPosition(cursor);
          if (
            word &&
            (typeof capabilities.renameProvider !== "object" ||
              !capabilities.renameProvider.prepareProvider)
          ) {
            return {
              range: new monaco.Range(
                cursor.lineNumber,
                word.startColumn,
                cursor.lineNumber,
                word.endColumn,
              ),
              text: word.word,
            };
          }
          const result = await fresh(() =>
            connection.sendRequest(
              PrepareRenameRequest.type,
              { textDocument, position: position(cursor) },
              token,
            ),
          );
          if (!result || !word)
            return {
              range: new monaco.Range(
                cursor.lineNumber,
                cursor.column,
                cursor.lineNumber,
                cursor.column,
              ),
              text: "",
              rejectReason: "This symbol cannot be renamed",
            };
          let target: Range = {
            start: { line: cursor.lineNumber - 1, character: word.startColumn - 1 },
            end: { line: cursor.lineNumber - 1, character: word.endColumn - 1 },
          };
          if (Range.is(result)) target = result;
          else if ("range" in result) target = result.range;
          return {
            range: range(target),
            text: "placeholder" in result ? result.placeholder : word.word,
          };
        },
        async provideRenameEdits(document, cursor, newName, token) {
          if (document !== model) return { edits: [] };
          const edit = await fresh(() =>
            connection.sendRequest(
              RenameRequest.type,
              { textDocument, position: position(cursor), newName },
              token,
            ),
          );
          if (!edit)
            return {
              edits: [],
              rejectReason: "Rename could not be computed for this document version",
            };
          await connection.sendRequest("mixer/reviewEdit", { label: `Rename to ${newName}`, edit });
          return { edits: [] };
        },
      }),
    );
  const actionCommand = `mixer.applyCodeAction.${channelId}`;
  let actionId = 0;
  const actions = new Map<
    number,
    {
      original: import("vscode-languageserver-protocol/browser").CodeAction | Command;
      version: number;
    }
  >();
  registrations.push(
    monaco.editor.registerCommand(actionCommand, async (_accessor, id: number) => {
      const saved = actions.get(id);
      if (!saved || saved.version !== model.getVersionId()) {
        onError("The document changed. Request code actions again.");
        return;
      }
      try {
        let original = saved.original;
        if (
          !Command.is(original) &&
          typeof capabilities.codeActionProvider === "object" &&
          capabilities.codeActionProvider.resolveProvider
        )
          original = await connection.sendRequest(CodeActionResolveRequest.type, original);
        if (saved.version !== model.getVersionId())
          throw new Error("The document changed. Request code actions again.");
        if (Command.is(original))
          await connection.sendRequest("mixer/execute", {
            label: original.title,
            command: original,
          });
        else if (original.edit && original.command)
          throw new Error(
            "This action combines edits and a server command and cannot be applied safely.",
          );
        else if (original.edit)
          await connection.sendRequest("mixer/reviewEdit", {
            label: original.title,
            edit: original.edit,
          });
        else if (original.command)
          await connection.sendRequest("mixer/execute", {
            label: original.title,
            command: original.command,
          });
      } catch (error) {
        fail(error);
      }
    }),
  );
  if (capabilities.codeActionProvider)
    registrations.push(
      monaco.languages.registerCodeActionProvider(
        selector,
        {
          async provideCodeActions(document, selection, context, token) {
            if (document !== model) return { actions: [], dispose() {} };
            const results = await fresh(() =>
              connection.sendRequest(
                CodeActionRequest.type,
                {
                  textDocument,
                  range: {
                    start: {
                      line: selection.startLineNumber - 1,
                      character: selection.startColumn - 1,
                    },
                    end: { line: selection.endLineNumber - 1, character: selection.endColumn - 1 },
                  },
                  context: { diagnostics, only: context.only ? [context.only] : undefined },
                },
                token,
              ),
            );
            return {
              actions: (results ?? []).map((original) => {
                const id = actionId++;
                if (actions.size >= 256) actions.clear();
                actions.set(id, { original, version: model.getVersionId() });
                const serverCommand = Command.is(original) ? original : original.command;
                const unsupported =
                  serverCommand && !LanguageEditCommandSchema.safeParse(serverCommand).success;
                let disabled = Command.is(original) ? undefined : original.disabled?.reason;
                if (unsupported)
                  disabled = "This server command is not approved for reviewed edits";
                const action: monaco.languages.CodeAction = {
                  title: original.title,
                  kind: Command.is(original) ? undefined : original.kind,
                  isPreferred: Command.is(original) ? undefined : original.isPreferred,
                  command: { id: actionCommand, title: original.title, arguments: [id] },
                  disabled,
                };
                return action;
              }),
              dispose() {},
            };
          },
        },
        {
          providedCodeActionKinds:
            typeof capabilities.codeActionProvider === "object"
              ? capabilities.codeActionProvider.codeActionKinds
              : undefined,
        },
      ),
    );
  if (capabilities.documentFormattingProvider)
    registrations.push(
      monaco.languages.registerDocumentFormattingEditProvider(selector, {
        async provideDocumentFormattingEdits(document, formatting, token) {
          if (document !== model) return [];
          const edits = await fresh(() =>
            connection.sendRequest(
              DocumentFormattingRequest.type,
              {
                textDocument,
                options: { tabSize: formatting.tabSize, insertSpaces: formatting.insertSpaces },
              },
              token,
            ),
          );
          return edits?.map((edit) => ({ range: range(edit.range), text: edit.newText })) ?? [];
        },
      }),
    );
  document.getElementById("editor")?.setAttribute("data-language-service", language);
  document.getElementById("editor")?.setAttribute("data-language-service-state", "ready");
  return {
    dispose() {
      disposed = true;
      window.parent.postMessage({ type: "language-disconnect", channelId }, window.location.origin);
      document.getElementById("editor")?.removeAttribute("data-language-service");
      for (const registration of registrations) registration.dispose();
      for (const reference of extraModels) reference.dispose();
      if (!model.isDisposed()) monaco.editor.setModelMarkers(model, "workspace-lsp", []);
      void connection.sendNotification(DidCloseTextDocumentNotification.type, { textDocument });
      connection.dispose();
      ports.port1.close();
    },
  };
}
