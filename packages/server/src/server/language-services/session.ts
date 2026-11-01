import path from "node:path";
import { realpath } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  CancellationTokenSource,
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
  ResponseError,
  type MessageConnection,
} from "vscode-jsonrpc/node.js";
import { z } from "zod";
import pLimit from "p-limit";
import type pino from "pino";
import type {
  WorkspaceLanguageRequest,
  WorkspaceLanguageNotification,
} from "@mixer/protocol/messages";
import { LanguageEditCommandSchema } from "@mixer/protocol/messages";
import { spawnProcess } from "../../utils/spawn.js";
import { terminateWithTreeKill } from "../../utils/tree-kill.js";
import { readExplorerFile } from "../file-explorer/service.js";
import { LanguageServerRegistry } from "./providers.js";
import type { LanguageServerRegistration } from "@mixer/protocol/language-services";
import { moveWorkspaceFile } from "./move.js";

const documentParams = z.object({ textDocument: z.object({ uri: z.string() }) });
const openedDocument = z.object({
  textDocument: z.object({
    uri: z.string(),
    version: z.number().int(),
    text: z.string().max(1024 * 1024),
  }),
});
const changedDocument = z.object({
  textDocument: z.object({ uri: z.string(), version: z.number().int() }),
  contentChanges: z
    .array(
      z.object({
        text: z.string().max(1024 * 1024),
        range: z
          .object({
            start: z.object({
              line: z.number().int().nonnegative(),
              character: z.number().int().nonnegative(),
            }),
            end: z.object({
              line: z.number().int().nonnegative(),
              character: z.number().int().nonnegative(),
            }),
          })
          .optional(),
      }),
    )
    .max(1),
});
const initializeResult = z
  .object({ capabilities: z.record(z.string(), z.unknown()) })
  .passthrough();
const editPosition = z.object({
  line: z.number().int().nonnegative(),
  character: z.number().int().nonnegative(),
});
const editText = z.object({
  range: z.object({ start: editPosition, end: editPosition }),
  newText: z.string().max(1024 * 1024),
});
const reviewableEdit = z
  .object({
    changes: z.record(z.string(), z.array(editText)).optional(),
    documentChanges: z
      .array(
        z.object({
          textDocument: z.object({ uri: z.string(), version: z.number().nullable() }),
          edits: z.array(editText),
        }),
      )
      .max(64)
      .optional(),
  })
  .strict();
type Language = WorkspaceLanguageRequest["language"];

interface LanguageSessionOptions {
  registry?: LanguageServerRegistry;
  getWorkspaceRoot(workspaceId: string): Promise<string | null>;
  emit(message: WorkspaceLanguageNotification): void;
  logger: pino.Logger;
}
interface ServerLease {
  registration: LanguageServerRegistration;
  controller: AbortController;
  channels: Set<string>;
  server: WorkspaceLanguageServer | null;
}

// Shared across physical clients. Multiple windows must not start unbounded indexers.
const activeLanguageServers = new Set<ServerLease>();
const initializeLanguageServer = pLimit(2);
const MAX_ACTIVE_LANGUAGE_SERVERS = 8;

/** Processes and unsaved buffers belong to this client session, never to the renderer's machine. */
export class WorkspaceLanguageSession {
  private readonly servers = new Map<
    string,
    { lease: ServerLease; pending: Promise<WorkspaceLanguageServer> }
  >();
  private disposed = false;
  private readonly registry: LanguageServerRegistry;

  constructor(private readonly options: LanguageSessionOptions) {
    this.registry = options.registry ?? new LanguageServerRegistry();
  }

  async request(input: WorkspaceLanguageRequest): Promise<unknown> {
    if (this.disposed) throw new Error("Language service session is closed");
    await this.refreshProviders();
    const key = `${input.workspaceId}:${input.language}`;
    let entry = this.servers.get(key);
    if (!entry) {
      if (input.method !== "initialize")
        throw new ResponseError(-32802, "Language services require initialization after restart.");
      if (activeLanguageServers.size >= MAX_ACTIVE_LANGUAGE_SERVERS)
        throw new Error(
          "The host has reached its limit of 8 active language servers. Close unused editors and retry.",
        );
      const lease: ServerLease = {
        registration: this.registry.get(input.language),
        controller: new AbortController(),
        channels: new Set(),
        server: null,
      };
      activeLanguageServers.add(lease);
      const pending = this.start(input.workspaceId, input.language, lease);
      entry = { lease, pending };
      this.servers.set(key, entry);
      void pending.catch(() => {
        activeLanguageServers.delete(lease);
        if (this.servers.get(key)?.pending === pending) this.servers.delete(key);
      });
    }
    if (input.method === "initialize") entry.lease.channels.add(input.channelId);
    if (!entry.lease.channels.has(input.channelId))
      throw new ResponseError(-32802, "Language-service channel is closed.");
    const server = await entry.pending;
    if (this.disposed) throw new Error("Language service session is closed");
    if (entry.lease.controller.signal.aborted)
      throw new ResponseError(-32802, "Language-service channel is closed.");
    return server.request(input);
  }

  private async start(
    workspaceId: string,
    language: Language,
    lease: ServerLease,
  ): Promise<WorkspaceLanguageServer> {
    return initializeLanguageServer(() => this.startNow(workspaceId, language, lease));
  }

  private async startNow(
    workspaceId: string,
    language: Language,
    lease: ServerLease,
  ): Promise<WorkspaceLanguageServer> {
    const directory = await this.options.getWorkspaceRoot(workspaceId);
    if (!directory) throw new Error("Workspace directory is unavailable");
    const root = await realpath(directory);
    const registration = lease.registration;
    if (this.disposed || lease.controller.signal.aborted)
      throw new Error("Language service session is closed");
    const server = new WorkspaceLanguageServer(
      root,
      path.resolve(directory),
      language,
      registration,
      (method, params) => {
        if (!this.disposed && !lease.controller.signal.aborted)
          this.options.emit({
            type: "workspace.language.notification",
            payload: { workspaceId, language, method, params },
          });
      },
      this.options.logger,
      () => {
        const key = `${workspaceId}:${language}`;
        if (
          this.disposed ||
          lease.controller.signal.aborted ||
          this.servers.get(key)?.lease !== lease
        )
          return;
        this.servers.delete(key);
        activeLanguageServers.delete(lease);
        lease.controller.abort();
        this.options.emit({
          type: "workspace.language.notification",
          payload: { workspaceId, language, method: "mixer/languageServiceStopped", params: {} },
        });
      },
    );
    lease.server = server;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        server.initialize(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error(`${registration.label} did not initialize within 20 seconds.`)),
            20_000,
          );
          timer.unref();
        }),
      ]);
      if (this.disposed || lease.controller.signal.aborted)
        throw new Error("Language service session is closed");
      return server;
    } catch (error) {
      await server.dispose();
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    await Promise.allSettled(
      [...this.servers.values()].map(async ({ lease }) => {
        activeLanguageServers.delete(lease);
        lease.controller.abort();
        await lease.server?.dispose();
      }),
    );
    this.servers.clear();
  }

  async refreshProviders(): Promise<void> {
    const current = new Map(
      this.registry.registrations().map((provider) => [provider.id, JSON.stringify(provider)]),
    );
    await Promise.all(
      [...this.servers.entries()].map(async ([key, entry]) => {
        if (current.get(entry.lease.registration.id) === JSON.stringify(entry.lease.registration))
          return;
        this.servers.delete(key);
        activeLanguageServers.delete(entry.lease);
        entry.lease.controller.abort();
        await entry.lease.server?.dispose();
        const separator = key.lastIndexOf(":");
        this.options.emit({
          type: "workspace.language.notification",
          payload: {
            workspaceId: key.slice(0, separator),
            language: entry.lease.registration.id,
            method: "mixer/languageServiceStopped",
            params: {},
          },
        });
      }),
    );
  }

  async releaseChannel(input: WorkspaceLanguageRequest): Promise<void> {
    const key = `${input.workspaceId}:${input.language}`;
    const entry = this.servers.get(key);
    if (!entry) return;
    entry.lease.channels.delete(input.channelId);
    if (entry.lease.channels.size === 0) {
      activeLanguageServers.delete(entry.lease);
      entry.lease.controller.abort();
      this.servers.delete(key);
      await entry.lease.server?.dispose();
    } else {
      const server = await entry.pending;
      if (entry.lease.controller.signal.aborted) return;
      try {
        await server.request({ ...input, method: "shutdown", notification: true });
      } catch (error) {
        if (!entry.lease.controller.signal.aborted && !this.disposed) throw error;
      }
    }
  }
}

class WorkspaceLanguageServer {
  private readonly child;
  private readonly connection: MessageConnection;
  private readonly documents = new Map<string, { channelId: string; version: number }>();
  private readonly requests = new Map<string, CancellationTokenSource>();
  private initialized: unknown = null;
  private closed = false;
  private disposing: Promise<void> | null = null;
  private commandQueue: Promise<unknown> = Promise.resolve();
  private capturedEdit: unknown = null;
  private collectingEdit = false;

  constructor(
    private readonly root: string,
    private readonly clientRoot: string,
    private readonly language: Language,
    private readonly registration: LanguageServerRegistration,
    private readonly notify: (method: string, params: unknown) => void,
    logger: pino.Logger,
    private readonly onStopped: () => void,
  ) {
    const [executable, ...args] = registration.command;
    this.child = spawnProcess(executable, args, {
      cwd: root,
      stdio: ["pipe", "pipe", "pipe"],
      envMode: "internal",
      // Keep native server helpers in an owned process group if their wrapper crashes.
      detached: process.platform !== "win32",
      envOverlay: { NODE_OPTIONS: undefined, ...registration.env },
    });
    const { stdin, stdout, stderr } = this.child;
    if (!stdin || !stdout || !stderr) throw new Error("Language server pipes are unavailable");
    this.connection = createMessageConnection(
      new StreamMessageReader(stdout),
      new StreamMessageWriter(stdin),
    );
    stderr.on("data", (data: Buffer) =>
      logger.debug({ language, stderr: data.toString().slice(0, 2048) }, "Language server stderr"),
    );
    this.child.on("error", (error) => {
      logger.warn({ err: error, language }, "Language server failed");
      if (!this.closed) {
        this.closed = true;
        this.onStopped();
      }
      this.connection.dispose();
    });
    this.child.on("exit", (code, signal) => {
      if (process.platform !== "win32" && this.child.pid) {
        try {
          process.kill(-this.child.pid, "SIGKILL");
        } catch (error) {
          if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ESRCH")
            logger.warn({ err: error, language }, "Could not reap language-server process group");
        }
      }
      const expected = this.closed;
      this.closed = true;
      if (!expected) this.onStopped();
      this.connection.dispose();
      if (expected) return;
      logger.warn({ language, code, signal }, "Language server exited unexpectedly");
    });
    this.connection.onNotification((method, params) => {
      if (method === "textDocument/publishDiagnostics" || method === "window/logMessage")
        this.notify(method, params);
    });
    this.connection.onRequest("workspace/configuration", (params: unknown) => {
      const request = z
        .object({ items: z.array(z.object({ section: z.string().optional() })) })
        .parse(params);
      return request.items.map(({ section }) => {
        let value: unknown = this.registration.settings ?? {};
        if (!section) return value;
        for (const key of section.split(".")) {
          if (!value || typeof value !== "object" || !Object.hasOwn(value, key)) return null;
          value = Reflect.get(value, key);
        }
        return value;
      });
    });
    this.connection.onRequest("client/registerCapability", () => {
      throw new ResponseError(
        -32601,
        "Dynamic capability registration is not supported. This client negotiates static capabilities at initialization.",
      );
    });
    this.connection.onRequest("window/workDoneProgress/create", () => null);
    this.connection.onRequest("workspace/workspaceFolders", () => [
      { uri: pathToFileURL(root).href, name: path.basename(root) },
    ]);
    this.connection.onRequest("workspace/applyEdit", async (params: unknown) => {
      if (!this.collectingEdit)
        return { applied: false, failureReason: "Edits must be requested through editor review." };
      if (this.capturedEdit) throw new Error("A command produced more than one workspace edit");
      const request = z.object({ edit: reviewableEdit }).parse(params);
      await this.validateEdit(request.edit);
      this.capturedEdit = request.edit;
      // The client has not accepted the preview. Returning false also prevents follow-up rename prompts.
      return {
        applied: false,
        failureReason: "Captured for user review. No files have been changed.",
      };
    });
    this.connection.listen();
  }

  async initialize(): Promise<void> {
    const uri = pathToFileURL(this.root).href;
    const result = await this.connection.sendRequest("initialize", {
      processId: process.pid,
      rootUri: uri,
      workspaceFolders: [{ uri, name: path.basename(this.root) }],
      capabilities: {
        workspace: {
          configuration: true,
          workspaceFolders: true,
          applyEdit: true,
          workspaceEdit: { documentChanges: true },
          fileOperations: { willRename: true, didRename: true },
        },
        textDocument: {
          synchronization: { didSave: true },
          completion: {
            completionItem: {
              snippetSupport: true,
              documentationFormat: ["markdown", "plaintext"],
              resolveSupport: { properties: ["documentation", "detail", "additionalTextEdits"] },
            },
          },
          hover: { contentFormat: ["markdown", "plaintext"] },
          signatureHelp: {
            signatureInformation: {
              documentationFormat: ["markdown", "plaintext"],
              parameterInformation: { labelOffsetSupport: true },
            },
          },
          definition: { linkSupport: true },
          typeDefinition: { linkSupport: true, dynamicRegistration: false },
          implementation: { linkSupport: true, dynamicRegistration: false },
          inlayHint: { dynamicRegistration: false },
          foldingRange: { dynamicRegistration: false, lineFoldingOnly: true },
          semanticTokens: {
            dynamicRegistration: false,
            requests: { full: true },
            formats: ["relative"],
            tokenTypes: [
              "namespace",
              "type",
              "class",
              "enum",
              "interface",
              "struct",
              "typeParameter",
              "parameter",
              "variable",
              "property",
              "enumMember",
              "event",
              "function",
              "method",
              "macro",
              "keyword",
              "modifier",
              "comment",
              "string",
              "number",
              "regexp",
              "operator",
              "decorator",
            ],
            tokenModifiers: [
              "declaration",
              "definition",
              "readonly",
              "static",
              "deprecated",
              "abstract",
              "async",
              "modification",
              "documentation",
              "defaultLibrary",
            ],
            overlappingTokenSupport: false,
            multilineTokenSupport: false,
          },
          rename: { prepareSupport: true },
          publishDiagnostics: { versionSupport: true },
          documentSymbol: { hierarchicalDocumentSymbolSupport: true },
          codeAction: {
            codeActionLiteralSupport: {
              codeActionKind: { valueSet: ["quickfix", "refactor", "source.organizeImports"] },
            },
            resolveSupport: { properties: ["edit"] },
          },
        },
      },
      initializationOptions: this.registration.initializationOptions ?? {},
    });
    this.initialized = {
      ...initializeResult.parse(result),
      rootUri: uri,
      workspaceUri: pathToFileURL(this.clientRoot).href,
    };
    await this.connection.sendNotification("initialized", {});
    if (this.registration.settings)
      await this.connection.sendNotification("workspace/didChangeConfiguration", {
        settings: this.registration.settings,
      });
  }

  async request(input: WorkspaceLanguageRequest): Promise<unknown> {
    if (this.closed) throw new Error("Language server stopped. Reopen the editor to reconnect.");
    if (input.method === "initialize") return this.initialized;
    if (input.method === "initialized") return null;
    if (input.method === "workspace/moveFile") return moveWorkspaceFile(this.root, input.params);
    if (input.method === "workspace/executeCommand") {
      const task = this.commandQueue.then(() => this.executeCommand(input));
      this.commandQueue = task.catch(() => undefined);
      return task;
    }
    if (
      input.method === "workspace/willRenameFiles" ||
      input.method === "workspace/didRenameFiles"
    ) {
      const value = z
        .object({ files: z.array(z.object({ oldUri: z.string(), newUri: z.string() })).length(1) })
        .parse(input.params);
      for (const file of value.files) {
        await this.validateUri(file.oldUri);
        await this.validateUri(file.newUri);
      }
      if (input.method === "workspace/didRenameFiles") {
        await this.connection.sendNotification(input.method, value);
        return null;
      }
    }
    if (input.method === "workspace/readFile") {
      return this.readFile(input.params);
    }
    if (input.method === "shutdown" || input.method === "exit") {
      for (const [uri, owner] of this.documents) {
        if (owner.channelId !== input.channelId) continue;
        this.documents.delete(uri);
        await this.connection.sendNotification("textDocument/didClose", { textDocument: { uri } });
      }
      return null;
    }
    if (input.method === "$/cancelRequest") {
      const { id } = z.object({ id: z.union([z.string(), z.number()]) }).parse(input.params);
      this.requests.get(`${input.channelId}:${id}`)?.cancel();
      return null;
    }
    if (!(await this.checkDocument(input))) return null;
    if (input.notification) {
      await this.connection.sendNotification(input.method, input.params);
      return null;
    }
    const token = new CancellationTokenSource();
    const key = `${input.channelId}:${input.messageId}`;
    this.requests.set(key, token);
    try {
      return await this.connection.sendRequest(input.method, input.params, token.token);
    } finally {
      token.dispose();
      this.requests.delete(key);
    }
  }

  private async checkDocument(input: WorkspaceLanguageRequest): Promise<boolean> {
    const document = documentParams.safeParse(input.params);
    if (document.success) await this.validateUri(document.data.textDocument.uri);
    if (input.method === "textDocument/didOpen") {
      const { textDocument } = openedDocument.parse(input.params);
      const previous = this.documents.get(textDocument.uri);
      if (previous && previous.channelId !== input.channelId)
        throw new Error("This file already has an editor language session");
      if (previous && textDocument.version <= previous.version) return false;
      if (this.documents.size >= 128 && !previous)
        throw new Error("Too many open language-service documents");
      this.documents.set(textDocument.uri, {
        channelId: input.channelId,
        version: textDocument.version,
      });
    } else if (document.success) {
      const owner = this.documents.get(document.data.textDocument.uri);
      if (!owner || owner.channelId !== input.channelId)
        throw new Error("Language-service document is not open in this editor");
      if (input.method === "textDocument/didChange") {
        const change = changedDocument.parse(input.params);
        if (change.textDocument.version <= owner.version) return false;
        owner.version = change.textDocument.version;
      }
      if (input.method === "textDocument/didClose")
        this.documents.delete(document.data.textDocument.uri);
    }
    return true;
  }

  private async executeCommand(input: WorkspaceLanguageRequest): Promise<unknown> {
    const parsed = LanguageEditCommandSchema.safeParse(input.params);
    if (!parsed.success)
      throw new Error("This language-server command or its arguments are not allowed");
    const command = parsed.data;
    const python = command.command === "pyright.organizeimports";
    if (python !== (this.language === "python"))
      throw new Error("The command is not allowed for this language server");
    let uri: string;
    if (command.command === "pyright.organizeimports") uri = command.arguments[0];
    else if (command.command === "_typescript.organizeImports")
      uri = pathToFileURL(command.arguments[0]).href;
    else uri = pathToFileURL(command.arguments[0].file).href;
    await this.validateUri(uri);
    if (this.documents.get(uri)?.channelId !== input.channelId)
      throw new Error("The command's document is not open in this workspace session");
    this.capturedEdit = null;
    this.collectingEdit = true;
    try {
      const result = await this.connection.sendRequest("workspace/executeCommand", command);
      const returned = reviewableEdit.safeParse(result);
      const edit = reviewableEdit.parse(
        this.capturedEdit ?? (returned.success ? returned.data : { changes: {} }),
      );
      await this.validateEdit(edit);
      return { edit };
    } finally {
      this.collectingEdit = false;
      this.capturedEdit = null;
    }
  }

  private async validateEdit(edit: z.infer<typeof reviewableEdit>) {
    const uris = [
      ...Object.keys(edit.changes ?? {}),
      ...(edit.documentChanges ?? []).map((change) => change.textDocument.uri),
    ];
    if (uris.length > 64) throw new Error("An edit command may change at most 64 files");
    for (const uri of uris) await this.validateUri(uri);
  }

  private async readFile(params: unknown) {
    const { uri } = z.object({ uri: z.string() }).parse(params);
    await this.validateUri(uri);
    const file = await readExplorerFile({
      root: this.root,
      relativePath: path.relative(this.root, fileURLToPath(uri)),
    });
    if (file.kind !== "text" || file.size > 1024 * 1024)
      throw new Error("Definition file is too large or is not text");
    return { content: file.content ?? "" };
  }

  private async validateUri(uri: string): Promise<void> {
    const filename = fileURLToPath(uri);
    let resolved: string;
    try {
      resolved = await realpath(filename);
    } catch (error) {
      if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT")
        throw error;
      resolved = path.join(await realpath(path.dirname(filename)), path.basename(filename));
    }
    const relative = path.relative(this.root, resolved);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
      throw new Error("Language-service file is outside the workspace");
  }

  async dispose(): Promise<void> {
    if (this.disposing) return this.disposing;
    this.closed = true;
    for (const token of this.requests.values()) {
      token.cancel();
      token.dispose();
    }
    this.requests.clear();
    this.connection.dispose();
    this.disposing = terminateWithTreeKill(this.child, {
      gracefulTimeoutMs: 1000,
      forceTimeoutMs: 1000,
    }).then(() => undefined);
    return this.disposing;
  }
}
