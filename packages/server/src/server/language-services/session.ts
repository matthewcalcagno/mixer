import path from "node:path";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { realpath, mkdir } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  CancellationTokenSource,
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
  ResponseError,
  ProgressType,
  type MessageConnection,
} from "vscode-jsonrpc/node.js";
import { z } from "zod";
import pLimit from "p-limit";
import type pino from "pino";
import type {
  WorkspaceLanguageRequest,
  WorkspaceLanguageNotification,
} from "@mixer/protocol/messages";
import {
  WorkspaceLanguageRequestSchema,
  LanguageEditCommandSchema,
} from "@mixer/protocol/messages";
import { spawnProcess } from "../../utils/spawn.js";
import { terminateWithTreeKill } from "../../utils/tree-kill.js";
import { readExplorerFile } from "../file-explorer/service.js";
import { LanguageServerRegistry } from "./providers.js";
import type { LanguageServerRegistration } from "@mixer/protocol/language-services";
import { createFileObserver } from "../file-observer/index.js";
import type { FileObserver } from "../file-observer/index.js";
import { LanguageWatchedFiles } from "./watched-files.js";
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
  storageRoot?: string;
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
  private readonly fileObserver = createFileObserver();

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
    // Progress may arrive during initialize; waiting for initialization here would deadlock cancellation.
    if (input.method === "$/workDoneProgress/cancel" && entry.lease.server)
      return entry.lease.server.request(input);
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
    const serverData = path.join(
      this.options.storageRoot ?? path.join(tmpdir(), "mixer-language-services"),
      createHash("sha256").update(`${root}\0${registration.id}`).digest("hex"),
    );
    const launch = JSON.stringify(registration);
    if (launch.includes("${serverData}")) await mkdir(serverData, { recursive: true });
    const expanded = JSON.parse(
      launch
        .replaceAll("${workspaceFolder}", JSON.stringify(root).slice(1, -1))
        .replaceAll("${workspaceUri}", pathToFileURL(root).href)
        .replaceAll("${serverData}", JSON.stringify(serverData).slice(1, -1)),
    ) as LanguageServerRegistration;
    if (this.disposed || lease.controller.signal.aborted)
      throw new Error("Language service session is closed");
    const server = new WorkspaceLanguageServer(
      root,
      path.resolve(directory),
      language,
      expanded,
      this.fileObserver,
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
            () =>
              reject(
                new Error(
                  `${registration.label} did not initialize within ${(registration.initializationTimeoutMs ?? 20_000) / 1000} seconds.`,
                ),
              ),
            registration.initializationTimeoutMs ?? 20_000,
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
    await this.fileObserver.close();
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
  private readonly watchedFiles: LanguageWatchedFiles;
  private capabilityQueue: Promise<unknown> = Promise.resolve();
  private readonly progress = new Map<string | number, { dispose(): void }>();
  private diagnosticOptions: Record<string, unknown> | null = null;
  private staticDiagnosticOptions: Record<string, unknown> | null = null;
  private readonly diagnosticRegistrations = new Map<string, Record<string, unknown>>();
  private readonly diagnosticTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly diagnosticRequests = new Map<string, CancellationTokenSource>();
  private readonly diagnosticIds = new Map<string, string>();

  constructor(
    private readonly root: string,
    private readonly clientRoot: string,
    private readonly language: Language,
    private readonly registration: LanguageServerRegistration,
    observer: FileObserver,
    private readonly notify: (method: string, params: unknown) => void,
    logger: pino.Logger,
    private readonly onStopped: () => void,
  ) {
    this.watchedFiles = new LanguageWatchedFiles(
      root,
      observer,
      registration.watchIgnoredDirectories ?? [
        ".git",
        "node_modules",
        ".gradle",
        "build",
        "target",
      ],
      (changes) => {
        void this.connection
          .sendNotification("workspace/didChangeWatchedFiles", { changes })
          .then(() => {
            for (const uri of this.documents.keys()) this.scheduleDiagnostics(uri);
            return undefined;
          })
          .catch((error) =>
            logger.warn({ err: error, language }, "Language file notification failed"),
          );
      },
      (error) => {
        logger.warn({ err: error, language }, "Language file observation failed");
        this.notify("window/logMessage", { type: 2, message: error.message });
      },
    );
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
      void this.dispose();
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
      void this.dispose();
      if (expected) return;
      logger.warn({ language, code, signal }, "Language server exited unexpectedly");
    });
    this.connection.onNotification((method, params) => {
      if (
        method === "textDocument/publishDiagnostics" ||
        method === "window/logMessage" ||
        method === "window/showMessage" ||
        this.registration.extensions?.notifications?.includes(method)
      )
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
    this.connection.onRequest("client/registerCapability", (params: unknown) => {
      const { registrations } = z
        .object({
          registrations: z
            .array(
              z.object({
                id: z.string(),
                method: z.string(),
                registerOptions: z.unknown().optional(),
              }),
            )
            .max(128),
        })
        .parse(params);
      for (const entry of registrations)
        if (
          ![
            "workspace/didChangeWatchedFiles",
            "textDocument/diagnostic",
            "workspace/didChangeConfiguration",
          ].includes(entry.method)
        )
          throw new ResponseError(-32602, `Unsupported dynamic capability: ${entry.method}`);
      const task = this.capabilityQueue.then(async () => {
        for (const entry of registrations) {
          if (entry.method === "workspace/didChangeWatchedFiles")
            await this.watchedFiles.register(entry.id, entry.registerOptions);
          else if (entry.method === "textDocument/diagnostic") {
            this.diagnosticOptions = z
              .record(z.string(), z.unknown())
              .parse(entry.registerOptions ?? {});
            this.diagnosticRegistrations.set(entry.id, this.diagnosticOptions);
            for (const uri of this.documents.keys()) this.scheduleDiagnostics(uri);
          } else if (entry.method !== "workspace/didChangeConfiguration")
            throw new ResponseError(-32602, `Unsupported dynamic capability: ${entry.method}`);
        }
        return null;
      });
      this.capabilityQueue = task.catch(() => undefined);
      return task;
    });
    this.connection.onRequest("client/unregisterCapability", (params: unknown) => {
      const { unregisterations } = z
        .object({
          unregisterations: z.array(z.object({ id: z.string(), method: z.string() })).max(128),
        })
        .parse(params);
      const task = this.capabilityQueue.then(async () => {
        for (const entry of unregisterations) {
          if (entry.method === "workspace/didChangeWatchedFiles")
            await this.watchedFiles.unregister(entry.id);
          if (
            entry.method === "textDocument/diagnostic" &&
            this.diagnosticRegistrations.delete(entry.id)
          ) {
            this.diagnosticOptions =
              [...this.diagnosticRegistrations.values()].at(-1) ?? this.staticDiagnosticOptions;
            this.clearDiagnostics();
            for (const uri of this.documents.keys()) this.scheduleDiagnostics(uri);
          }
        }
        return null;
      });
      this.capabilityQueue = task.catch(() => undefined);
      return task;
    });
    this.connection.onRequest("window/workDoneProgress/create", (params: unknown) => {
      const { token } = z.object({ token: z.union([z.string(), z.number()]) }).parse(params);
      this.trackProgress(token);
      return null;
    });
    this.connection.onRequest("workspace/diagnostic/refresh", () => {
      for (const uri of this.documents.keys()) this.scheduleDiagnostics(uri);
      return null;
    });
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
    this.trackProgress("mixer-initialize");
    const result = await this.connection.sendRequest("initialize", {
      workDoneToken: "mixer-initialize",
      processId: process.pid,
      rootUri: uri,
      workspaceFolders: [{ uri, name: path.basename(this.root) }],
      capabilities: {
        window: { workDoneProgress: true },
        workspace: {
          didChangeWatchedFiles: { dynamicRegistration: true, relativePatternSupport: true },
          didChangeConfiguration: { dynamicRegistration: true },
          diagnostics: { refreshSupport: true },
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
          diagnostic: { dynamicRegistration: true, relatedDocumentSupport: false },
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
    const parsedResult = initializeResult.parse(result);
    if (
      parsedResult.capabilities.diagnosticProvider &&
      typeof parsedResult.capabilities.diagnosticProvider === "object"
    )
      this.staticDiagnosticOptions = z
        .record(z.string(), z.unknown())
        .parse(parsedResult.capabilities.diagnosticProvider);
    this.diagnosticOptions =
      [...this.diagnosticRegistrations.values()].at(-1) ?? this.staticDiagnosticOptions;
    this.initialized = {
      ...parsedResult,
      extensionRequests: this.registration.extensions?.requests ?? [],
      editCommands: this.registration.extensions?.commands ?? [],
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
    if (input.method === "workspace/languageExtension") return this.extensionRequest(input);
    if (input.method === "$/workDoneProgress/cancel") return this.cancelProgress(input.params);
    if (input.method === "workspace/moveFile") return moveWorkspaceFile(this.root, input.params);
    if (input.method === "workspace/executeCommand") {
      const task = this.commandQueue.then(() => this.executeCommand(input));
      this.commandQueue = task.catch(() => undefined);
      return task;
    }
    if (["workspace/willRenameFiles", "workspace/didRenameFiles"].includes(input.method)) {
      await this.validateFileOperation(input);
      if (input.notification) return null;
    }
    if (input.method === "workspace/readFile") {
      return this.readFile(input.params);
    }
    if (input.method === "shutdown" || input.method === "exit")
      return this.closeChannel(input.channelId);
    if (input.method === "$/cancelRequest") {
      const { id } = z.object({ id: z.union([z.string(), z.number()]) }).parse(input.params);
      this.requests.get(`${input.channelId}:${id}`)?.cancel();
      return null;
    }
    if (!(await this.checkDocument(input))) return null;
    if (input.notification) {
      await this.connection.sendNotification(input.method, input.params);
      const document = documentParams.safeParse(input.params);
      if (
        document.success &&
        ["textDocument/didOpen", "textDocument/didChange", "textDocument/didSave"].includes(
          input.method,
        )
      )
        this.scheduleDiagnostics(document.data.textDocument.uri);
      return null;
    }
    return this.sendRequest(input.method, input.params, input);
  }

  private async closeChannel(channelId: string): Promise<null> {
    for (const [uri, owner] of this.documents) {
      if (owner.channelId !== channelId) continue;
      this.documents.delete(uri);
      this.cancelDiagnostics(uri);
      await this.connection.sendNotification("textDocument/didClose", { textDocument: { uri } });
    }
    return null;
  }

  private extensionRequest(input: WorkspaceLanguageRequest): Promise<unknown> {
    const extension = z
      .object({ method: z.string(), params: z.unknown().optional() })
      .parse(input.params);
    if (
      WorkspaceLanguageRequestSchema.shape.method.safeParse(extension.method).success ||
      !this.registration.extensions?.requests?.includes(extension.method)
    )
      throw new Error(
        `Language-server request is not declared by this plugin: ${extension.method}`,
      );
    return this.sendRequest(extension.method, extension.params, input);
  }

  private async cancelProgress(params: unknown): Promise<null> {
    const value = z.object({ token: z.union([z.string(), z.number()]) }).parse(params);
    if (this.progress.has(value.token))
      await this.connection.sendNotification("$/workDoneProgress/cancel", value);
    return null;
  }

  private async validateFileOperation(input: WorkspaceLanguageRequest): Promise<void> {
    const value = z
      .object({ files: z.array(z.object({ oldUri: z.string(), newUri: z.string() })).length(1) })
      .parse(input.params);
    for (const file of value.files) {
      await this.validateUri(file.oldUri);
      await this.validateUri(file.newUri);
    }
    if (input.method === "workspace/didRenameFiles")
      await this.connection.sendNotification(input.method, value);
  }

  private async sendRequest(
    method: string,
    params: unknown,
    input: WorkspaceLanguageRequest,
  ): Promise<unknown> {
    const token = new CancellationTokenSource();
    const key = `${input.channelId}:${input.messageId}`;
    this.requests.set(key, token);
    try {
      return await this.connection.sendRequest(method, params, token.token);
    } finally {
      token.dispose();
      this.requests.delete(key);
    }
  }

  private trackProgress(token: string | number): void {
    if (this.progress.has(token)) return;
    if (this.progress.size >= 128) throw new Error("Too many language-server progress tokens");
    const listener = this.connection.onProgress(new ProgressType<unknown>(), token, (value) => {
      this.notify("$/progress", { token, value });
      if (value && typeof value === "object" && "kind" in value && value.kind === "end") {
        this.progress.get(token)?.dispose();
        this.progress.delete(token);
      }
    });
    this.progress.set(token, listener);
  }

  private cancelDiagnostics(uri: string): void {
    const timer = this.diagnosticTimers.get(uri);
    if (timer) clearTimeout(timer);
    this.diagnosticTimers.delete(uri);
    const token = this.diagnosticRequests.get(uri);
    token?.cancel();
    token?.dispose();
    this.diagnosticRequests.delete(uri);
    this.diagnosticIds.delete(uri);
  }

  private clearDiagnostics(): void {
    for (const uri of new Set([...this.diagnosticTimers.keys(), ...this.diagnosticRequests.keys()]))
      this.cancelDiagnostics(uri);
    for (const uri of this.documents.keys())
      this.notify("textDocument/publishDiagnostics", { uri, diagnostics: [] });
  }

  private scheduleDiagnostics(uri: string): void {
    if (!this.diagnosticOptions || this.closed || !this.documents.has(uri)) return;
    const previousResultId = this.diagnosticIds.get(uri);
    this.cancelDiagnostics(uri);
    if (previousResultId) this.diagnosticIds.set(uri, previousResultId);
    this.diagnosticTimers.set(
      uri,
      setTimeout(() => {
        this.diagnosticTimers.delete(uri);
        const owner = this.documents.get(uri);
        if (!owner || this.closed) return;
        const version = owner.version;
        const token = new CancellationTokenSource();
        this.diagnosticRequests.set(uri, token);
        void this.connection
          .sendRequest(
            "textDocument/diagnostic",
            {
              textDocument: { uri },
              identifier: this.diagnosticOptions?.identifier,
              previousResultId,
            },
            token.token,
          )
          .then((result: unknown) => {
            if (
              token.token.isCancellationRequested ||
              this.closed ||
              this.documents.get(uri)?.version !== version
            )
              return;
            const report = z
              .discriminatedUnion("kind", [
                z.object({
                  kind: z.literal("full"),
                  items: z.array(z.unknown()),
                  resultId: z.string().optional(),
                }),
                z.object({ kind: z.literal("unchanged"), resultId: z.string() }),
              ])
              .parse(result);
            if (report.resultId) this.diagnosticIds.set(uri, report.resultId);
            if (report.kind === "full")
              this.notify("textDocument/publishDiagnostics", {
                uri,
                version,
                diagnostics: report.items,
              });
            return undefined;
          })
          .catch((error: unknown) => {
            if (!token.token.isCancellationRequested && !this.closed)
              this.notify("window/logMessage", {
                type: 2,
                message: `Diagnostics failed: ${error instanceof Error ? error.message : String(error)}`,
              });
          })
          .finally(() => {
            if (this.diagnosticRequests.get(uri) === token) this.diagnosticRequests.delete(uri);
            token.dispose();
          });
      }, 150),
    );
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
      if (input.method === "textDocument/didClose") {
        this.documents.delete(document.data.textDocument.uri);
        this.cancelDiagnostics(document.data.textDocument.uri);
      }
    }
    return true;
  }

  private async executeCommand(input: WorkspaceLanguageRequest): Promise<unknown> {
    const parsed = LanguageEditCommandSchema.safeParse(input.params);
    const extension = z
      .object({ command: z.string(), arguments: z.array(z.unknown()).max(64).optional() })
      .safeParse(input.params);
    const declared =
      extension.success && this.registration.extensions?.commands?.includes(extension.data.command);
    if (!parsed.success && !declared)
      throw new Error("This language-server command or its arguments are not allowed");
    const command = parsed.success ? parsed.data : extension.data!;
    const python = command.command === "pyright.organizeimports";
    if (!declared && python !== (this.language === "python"))
      throw new Error("The command is not allowed for this language server");
    let uri: string;
    if (declared) {
      if (![...this.documents.values()].some((owner) => owner.channelId === input.channelId))
        throw new Error("Open a document before executing a language-server command");
    } else {
      const builtInCommand = LanguageEditCommandSchema.parse(input.params);
      if (builtInCommand.command === "pyright.organizeimports") uri = builtInCommand.arguments[0];
      else if (builtInCommand.command === "_typescript.organizeImports")
        uri = pathToFileURL(builtInCommand.arguments[0]).href;
      else uri = pathToFileURL(builtInCommand.arguments[0].file).href;
      await this.validateUri(uri);
      if (this.documents.get(uri)?.channelId !== input.channelId)
        throw new Error("The command's document is not open in this workspace session");
    }
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
    if (new URL(uri).protocol !== "file:") {
      const definition = this.registration.extensions?.virtualDocuments?.find(
        (item) => `${item.scheme}:` === new URL(uri).protocol,
      );
      if (!definition)
        throw new Error("This virtual document scheme is not registered by the plugin");
      const content = z
        .string()
        .max(1024 * 1024)
        .parse(await this.connection.sendRequest(definition.method, { uri }));
      return { content };
    }
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
    this.clearDiagnostics();
    for (const listener of this.progress.values()) listener.dispose();
    this.progress.clear();
    this.connection.dispose();
    this.disposing = Promise.allSettled([
      this.capabilityQueue.then(() => this.watchedFiles.dispose()),
      terminateWithTreeKill(this.child, {
        gracefulTimeoutMs: 1000,
        forceTimeoutMs: 1000,
      }),
    ]).then(() => undefined);
    return this.disposing;
  }
}
