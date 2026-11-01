import { z } from "zod";
import {
  WorkspaceLanguageRequestSchema,
  type WorkspaceLanguageRequest,
} from "@mixer/protocol/messages";
import type { DaemonClient } from "@mixer/client/internal/daemon-client";
import type { WorkspaceDocuments } from "./documents";
import { workspaceEditSchema, editInputs, type ReviewEdit } from "./workspace-edit";
import { resolveWorkspaceFilePaths } from "@/workspace/file-open";
import type { SharedFileDocument } from "./documents";
import {
  LEGACY_LANGUAGE_PROVIDERS,
  languageForDocument,
  providerForDocument,
  type LanguageProvider,
} from "@mixer/protocol/language-services";
import { readLanguageProviders } from "./language-provider-catalog.electron";
import { incrementalDocumentChange } from "./language-document-change";
import { languageServiceId } from "./language-modes";

const rpc = z.object({
  jsonrpc: z.literal("2.0"),
  method: z.string(),
  params: z.unknown().optional(),
  id: z.union([z.number(), z.string()]).optional(),
});
const textDocument = z.object({
  textDocument: z.object({
    uri: z.string(),
    version: z.number().optional(),
    text: z.string().optional(),
  }),
});
type Method = WorkspaceLanguageRequest["method"];
type Language = WorkspaceLanguageRequest["language"];

function commandKey(command: { command: string; arguments?: unknown[] }): string {
  return `command:${JSON.stringify([command.command, command.arguments ?? []])}`;
}

export function fileUri(path: string): string {
  const uri = new URL("file:///");
  uri.pathname = path.startsWith("/") ? path : `/${path}`;
  return uri.href;
}

interface BridgeOptions {
  port: MessagePort;
  client: DaemonClient;
  workspaceId: string;
  language: Language;
  provider?: LanguageProvider;
  channelId: string;
  documents: WorkspaceDocuments;
  onReview(input: ReviewEdit): Promise<boolean>;
  onError(message: string): void;
  onReady(): void;
  restart?: boolean;
}

type LanguageClient = Pick<
  DaemonClient,
  | "isConnected"
  | "subscribeConnectionStatus"
  | "subscribeRawMessages"
  | "requestWorkspaceLanguageService"
>;
type RecoveryState =
  | { kind: "idle" }
  | { kind: "restarting"; task: Promise<void> }
  | { kind: "failed"; error: Error };

const sessions = new WeakMap<WorkspaceDocuments, Map<Language, SharedLanguageSession>>();

/** One server channel owns every shared buffer, regardless of how many Monaco frames display it. */
export class SharedLanguageSession {
  private readonly provider: LanguageProvider;
  readonly channelId = crypto.randomUUID();
  readonly frames = new Set<(method: string, params: unknown) => void>();
  private ready: Promise<unknown> | null = null;
  private versions = new Map<string, { version: number; content: string; languageId: string }>();
  private incrementalSync = false;
  private synchronizationQueued = false;
  private rootUri = "";
  private workspaceUri = "";
  private queue = Promise.resolve();
  private syncing: Promise<void> = Promise.resolve();
  private readonly unsubscribe: () => void;
  private readonly unwatch: () => void;
  private readonly unbind: () => void;
  private connected: boolean;
  private disposed = false;
  private generation = 0;
  private readonly restarts: number[] = [];
  private recovery: RecoveryState = { kind: "idle" };

  constructor(
    private readonly options: Pick<
      BridgeOptions,
      "documents" | "workspaceId" | "language" | "provider"
    > & {
      client: LanguageClient;
    },
  ) {
    const { client, documents, workspaceId, language } = options;
    const provider =
      options.provider ?? LEGACY_LANGUAGE_PROVIDERS.find((item) => item.id === language);
    if (!provider) throw new Error(`Unknown language provider: ${language}`);
    this.provider = provider;
    this.connected = client.isConnected;
    this.unsubscribe = documents.subscribe(() => {
      if (this.synchronizationQueued) return;
      this.synchronizationQueued = true;
      this.queue = this.queue
        .then(() => {
          this.synchronizationQueued = false;
          return this.synchronize();
        })
        .catch((error: unknown) => {
          if (this.disposed || this.recovery.kind !== "idle") return;
          this.broadcast("window/logMessage", {
            type: 1,
            message: error instanceof Error ? error.message : String(error),
          });
        });
    });
    this.unwatch = client.subscribeConnectionStatus((state) => {
      const connected = state.status === "connected";
      if (this.connected && !connected) {
        this.generation++;
        this.ready = null;
        this.versions.clear();
        if (this.recovery.kind === "restarting") this.recovery = { kind: "idle" };
      }
      if (!this.connected && connected)
        void this.synchronize()
          .then(() => {
            this.broadcast("mixer/languageServiceState", { state: "ready" });
            return undefined;
          })
          .catch((error: unknown) =>
            this.broadcast("window/logMessage", {
              type: 1,
              message: error instanceof Error ? error.message : String(error),
            }),
          );
      this.connected = connected;
    });
    this.unbind = client.subscribeRawMessages((message) => {
      if (
        message.type !== "workspace.language.notification" ||
        message.payload.workspaceId !== workspaceId ||
        message.payload.language !== language
      )
        return;
      if (message.payload.method === "mixer/languageServiceStopped") {
        this.restart();
        return;
      }
      if (message.payload.method === "textDocument/publishDiagnostics") {
        const diagnostics = z
          .object({ uri: z.string(), version: z.number().optional() })
          .passthrough()
          .safeParse(message.payload.params);
        if (!diagnostics.success) return;
        const { version, ...value } = diagnostics.data;
        if (version !== undefined && version !== this.versions.get(value.uri)?.version) return;
        this.broadcast(message.payload.method, value);
      } else this.broadcast(message.payload.method, message.payload.params);
    });
  }

  private broadcast(method: string, params: unknown) {
    if (this.disposed) return;
    for (const frame of this.frames) frame(method, params);
  }

  private restart() {
    if (this.disposed || this.recovery.kind === "failed") return;
    this.generation++;
    this.ready = null;
    for (const uri of this.versions.keys()) {
      this.broadcast("textDocument/publishDiagnostics", { uri, diagnostics: [] });
    }
    this.versions.clear();
    const now = Date.now();
    while (this.restarts.length && now - this.restarts[0] >= 5 * 60_000) this.restarts.shift();
    if (this.restarts.length >= 5) {
      this.failRecovery(
        new Error(
          "Language services stopped repeatedly. Automatic restart is paused. Retry language services to try again.",
        ),
      );
      return;
    }
    this.restarts.push(now);
    this.broadcast("mixer/languageServiceState", { state: "restarting" });
    // Queue behind any writes interrupted by the dead process. Replay reads the latest shared buffers.
    const task = this.synchronize();
    this.recovery = { kind: "restarting", task };
    void task.then(
      () => {
        if (this.disposed || this.recovery.kind !== "restarting" || this.recovery.task !== task)
          return;
        this.recovery = { kind: "idle" };
        this.broadcast("mixer/languageServiceState", { state: "ready" });
        return undefined;
      },
      (error: unknown) => {
        if (this.disposed || this.recovery.kind !== "restarting" || this.recovery.task !== task)
          return;
        this.failRecovery(error instanceof Error ? error : new Error(String(error)));
      },
    );
  }

  private failRecovery(error: Error) {
    this.recovery = { kind: "failed", error };
    this.broadcast("mixer/languageServiceState", { state: "failed", message: error.message });
  }

  private async waitForRecovery() {
    while (this.recovery.kind === "restarting") {
      const { task } = this.recovery;
      try {
        await task;
      } catch (error) {
        if (this.recovery.kind === "restarting" && this.recovery.task !== task) continue;
        throw error;
      }
    }
    if (this.recovery.kind === "failed") throw this.recovery.error;
  }

  retry() {
    if (this.disposed || this.recovery.kind === "restarting") return;
    this.restarts.length = 0;
    this.recovery = { kind: "idle" };
    const stopping = this.send("exit", null, true);
    this.syncing = Promise.all([this.syncing.catch(() => undefined), stopping]).then(
      () => undefined,
    );
    this.restart();
  }

  send(method: Method, params: unknown, notification = false, messageId?: string | number) {
    return this.options.client.requestWorkspaceLanguageService({
      workspaceId: this.options.workspaceId,
      language: this.options.language,
      channelId: this.channelId,
      method,
      params,
      notification,
      messageId,
    });
  }

  initialize(): Promise<unknown> {
    if (this.disposed) return Promise.reject(new Error("Language service view closed"));
    if (this.ready) return this.ready;
    const generation = this.generation;
    const task = this.send("initialize", {}).then((result) => {
      this.assertGeneration(generation);
      const roots = z.object({ rootUri: z.string(), workspaceUri: z.string() }).parse(result);
      this.rootUri = roots.rootUri.replace(/\/$/, "") + "/";
      this.workspaceUri = roots.workspaceUri.replace(/\/$/, "") + "/";
      const sync = z
        .object({
          capabilities: z.object({
            textDocumentSync: z
              .union([z.number(), z.object({ change: z.number().optional() })])
              .optional(),
          }),
        })
        .parse(result).capabilities.textDocumentSync;
      this.incrementalSync = (typeof sync === "number" ? sync : sync?.change) === 2;
      return result;
    });
    if (generation === this.generation) this.ready = task;
    void task.catch(() => {
      if (this.ready === task) this.ready = null;
    });
    return task;
  }

  path(uri: string): string {
    const mapped = uri.startsWith(this.rootUri)
      ? this.workspaceUri + uri.slice(this.rootUri.length)
      : uri;
    const parsed = new URL(mapped);
    if (parsed.protocol !== "file:" || parsed.host)
      throw new Error("Workspace edits require a local workspace file URI");
    let path = decodeURIComponent(parsed.pathname);
    if (/^\/[A-Za-z]:\//.test(path)) path = path.slice(1);
    return path;
  }

  uri(path: string): string {
    const value = fileUri(path);
    return value.startsWith(this.workspaceUri)
      ? this.rootUri + value.slice(this.workspaceUri.length)
      : value;
  }

  synchronize(): Promise<void> {
    const task = this.syncing.then(() => this.synchronizeNow());
    this.syncing = task.catch(() => undefined);
    return task;
  }

  private async synchronizeNow() {
    if (this.disposed) return;
    if (this.recovery.kind === "failed") throw this.recovery.error;
    const generation = this.generation;
    await this.initialize();
    this.assertGeneration(generation);
    const active = new Set<string>();
    for (const document of this.options.documents.entries()) {
      const selected = document.languageMode ?? document.detectedLanguage;
      const languageId = selected
        ? languageServiceId(selected)
        : languageForDocument(document.path, this.provider.documents);
      if (!languageId || !this.provider.documents.some((item) => item.languageId === languageId))
        continue;
      const snapshot = document.model.getSnapshot();
      if (snapshot.status === "loading" || snapshot.status === "failed") continue;
      const uri = this.uri(document.path);
      active.add(uri);
      let previous = this.versions.get(uri);
      if (previous?.version === snapshot.version && previous.languageId === languageId) continue;
      if (previous && previous.languageId !== languageId) {
        await this.send("textDocument/didClose", { textDocument: { uri } }, true);
        previous = undefined;
      }
      if (previous === undefined) {
        await this.send(
          "textDocument/didOpen",
          { textDocument: { uri, version: snapshot.version, languageId, text: snapshot.content } },
          true,
        );
      } else
        await this.send(
          "textDocument/didChange",
          {
            textDocument: { uri, version: snapshot.version },
            contentChanges: [
              this.incrementalSync
                ? incrementalDocumentChange(previous.content, snapshot.content)
                : { text: snapshot.content },
            ],
          },
          true,
        );
      this.assertGeneration(generation);
      this.versions.set(uri, { version: snapshot.version, content: snapshot.content, languageId });
    }
    for (const uri of this.versions.keys())
      if (!active.has(uri)) {
        await this.send("textDocument/didClose", { textDocument: { uri } }, true);
        this.assertGeneration(generation);
        this.versions.delete(uri);
      }
  }

  private assertGeneration(generation: number) {
    if (this.disposed) throw new Error("Language service view closed");
    if (generation !== this.generation)
      throw new Error("Language services restarted during synchronization.");
  }

  async request(method: Method, params: unknown, id: string | number) {
    const generation = this.generation;
    try {
      await this.waitForRecovery();
      return await this.requestNow(method, params, id);
    } catch (error) {
      // Only replay reads. Commands and file moves may have taken effect before a crash.
      const readOnly = method === "initialize" || method.startsWith("textDocument/");
      if (this.disposed || generation === this.generation || !readOnly) throw error;
      await this.waitForRecovery();
      return this.requestNow(method, params, id);
    }
  }

  private async requestNow(method: Method, params: unknown, id: string | number) {
    if (this.disposed) throw new Error("Language service view closed");
    if (method === "initialize") return this.initialize();
    await this.queue;
    await this.synchronize();
    if (this.disposed) throw new Error("Language service view closed");
    if (method === "workspace/readFile") {
      const { uri } = z.object({ uri: z.string() }).parse(params);
      const document = this.options.documents.document(this.path(uri));
      await document.ready();
      return { content: document.model.getSnapshot().content };
    }
    return this.send(method, params, false, id);
  }

  dispose() {
    this.disposed = true;
    this.generation++;
    this.unsubscribe();
    this.unwatch();
    this.unbind();
    if (this.options.client.isConnected) void this.send("exit", null, true).catch(() => undefined);
  }
}

function leaseLanguage(options: ConstructorParameters<typeof SharedLanguageSession>[0]) {
  const { documents, language } = options;
  const key = `${options.workspaceId}:${language}:${options.provider?.revision ?? ""}`;
  let languages = sessions.get(documents);
  if (!languages) {
    languages = new Map();
    sessions.set(documents, languages);
  }
  let session = languages.get(key);
  if (!session) {
    session = new SharedLanguageSession(options);
    languages.set(key, session);
  }
  const shared = session;
  const lease = () => {};
  shared.frames.add(lease);
  let released = false;
  return {
    session: shared,
    release() {
      if (released) return;
      released = true;
      shared.frames.delete(lease);
      if (shared.frames.size === 0 && languages.get(key) === shared) {
        shared.dispose();
        languages.delete(key);
      }
    },
  };
}

export function connectLanguagePort(options: BridgeOptions): () => void {
  const { port, documents } = options;
  const lease = leaseLanguage(options);
  const shared = lease.session;
  if (options.restart) shared.retry();
  let disposed = false;
  const baselines = new Map<string, Map<string, number>>();
  const baseline = () =>
    new Map(
      [...documents.entries()].map((document) => [
        document.path,
        document.model.getSnapshot().version,
      ]),
    );
  function remember(value: unknown, versions: Map<string, number>) {
    const edit = workspaceEditSchema.safeParse(value);
    if (edit.success && (edit.data.changes || edit.data.documentChanges)) {
      if (baselines.size >= 128) baselines.clear();
      baselines.set(JSON.stringify(edit.data), versions);
    }
    const command = z
      .object({ command: z.string(), arguments: z.array(z.unknown()).optional() })
      .safeParse(value);
    if (command.success) baselines.set(commandKey(command.data), versions);
    if (Array.isArray(value)) for (const item of value) remember(item, versions);
    else {
      const action = z.object({ edit: z.unknown() }).safeParse(value);
      if (action.success && action.data.edit) remember(action.data.edit, versions);
      const nestedCommand = z.object({ command: z.unknown() }).safeParse(value);
      if (
        nestedCommand.success &&
        typeof nestedCommand.data.command === "object" &&
        nestedCommand.data.command
      )
        remember(nestedCommand.data.command, versions);
    }
  }
  const notify = (method: string, params: unknown) => {
    if (!disposed) port.postMessage({ jsonrpc: "2.0", method, params });
  };
  shared.frames.add(notify);
  function validateBaseline(versions: Map<string, number> | undefined) {
    if (!versions) throw new Error("This refactor expired. Request it again.");
    for (const [path, version] of versions) {
      if (documents.find(path)?.model.getSnapshot().version !== version)
        throw new Error("A workspace buffer changed. Request the refactor again.");
    }
  }
  async function reviewRequest(message: z.infer<typeof rpc>): Promise<boolean> {
    if (options.client.getLastServerInfoMessage()?.features?.workspaceRefactoring !== true)
      throw new Error("Update the workspace host to use reviewed refactors and edit commands.");
    if (message.method === "mixer/execute") {
      const action = z
        .object({
          label: z.string(),
          command: z.object({
            title: z.string(),
            command: z.string(),
            arguments: z.array(z.unknown()).optional(),
          }),
        })
        .parse(message.params);
      const versions = baselines.get(commandKey(action.command));
      validateBaseline(versions);
      const response = z
        .object({ edit: workspaceEditSchema })
        .parse(
          await shared.request(
            "workspace/executeCommand",
            { command: action.command.command, arguments: action.command.arguments ?? [] },
            `${options.channelId}:${message.id}`,
          ),
        );
      validateBaseline(versions);
      return options.onReview({
        label: action.label,
        edits: editInputs(response.edit, (uri) => shared.path(uri)),
      });
    }
    const review = z.object({ label: z.string(), edit: workspaceEditSchema }).parse(message.params);
    validateBaseline(baselines.get(JSON.stringify(review.edit)));
    return options.onReview({
      label: review.label,
      edits: editInputs(review.edit, (uri) => shared.path(uri)),
    });
  }
  const receive = (event: MessageEvent<unknown>) => {
    const parsed = rpc.safeParse(event.data);
    if (!parsed.success || disposed) return;
    const message = parsed.data;
    void (async () => {
      try {
        let result: unknown;
        if (message.method === "mixer/reviewEdit" || message.method === "mixer/execute") {
          result = await reviewRequest(message);
        } else {
          const method = WorkspaceLanguageRequestSchema.shape.method.parse(message.method);
          if (message.id === undefined) {
            if (method === "$/cancelRequest") {
              const { id } = z
                .object({ id: z.union([z.string(), z.number()]) })
                .parse(message.params);
              await shared.send(method, { id: `${options.channelId}:${id}` }, true);
            }
            // Monaco frames report local model versions. Only the shared store synchronizes LSP text.
            if (method === "textDocument/didOpen") {
              textDocument.parse(message.params);
              await shared.synchronize();
              options.onReady();
            }
            return;
          }
          const versions = baseline();
          result = await shared.request(
            method,
            message.params ?? null,
            `${options.channelId}:${message.id}`,
          );
          remember(result, versions);
        }
        if (!disposed && message.id !== undefined)
          port.postMessage({ jsonrpc: "2.0", id: message.id, result: result ?? null });
      } catch (error) {
        const text = error instanceof Error ? error.message : String(error);
        if (!disposed && message.id !== undefined)
          port.postMessage({
            jsonrpc: "2.0",
            id: message.id,
            error: { code: -32801, message: text },
          });
        else if (!disposed) options.onError(text);
      }
    })();
  };
  port.addEventListener("message", receive);
  port.start();
  return () => {
    disposed = true;
    baselines.clear();
    port.removeEventListener("message", receive);
    port.close();
    shared.frames.delete(notify);
    lease.release();
  };
}

export async function reviewFileMove(input: {
  client: DaemonClient;
  workspaceId: string;
  document: SharedFileDocument;
  destination: string;
  onReview(edit: ReviewEdit): Promise<boolean>;
  onMoved(from: string, to: string): void;
}) {
  const { document } = input;
  const store = document.store;
  const resolved = resolveWorkspaceFilePaths({
    path: input.destination,
    workspaceRoot: store.root,
  });
  if (!resolved?.relativePath || resolved.absolutePath === document.path)
    throw new Error("Choose a different file path inside this workspace.");
  const provider = providerForDocument(document.path, await readLanguageProviders(input.client));
  if (!provider) throw new Error("This file has no registered language server for import updates.");
  const language = provider.id;
  const sessionOptions = {
    client: input.client,
    workspaceId: input.workspaceId,
    documents: store,
    language,
    provider,
  } satisfies ConstructorParameters<typeof SharedLanguageSession>[0];
  const operation = leaseLanguage(sessionOptions);
  const session = operation.session;
  try {
    await document.ready();
    const initialized = z
      .object({
        capabilities: z.object({
          workspace: z
            .object({ fileOperations: z.object({ willRename: z.unknown().optional() }).optional() })
            .optional(),
        }),
      })
      .parse(await session.initialize());
    if (!initialized.capabilities.workspace?.fileOperations?.willRename)
      throw new Error(
        "This language server does not support import updates for file moves. No file was moved.",
      );
    const before = new Map(
      [...store.entries()].map((item) => [item.path, item.model.getSnapshot().version]),
    );
    const files = [
      { oldUri: session.uri(document.path), newUri: session.uri(resolved.absolutePath) },
    ];
    const edit = workspaceEditSchema.parse(
      (await session.request("workspace/willRenameFiles", { files }, crypto.randomUUID())) ?? {},
    );
    for (const [path, version] of before)
      if (store.find(path)?.model.getSnapshot().version !== version)
        throw new Error("A buffer changed while preparing the move. Try again.");
    return await input.onReview({
      label: "Move file and update imports",
      edits: editInputs(edit, (uri) => session.path(uri)),
      move: {
        document,
        from: document.path,
        to: resolved.absolutePath,
        onMoved: input.onMoved,
        async perform(from, to, version) {
          if (!version.revision)
            throw new Error("The host did not provide a file revision for this move.");
          const relocation = leaseLanguage(sessionOptions);
          const current = relocation.session;
          try {
            await current.initialize();
            const result = z
              .object({ size: z.number(), modifiedAt: z.string(), revision: z.string() })
              .parse(
                await current.request(
                  "workspace/moveFile",
                  {
                    oldUri: current.uri(from),
                    newUri: current.uri(to),
                    expectedRevision: version.revision,
                  },
                  crypto.randomUUID(),
                ),
              );
            // Reopening the moved shared buffer also updates servers that do not implement didRenameFiles.
            void current
              .send(
                "workspace/didRenameFiles",
                { files: [{ oldUri: current.uri(from), newUri: current.uri(to) }] },
                true,
              )
              .catch(() => undefined);
            return result;
          } finally {
            relocation.release();
          }
        },
      },
    });
  } finally {
    operation.release();
  }
}
