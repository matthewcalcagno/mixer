import * as monaco from "monaco-editor";
import {
  TypeDefinitionRequest,
  ImplementationRequest,
  InlayHintRequest,
  FoldingRangeRequest,
  LocationLink,
  type ProtocolConnection,
  type ServerCapabilities,
  type Range,
  type Position,
} from "vscode-languageserver-protocol/browser";

interface FeatureOptions {
  enabled?: boolean;
  connection: ProtocolConnection;
  capabilities: ServerCapabilities;
  model: monaco.editor.ITextModel;
  editor: monaco.editor.IStandaloneCodeEditor;
  textDocument: { uri: string };
  fresh<T>(read: () => Promise<T>): Promise<T | undefined>;
  editorUri(uri: string): string;
  loadReference(uri: string): Promise<void>;
}
function fromRange(value: Range): monaco.IRange {
  return {
    startLineNumber: value.start.line + 1,
    startColumn: value.start.character + 1,
    endLineNumber: value.end.line + 1,
    endColumn: value.end.character + 1,
  };
}
function toPosition(value: monaco.IPosition): Position {
  return { line: value.lineNumber - 1, character: value.column - 1 };
}

/** Additional standard LSP features; no server commands or edits bypass editor review. */
export function registerProjectLanguageFeatures(options: FeatureOptions): monaco.IDisposable[] {
  if (!options.enabled) return [];
  const { connection, capabilities, model, textDocument, fresh } = options;
  const selector = model.getLanguageId();
  const registrations: monaco.IDisposable[] = [];
  async function navigate(
    request: typeof TypeDefinitionRequest.type | typeof ImplementationRequest.type,
    document: monaco.editor.ITextModel,
    cursor: monaco.Position,
    token: monaco.CancellationToken,
  ) {
    if (document !== model) return null;
    return (
      (await fresh(async () => {
        const result = await connection.sendRequest(
          request,
          { textDocument, position: toPosition(cursor) },
          token,
        );
        if (!result) return [];
        const locations = (Array.isArray(result) ? result : [result]).map((location) => {
          const target = LocationLink.is(location)
            ? { uri: location.targetUri, range: location.targetSelectionRange }
            : location;
          return { uri: options.editorUri(target.uri), range: target.range };
        });
        await Promise.all(
          [...new Set(locations.map((location) => location.uri))].map(options.loadReference),
        );
        return locations.map((location) => ({
          uri: monaco.Uri.parse(location.uri),
          range: fromRange(location.range),
        }));
      })) ?? null
    );
  }
  if (capabilities.typeDefinitionProvider)
    registrations.push(
      monaco.languages.registerTypeDefinitionProvider(selector, {
        provideTypeDefinition: (document, cursor, token) =>
          navigate(TypeDefinitionRequest.type, document, cursor, token),
      }),
    );
  if (capabilities.implementationProvider)
    registrations.push(
      monaco.languages.registerImplementationProvider(selector, {
        provideImplementation: (document, cursor, token) =>
          navigate(ImplementationRequest.type, document, cursor, token),
      }),
    );
  if (capabilities.inlayHintProvider)
    registrations.push(
      monaco.languages.registerInlayHintsProvider(selector, {
        async provideInlayHints(document, selection, token) {
          if (document !== model) return { hints: [], dispose() {} };
          const hints = await fresh(() =>
            connection.sendRequest(
              InlayHintRequest.type,
              {
                textDocument,
                range: {
                  start: {
                    line: selection.startLineNumber - 1,
                    character: selection.startColumn - 1,
                  },
                  end: { line: selection.endLineNumber - 1, character: selection.endColumn - 1 },
                },
              },
              token,
            ),
          );
          return {
            hints: (hints ?? []).map((hint) => ({
              position: { lineNumber: hint.position.line + 1, column: hint.position.character + 1 },
              label:
                typeof hint.label === "string"
                  ? hint.label
                  : hint.label.map((part) => part.value).join(""),
              kind:
                hint.kind === 2
                  ? monaco.languages.InlayHintKind.Parameter
                  : monaco.languages.InlayHintKind.Type,
              paddingLeft: hint.paddingLeft,
              paddingRight: hint.paddingRight,
              tooltip: hint.tooltip
                ? {
                    value: typeof hint.tooltip === "string" ? hint.tooltip : hint.tooltip.value,
                    isTrusted: false,
                  }
                : undefined,
            })),
            dispose() {},
          };
        },
      }),
    );
  if (capabilities.foldingRangeProvider)
    registrations.push(
      monaco.languages.registerFoldingRangeProvider(selector, {
        async provideFoldingRanges(document, _context, token) {
          if (document !== model) return [];
          const ranges = await fresh(() =>
            connection.sendRequest(FoldingRangeRequest.type, { textDocument }, token),
          );
          return (ranges ?? []).map((value) => ({
            start: value.startLine + 1,
            end: value.endLine + 1,
            kind: value.kind ? monaco.languages.FoldingRangeKind.fromValue(value.kind) : undefined,
          }));
        },
      }),
    );
  // TextMate owns syntax colors. Enabling semantic highlighting after LSP startup
  // recolors an already-visible buffer with Monaco’s inherited semantic theme.
  return registrations;
}
