import * as monaco from "monaco-editor";
import { BrowserMessageReader, BrowserMessageWriter } from "vscode-jsonrpc/browser";
import {
  createProtocolConnection,
  InitializeRequest,
  InitializedNotification,
  DidOpenTextDocumentNotification,
  DidChangeTextDocumentNotification,
  DidCloseTextDocumentNotification,
  CompletionRequest,
  HoverRequest,
  DocumentFormattingRequest,
  PublishDiagnosticsNotification,
  CompletionItemKind,
  InsertTextFormat,
  TextEdit,
  MarkupContent,
  type Range,
  type MarkedString,
} from "vscode-languageserver-protocol/browser";

function range(value: Range): monaco.IRange {
  return {
    startLineNumber: value.start.line + 1,
    startColumn: value.start.character + 1,
    endLineNumber: value.end.line + 1,
    endColumn: value.end.character + 1,
  };
}

function completionKind(kind: CompletionItemKind | undefined): monaco.languages.CompletionItemKind {
  switch (kind) {
    case CompletionItemKind.Property:
      return monaco.languages.CompletionItemKind.Property;
    case CompletionItemKind.Value:
      return monaco.languages.CompletionItemKind.Value;
    case CompletionItemKind.Keyword:
      return monaco.languages.CompletionItemKind.Keyword;
    case CompletionItemKind.Snippet:
      return monaco.languages.CompletionItemKind.Snippet;
    case CompletionItemKind.Module:
      return monaco.languages.CompletionItemKind.Module;
    case CompletionItemKind.Enum:
      return monaco.languages.CompletionItemKind.Enum;
    default:
      return monaco.languages.CompletionItemKind.Text;
  }
}

function markdown(value: MarkedString): monaco.IMarkdownString {
  if (typeof value === "string") return { value, isTrusted: false };
  return { value: `\`\`\`${value.language}\n${value.value}\n\`\`\``, isTrusted: false };
}

/** A real LSP connection in a worker. It never executes workspace code or accesses disk. */
export async function connectJsonLanguageServer(
  model: monaco.editor.ITextModel,
): Promise<monaco.IDisposable> {
  const worker = new Worker(new URL("./json-lsp.worker.js", window.location.href));
  const connection = createProtocolConnection(
    new BrowserMessageReader(worker),
    new BrowserMessageWriter(worker),
  );
  const uri = model.uri.toString();
  const registrations: monaco.IDisposable[] = [];
  connection.onNotification(PublishDiagnosticsNotification.type, (params) => {
    if (model.isDisposed() || params.uri !== uri) return;
    if (params.version !== undefined && params.version !== model.getVersionId()) return;
    monaco.editor.setModelMarkers(
      model,
      "json-lsp",
      params.diagnostics.map((diagnostic) => ({
        ...range(diagnostic.range),
        message: diagnostic.message,
        severity:
          diagnostic.severity === 2 ? monaco.MarkerSeverity.Warning : monaco.MarkerSeverity.Error,
        source: "JSON language server",
      })),
    );
  });
  connection.listen();
  try {
    await connection.sendRequest(InitializeRequest.type, {
      processId: null,
      rootUri: null,
      capabilities: {
        textDocument: {
          completion: { completionItem: { snippetSupport: true } },
          hover: { contentFormat: ["markdown", "plaintext"] },
        },
      },
    });
    await connection.sendNotification(InitializedNotification.type, {});
    if (model.isDisposed()) {
      connection.dispose();
      worker.terminate();
      return { dispose() {} };
    }
    await connection.sendNotification(DidOpenTextDocumentNotification.type, {
      textDocument: {
        uri,
        languageId: "json",
        version: model.getVersionId(),
        text: model.getValue(),
      },
    });
  } catch (error) {
    connection.dispose();
    worker.terminate();
    throw error;
  }

  registrations.push(
    model.onDidChangeContent(() => {
      void connection.sendNotification(DidChangeTextDocumentNotification.type, {
        textDocument: { uri, version: model.getVersionId() },
        contentChanges: [{ text: model.getValue() }],
      });
    }),
  );
  registrations.push(
    monaco.languages.registerCompletionItemProvider("json", {
      triggerCharacters: ['"', ":"],
      async provideCompletionItems(document, position) {
        if (document !== model) return { suggestions: [] };
        const version = model.getVersionId();
        const response = await connection.sendRequest(CompletionRequest.type, {
          textDocument: { uri },
          position: { line: position.lineNumber - 1, character: position.column - 1 },
        });
        if (!response || model.isDisposed() || version !== model.getVersionId())
          return { suggestions: [] };
        const items = Array.isArray(response) ? response : response.items;
        return {
          suggestions: items.map((item) => {
            const edit = item.textEdit;
            const word = model.getWordUntilPosition(position);
            const fallbackRange = {
              startLineNumber: position.lineNumber,
              endLineNumber: position.lineNumber,
              startColumn: word.startColumn,
              endColumn: word.endColumn,
            };
            let replacementRange = fallbackRange;
            let insertText = item.insertText ?? item.label;
            if (edit) {
              replacementRange = range(TextEdit.is(edit) ? edit.range : edit.replace);
              insertText = edit.newText;
            }
            return {
              label: item.label,
              kind: completionKind(item.kind),
              insertText,
              range: replacementRange,
              detail: item.detail,
              sortText: item.sortText,
              filterText: item.filterText,
              insertTextRules:
                item.insertTextFormat === InsertTextFormat.Snippet
                  ? monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet
                  : undefined,
            };
          }),
        };
      },
    }),
  );
  registrations.push(
    monaco.languages.registerHoverProvider("json", {
      async provideHover(document, position) {
        if (document !== model) return null;
        const result = await connection.sendRequest(HoverRequest.type, {
          textDocument: { uri },
          position: { line: position.lineNumber - 1, character: position.column - 1 },
        });
        if (!result || model.isDisposed()) return null;
        const contents = result.contents;
        let rendered: monaco.IMarkdownString[];
        if (MarkupContent.is(contents)) rendered = [{ value: contents.value, isTrusted: false }];
        else if (Array.isArray(contents)) rendered = contents.map(markdown);
        else rendered = [markdown(contents)];
        return { contents: rendered, range: result.range ? range(result.range) : undefined };
      },
    }),
  );
  registrations.push(
    monaco.languages.registerDocumentFormattingEditProvider("json", {
      async provideDocumentFormattingEdits(document, options) {
        if (document !== model) return [];
        const edits = await connection.sendRequest(DocumentFormattingRequest.type, {
          textDocument: { uri },
          options: { tabSize: options.tabSize, insertSpaces: options.insertSpaces },
        });
        if (model.isDisposed()) return [];
        return (edits ?? []).map((edit) => ({ range: range(edit.range), text: edit.newText }));
      },
    }),
  );
  return {
    dispose() {
      for (const registration of registrations) registration.dispose();
      if (!model.isDisposed()) monaco.editor.setModelMarkers(model, "json-lsp", []);
      void connection.sendNotification(DidCloseTextDocumentNotification.type, {
        textDocument: { uri },
      });
      connection.dispose();
      worker.terminate();
    },
  };
}
