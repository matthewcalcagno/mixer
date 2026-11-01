import type { FileSession, FileContents } from "../../file/handle";
import { FileHandle } from "../../file/handle";
import { FileEditorModel, type FileEditorContentChange } from "./model";
import { resolveFilePreviewReadTarget } from "@/file-explorer/preview-target";
import { resolveWorkspaceFilePaths } from "@/workspace/file-open";
import type { FileRecovery, EditorViewState } from "./persistence";

export interface DocumentTextEdit {
  range: { start: { line: number; character: number }; end: { line: number; character: number } };
  newText: string;
}
export interface DocumentEditInput {
  path: string;
  version?: number | null;
  edits: DocumentTextEdit[];
}
export interface PreparedDocumentEdit {
  document: SharedFileDocument;
  version: number;
  before: string;
  after: string;
}
export interface PreparedWorkspaceEdit {
  label: string;
  changes: PreparedDocumentEdit[];
  move?: WorkspaceFileMove;
}
export interface WorkspaceFileMove {
  document: SharedFileDocument;
  from: string;
  to: string;
  perform(
    from: string,
    to: string,
    version: Pick<FileContents, "size" | "modifiedAt" | "revision">,
  ): Promise<Pick<FileContents, "size" | "modifiedAt" | "revision">>;
  onMoved(from: string, to: string): void;
}
interface HistoryElement {
  label: string;
  changes: PreparedDocumentEdit[];
  timestamp: number;
  actor: string | null;
  move?: WorkspaceFileMove;
}

const MAX_FILE_BYTES = 1024 * 1024;
const MAX_HISTORY_BYTES = 32 * 1024 * 1024;

function historyBytes(changes: PreparedDocumentEdit[]): number {
  return changes.reduce(
    (total, change) => total + (change.before.length + change.after.length) * 2,
    0,
  );
}

function offset(content: string, line: number, character: number): number {
  if (!Number.isInteger(line) || line < 0 || !Number.isInteger(character) || character < 0)
    throw new Error("Invalid edit position");
  let start = 0;
  for (let index = 0; index < line; index += 1) {
    const newline = /\r\n|\r|\n/g;
    newline.lastIndex = start;
    const found = newline.exec(content);
    if (!found) throw new Error("Edit position is beyond the document");
    start = found.index + found[0].length;
  }
  const end = content.slice(start).search(/[\r\n]/);
  const length = end === -1 ? content.length - start : end;
  if (character > length) throw new Error("Edit position is beyond the line");
  return start + character;
}

export function applyDocumentEdits(content: string, edits: DocumentTextEdit[]): string {
  const separator = content.match(/\r\n|\r|\n/)?.[0] ?? "\n";
  const ordered = edits
    .map((edit) => ({
      start: offset(content, edit.range.start.line, edit.range.start.character),
      end: offset(content, edit.range.end.line, edit.range.end.character),
      text: edit.newText.replace(/\r\n|\r|\n/g, separator),
    }))
    .sort((a, b) => a.start - b.start || a.end - b.end);
  let previousEnd = 0;
  let result = "";
  for (const edit of ordered) {
    if (edit.start < previousEnd || edit.end < edit.start)
      throw new Error("Workspace edits overlap");
    result += content.slice(previousEnd, edit.start) + edit.text;
    previousEnd = edit.end;
  }
  return result + content.slice(previousEnd);
}

export class SharedFileDocument {
  languageMode: string | null = null;
  detectedLanguage: string | null = null;
  readonly model: FileEditorModel;
  readonly undo: HistoryElement[] = [];
  readonly redo: HistoryElement[] = [];
  private views = 0;
  private started = false;
  private readonly lifetime = new AbortController();
  private readonly unsubscribe: () => void;
  lastActor: string | null = null;
  readonly viewRevisions = new Map<string, { revision: number; version: number }>();
  readonly rejectedViews = new Set<string>();
  readonly viewStates = new Map<string, EditorViewState>();
  readonly navigationRevisions = new Map<string, number>();

  get hasViews(): boolean {
    return this.views > 0;
  }

  constructor(
    readonly store: WorkspaceDocuments,
    public path: string,
    private handle: FileHandle,
  ) {
    this.model = new FileEditorModel({
      recovery: store.recoveryFor?.(() => this.path),
      file: {
        watch: (listener) => this.handle.file.watch(listener),
        writeText: (content, options) => this.handle.file.writeText(content, options),
        readText: async () => {
          const stat = await this.stat();
          if (stat.size > MAX_FILE_BYTES || stat.kind !== "text")
            throw new Error("Workspace edits support text files up to 1 MiB");
          return this.handle.file.readText();
        },
      },
    });
    this.unsubscribe = this.model.subscribeContent((change) => store.changed(this, change));
  }

  async move(input: WorkspaceFileMove, reverse: boolean): Promise<void> {
    const from = reverse ? input.to : input.from;
    const to = reverse ? input.from : input.to;
    const resolved = resolveWorkspaceFilePaths({ path: to, workspaceRoot: this.store.root });
    if (!resolved?.relativePath) throw new Error("The move destination is outside this workspace");
    const target = resolveFilePreviewReadTarget({
      path: resolved.relativePath,
      workspaceRoot: this.store.root,
    });
    if (!target) throw new Error("Cannot resolve move destination");
    const version = this.handle.readVersion;
    if (!version) throw new Error("Read the source file before moving it");
    const resume = this.model.pauseObservation();
    try {
      const movedVersion = await input.perform(from, to, version);
      const previous = this.handle;
      this.handle = previous.relocated(target, resolved.absolutePath, movedVersion);
      this.path = resolved.absolutePath;
      previous.dispose();
      this.handle.setObserving(true);
      await this.model.backup();
    } finally {
      resume();
    }
  }

  acquire(): () => void {
    this.views += 1;
    this.start();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.views -= 1;
      queueMicrotask(() => this.store.collect(this));
    };
  }

  async ready(): Promise<void> {
    if (this.lifetime.signal.aborted) throw new Error("Document closed");
    this.start();
    const check = () => {
      const state = this.model.getSnapshot();
      if (state.status === "failed") throw new Error(state.error ?? "Cannot read document");
      return state.status !== "loading";
    };
    if (check()) return;
    await new Promise<void>((resolve, reject) => {
      const close = () => {
        stop();
        reject(new Error("Document closed"));
      };
      const cleanup = () => {
        stop();
        this.lifetime.signal.removeEventListener("abort", close);
      };
      const stop = this.model.subscribe(() => {
        try {
          if (check()) {
            cleanup();
            resolve();
          }
        } catch (error) {
          cleanup();
          reject(error);
        }
      });
      this.lifetime.signal.addEventListener("abort", close, { once: true });
    });
  }

  private start() {
    if (this.started) return;
    this.started = true;
    this.handle.setObserving(true);
    this.model.open();
  }

  private async stat(): Promise<
    Extract<ReturnType<FileHandle["getSnapshot"]>, { status: "ready" }>
  > {
    if (this.lifetime.signal.aborted) throw new Error("Document closed");
    const read = () => {
      const value = this.handle.getSnapshot();
      if (value.status === "missing") throw new Error("File not found");
      if (value.status === "error") throw new Error(value.error);
      return value.status === "ready" ? value : null;
    };
    const initial = read();
    if (initial) return initial;
    return new Promise((resolve, reject) => {
      const close = () => {
        stop();
        reject(new Error("Document closed"));
      };
      const stop = this.handle.subscribe(() => {
        try {
          const value = read();
          if (value) {
            stop();
            this.lifetime.signal.removeEventListener("abort", close);
            resolve(value);
          }
        } catch (error) {
          stop();
          this.lifetime.signal.removeEventListener("abort", close);
          reject(error);
        }
      });
      this.lifetime.signal.addEventListener("abort", close, { once: true });
    });
  }

  get canCollect(): boolean {
    return (
      this.views === 0 &&
      this.undo.length === 0 &&
      this.redo.length === 0 &&
      !this.model.getSnapshot().modified
    );
  }
  dispose() {
    this.lifetime.abort();
    this.unsubscribe();
    this.model.dispose({ flush: false });
    this.handle.dispose();
  }
}

/** Host-file identity, buffers and undo groups are shared by every editor view in this workspace. */
export class WorkspaceDocuments {
  private readonly documents = new Map<string, SharedFileDocument>();
  private readonly history: HistoryElement[] = [];
  private applying = false;
  private disposed = false;
  private busy = false;
  private readonly listeners = new Set<(document: SharedFileDocument) => void>();
  private readonly pendingChanges = new Set<SharedFileDocument>();
  constructor(
    readonly root: string,
    private readonly session: FileSession,
    private readonly now = () => Date.now(),
    readonly recoveryFor?: (path: () => string) => FileRecovery,
  ) {}

  document(path: string): SharedFileDocument {
    this.assertOpen();
    const resolved = resolveWorkspaceFilePaths({ path, workspaceRoot: this.root });
    if (!resolved?.relativePath) throw new Error("The document is outside this workspace");
    let document = this.documents.get(resolved.absolutePath);
    if (!document) {
      if (this.documents.size >= 128) {
        for (const retained of this.documents.values()) this.collect(retained);
      }
      if (this.documents.size >= 128) throw new Error("Too many retained editor documents");
      const target = resolveFilePreviewReadTarget({
        path: resolved.relativePath,
        workspaceRoot: this.root,
      });
      if (!target) throw new Error("Cannot resolve document");
      document = new SharedFileDocument(
        this,
        resolved.absolutePath,
        new FileHandle(this.session, target, resolved.absolutePath),
      );
      this.documents.set(resolved.absolutePath, document);
    }
    return document;
  }

  find(path: string) {
    return this.documents.get(path);
  }
  entries() {
    return this.documents.values();
  }
  subscribe(listener: (document: SharedFileDocument) => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  setLanguageMode(document: SharedFileDocument, mode: string | null) {
    this.assertDocument(document);
    if (document.languageMode === mode) return;
    document.languageMode = mode;
    for (const listener of this.listeners) listener(document);
  }

  setDetectedLanguage(document: SharedFileDocument, language: string) {
    this.assertDocument(document);
    if (document.detectedLanguage === language) return;
    document.detectedLanguage = language;
    for (const listener of this.listeners) listener(document);
  }

  edit(document: SharedFileDocument, content: string, baseVersion: number, actor: string): boolean {
    this.assertDocument(document);
    const state = document.model.getSnapshot();
    if (
      this.busy ||
      state.version !== baseVersion ||
      state.status === "loading" ||
      state.status === "failed"
    )
      return false;
    document.lastActor = actor;
    document.model.edit(content);
    return true;
  }

  editFromView(input: {
    document: SharedFileDocument;
    content: string;
    baseVersion: number;
    actor: string;
    revision: number;
  }): boolean {
    const { document, actor, revision } = input;
    this.assertDocument(document);
    if (document.rejectedViews.has(actor)) return false;
    const previous = document.viewRevisions.get(actor);
    if (previous && revision <= previous.revision) return false;
    const version = document.model.getSnapshot().version;
    // Messages from one frame are ordered, but its next keystroke can precede the host acknowledgement.
    // Continue only that frame's accepted chain; another actor, reload or workspace edit breaks it.
    const continuesOwnEdits = document.lastActor === actor && previous?.version === version;
    if (input.baseVersion !== version && !continuesOwnEdits) {
      document.rejectedViews.add(actor);
      return false;
    }
    const accepted = this.edit(document, input.content, version, actor);
    if (!accepted) document.rejectedViews.add(actor);
    if (accepted)
      document.viewRevisions.set(actor, {
        revision,
        version: document.model.getSnapshot().version,
      });
    return accepted;
  }

  changed(document: SharedFileDocument, change: FileEditorContentChange) {
    if (this.applying) {
      this.pendingChanges.add(document);
      return;
    }
    if (change.origin === "reload") this.clearHistory(document);
    else
      this.record({
        label: "Typing",
        changes: [
          {
            document,
            version: document.model.getSnapshot().version,
            before: change.before,
            after: change.after,
          },
        ],
        timestamp: this.now(),
        actor: document.lastActor,
      });
    for (const listener of this.listeners) listener(document);
  }

  async prepare(label: string, input: DocumentEditInput[]): Promise<PreparedWorkspaceEdit> {
    this.assertOpen();
    if (input.length > 64) throw new Error("A workspace edit may affect at most 64 files");
    const grouped = new Map<
      SharedFileDocument,
      { version?: number | null; edits: DocumentTextEdit[] }
    >();
    for (const value of input) {
      const document = this.document(value.path);
      const prior = grouped.get(document);
      if (prior && prior.version !== value.version)
        throw new Error("Conflicting document versions in workspace edit");
      grouped.set(document, {
        version: value.version,
        edits: [...(prior?.edits ?? []), ...value.edits],
      });
    }
    const changes: PreparedDocumentEdit[] = [];
    for (const [document, value] of grouped) {
      await document.ready();
      this.assertDocument(document);
      const snapshot = document.model.getSnapshot();
      if (
        value.version !== undefined &&
        value.version !== null &&
        value.version !== snapshot.version
      )
        throw new Error(`${document.path} changed. Request the refactor again.`);
      const after = applyDocumentEdits(snapshot.content, value.edits);
      if (new TextEncoder().encode(after).byteLength > MAX_FILE_BYTES)
        throw new Error(`${document.path} would exceed the 1 MiB editing limit.`);
      if (after !== snapshot.content)
        changes.push({ document, version: snapshot.version, before: snapshot.content, after });
      if (historyBytes(changes) > MAX_HISTORY_BYTES)
        throw new Error(
          "This workspace edit exceeds the 32 MiB undo limit. Split it into smaller operations.",
        );
    }
    return { label, changes };
  }

  async apply(plan: PreparedWorkspaceEdit): Promise<void> {
    this.assertOpen();
    if (this.busy) throw new Error("Another workspace edit is being applied");
    this.busy = true;
    const releases = plan.changes.map(({ document }) => document.model.holdAutosave());
    try {
      await Promise.all(plan.changes.map(({ document }) => document.model.whenIdle()));
      for (const change of plan.changes) {
        this.assertDocument(change.document);
        const current = change.document.model.getSnapshot();
        if (current.version !== change.version || current.content !== change.before)
          throw new Error(`${change.document.path} changed during review. No edits were applied.`);
        if (current.conflict || current.status === "error")
          throw new Error(
            `Resolve the save conflict in ${change.document.path} before applying workspace edits.`,
          );
      }
      if (plan.move) await this.move(plan.move, false);
      try {
        this.validateChanges(plan.changes);
      } catch (error) {
        if (plan.move) await this.move(plan.move, true);
        throw error;
      }
      this.replace(plan.changes, "after");
      this.record({
        label: plan.label,
        changes: plan.changes,
        timestamp: this.now(),
        actor: null,
        move: plan.move,
      });
      this.publishChanges();
    } finally {
      this.busy = false;
      for (const release of releases) release();
    }
  }

  async undo(target: SharedFileDocument, redo = false): Promise<boolean> {
    this.assertDocument(target);
    const element = (redo ? target.redo : target.undo).at(-1);
    if (!element) return false;
    if (this.busy) throw new Error("Another workspace edit is being applied");
    const side = redo ? "before" : "after";
    for (const change of element.changes) {
      const stack = redo ? change.document.redo : change.document.undo;
      if (stack.at(-1) !== element || change.document.model.getSnapshot().content !== change[side])
        throw new Error(
          "Undo the newer edits in the affected files before undoing this workspace edit.",
        );
    }
    const plan = {
      label: element.label,
      changes: element.changes.map((change) => ({
        document: change.document,
        version: change.document.model.getSnapshot().version,
        before: change[side],
        after: redo ? change.after : change.before,
      })),
    };
    const releases = plan.changes.map(({ document }) => document.model.holdAutosave());
    this.busy = true;
    try {
      await Promise.all(plan.changes.map(({ document }) => document.model.whenIdle()));
      for (const change of plan.changes) {
        this.assertDocument(change.document);
        const current = change.document.model.getSnapshot();
        const stack = redo ? change.document.redo : change.document.undo;
        if (
          current.version !== change.version ||
          current.conflict ||
          current.status === "error" ||
          stack.at(-1) !== element
        )
          throw new Error("A document changed while preparing undo. No edits were applied.");
      }
      if (element.move) await this.move(element.move, !redo);
      try {
        this.validateChanges(plan.changes);
      } catch (error) {
        if (element.move) await this.move(element.move, redo);
        throw error;
      }
      this.replace(plan.changes, "after");
      this.transferHistory(element, redo);
      element.actor = null;
      this.publishChanges();
      return true;
    } finally {
      this.busy = false;
      for (const release of releases) release();
    }
  }

  private transferHistory(element: HistoryElement, redo: boolean) {
    for (const change of element.changes) {
      (redo ? change.document.redo : change.document.undo).pop();
      (redo ? change.document.undo : change.document.redo).push(element);
    }
  }

  private validateChanges(changes: PreparedDocumentEdit[]) {
    for (const change of changes) {
      this.assertDocument(change.document);
      const current = change.document.model.getSnapshot();
      if (
        current.version !== change.version ||
        current.content !== change.before ||
        current.conflict ||
        current.status === "error"
      )
        throw new Error(
          `${change.document.path} changed during review. No text edits were applied.`,
        );
    }
  }

  private async move(input: WorkspaceFileMove, reverse: boolean) {
    const from = reverse ? input.to : input.from;
    const to = reverse ? input.from : input.to;
    const existing = this.find(to);
    if (existing && existing !== input.document)
      throw new Error(
        "The move destination already has an editor buffer. Close it before moving the file.",
      );
    await input.document.move(input, reverse);
    this.documents.delete(from);
    this.documents.set(to, input.document);
    input.onMoved(from, to);
  }

  private replace(changes: PreparedDocumentEdit[], side: "before" | "after") {
    this.applying = true;
    try {
      for (const change of changes) {
        change.document.lastActor = null;
        change.document.model.edit(change[side]);
      }
    } finally {
      this.applying = false;
    }
  }

  private publishChanges() {
    const changed = [...this.pendingChanges];
    this.pendingChanges.clear();
    for (const document of changed) for (const listener of this.listeners) listener(document);
  }

  private record(element: HistoryElement) {
    if (element.changes.length === 0) return;
    for (const { document } of element.changes) {
      let old = document.redo.at(-1);
      while (old) {
        this.remove(old);
        old = document.redo.at(-1);
      }
    }
    const previous =
      element.changes.length === 1 ? element.changes[0]?.document.undo.at(-1) : undefined;
    if (
      element.actor &&
      previous?.actor === element.actor &&
      previous.changes.length === 1 &&
      element.timestamp - previous.timestamp < 700
    ) {
      const change = previous.changes[0];
      if (change && change.after === element.changes[0]?.before) {
        change.after = element.changes[0].after;
        previous.timestamp = element.timestamp;
        this.trimHistory();
        return;
      }
    }
    this.history.push(element);
    for (const { document } of element.changes) document.undo.push(element);
    this.trimHistory();
  }
  private trimHistory() {
    let bytes = this.history.reduce((total, element) => total + historyBytes(element.changes), 0);
    while (this.history.length > 100 || bytes > MAX_HISTORY_BYTES) {
      const oldest = this.history[0];
      if (!oldest) break;
      bytes -= historyBytes(oldest.changes);
      this.remove(oldest);
    }
  }
  private remove(element: HistoryElement) {
    const index = this.history.indexOf(element);
    if (index >= 0) this.history.splice(index, 1);
    for (const { document } of element.changes) {
      for (const stack of [document.undo, document.redo]) {
        const at = stack.indexOf(element);
        if (at >= 0) stack.splice(at, 1);
      }
    }
  }
  private clearHistory(document: SharedFileDocument) {
    for (const element of [...document.undo, ...document.redo]) this.remove(element);
    document.lastActor = null;
  }
  collect(document: SharedFileDocument) {
    if (this.busy) return;
    if (this.documents.get(document.path) === document && document.canCollect) {
      this.documents.delete(document.path);
      document.dispose();
    }
  }
  private assertOpen() {
    if (this.disposed) throw new Error("Workspace documents closed");
  }
  private assertDocument(document: SharedFileDocument) {
    this.assertOpen();
    if (this.documents.get(document.path) !== document)
      throw new Error("Document closed or belongs to another workspace");
  }
  dispose() {
    this.disposed = true;
    for (const document of this.documents.values()) document.dispose();
    this.documents.clear();
    this.history.length = 0;
    this.listeners.clear();
  }
}
