import {
  BrowserMessageReader,
  BrowserMessageWriter,
  createConnection,
  TextDocuments,
  TextDocumentSyncKind,
} from "vscode-languageserver/browser";
import { TextDocument } from "vscode-languageserver-textdocument";
import { getLanguageService } from "vscode-json-languageservice";

const connection = createConnection(new BrowserMessageReader(self), new BrowserMessageWriter(self));
const documents = new TextDocuments(TextDocument);
// No schema request service: workspace text must not trigger outbound network requests.
const service = getLanguageService({});

connection.onInitialize(() => ({
  capabilities: {
    textDocumentSync: TextDocumentSyncKind.Full,
    completionProvider: { resolveProvider: false, triggerCharacters: ['"', ":"] },
    hoverProvider: true,
    documentFormattingProvider: true,
    documentSymbolProvider: true,
  },
}));

documents.onDidChangeContent(async ({ document }) => {
  const parsed = service.parseJSONDocument(document);
  const validation = await service.doValidation(document, parsed);
  const diagnostics = validation.map(({ range, message, severity, code, source }) => ({
    range,
    severity,
    code,
    source,
    message: typeof message === "string" ? message : message.value,
  }));
  // Validation can complete after another change or close.
  if (documents.get(document.uri)?.version !== document.version) return;
  void connection.sendDiagnostics({ uri: document.uri, version: document.version, diagnostics });
});
documents.onDidClose(({ document }) => {
  void connection.sendDiagnostics({ uri: document.uri, diagnostics: [] });
});
connection.onCompletion(({ textDocument, position }) => {
  const document = documents.get(textDocument.uri);
  if (!document) return null;
  return service.doComplete(document, position, service.parseJSONDocument(document));
});
connection.onHover(({ textDocument, position }) => {
  const document = documents.get(textDocument.uri);
  if (!document) return null;
  return service.doHover(document, position, service.parseJSONDocument(document));
});
connection.onDocumentFormatting(({ textDocument, options }) => {
  const document = documents.get(textDocument.uri);
  if (!document) return [];
  return service.format(document, undefined, options);
});
connection.onDocumentSymbol(({ textDocument }) => {
  const document = documents.get(textDocument.uri);
  if (!document) return [];
  return service.findDocumentSymbols2(document, service.parseJSONDocument(document));
});
documents.listen(connection);
connection.listen();
