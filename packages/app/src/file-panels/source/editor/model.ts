import {
  PluginFileConflictError,
  PluginFileDeletedError,
  type PluginFile,
  type PluginFileEvent,
} from "@mixer/plugin/client";
import type { FileDraft, FileRecovery } from "./persistence";

export type FileEditorStatus =
  | "loading"
  | "failed"
  | "clean"
  | "dirty"
  | "saving"
  | "conflict"
  | "error";
export type FileLineSeparator = "\n" | "\r\n" | "\r";

export interface FileEditorSnapshot {
  recovered: boolean;
  recoveryError: string | null;
  version: number;
  status: FileEditorStatus;
  content: string;
  lineSeparator: FileLineSeparator;
  /** The buffer differs from what this editor last read or saved. */
  modified: boolean;
  /** Why the editor is in conflict: the file changed or was deleted on disk. */
  conflict: "changed" | "deleted" | null;
  /** The failed load's or save's message. */
  error: string | null;
}

export type FileConflictCallout = { kind: "changed"; canOverwrite: boolean } | { kind: "deleted" };

export interface FileEditorClock {
  setTimeout(callback: () => void, delayMs: number): ReturnType<typeof setTimeout>;
  clearTimeout(handle: ReturnType<typeof setTimeout>): void;
}

const systemClock: FileEditorClock = {
  setTimeout(callback, delay) {
    return globalThis.setTimeout(callback, delay);
  },
  clearTimeout(handle) {
    globalThis.clearTimeout(handle);
  },
};

const AUTOSAVE_DELAY_MS = 800;

/**
 * Source's buffer over a `PluginFile`: reads the file, autosaves edits, and reconciles changes on
 * disk. A clean buffer follows the disk; a modified one conflicts and the user overwrites or
 * reloads. The file handle rejects writes over versions this editor has not read.
 */
export class FileEditorModel {
  private readonly file: Pick<PluginFile, "readText" | "writeText" | "watch">;
  private readonly clock: FileEditorClock;
  private readonly listeners = new Set<() => void>();
  private snapshot: FileEditorSnapshot = {
    recovered: false,
    recoveryError: null,
    version: 0,
    status: "loading",
    content: "",
    lineSeparator: "\n",
    modified: false,
    conflict: null,
    error: null,
  };
  private persisted = "";
  private autosave: ReturnType<typeof setTimeout> | null = null;
  private saving = false;
  private saveSequence = 0;
  private readSequence = 0;
  private eventDuringSave: PluginFileEvent | null = null;
  private unwatch: (() => void) | null = null;
  private disposed = false;
  private saveHolds = 0;
  private activeSave: Promise<void> | null = null;
  private readonly contentListeners = new Set<(change: FileEditorContentChange) => void>();
  private readonly recovery: FileRecovery | undefined;
  private recoveryRead: Promise<FileDraft | null> | null = null;
  private recoveryLoadError: string | null = null;

  constructor(input: {
    file: Pick<PluginFile, "readText" | "writeText" | "watch">;
    clock?: FileEditorClock;
    recovery?: FileRecovery;
  }) {
    this.file = input.file;
    this.clock = input.clock ?? systemClock;
    this.recovery = input.recovery;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): FileEditorSnapshot => this.snapshot;

  subscribeContent(listener: (change: FileEditorContentChange) => void): () => void {
    this.contentListeners.add(listener);
    return () => this.contentListeners.delete(listener);
  }

  editIfVersion(content: string, version: number): boolean {
    if (version !== this.snapshot.version) return false;
    this.edit(content);
    return true;
  }

  holdAutosave(): () => void {
    this.saveHolds += 1;
    this.clearAutosave();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.saveHolds -= 1;
      if (this.saveHolds === 0 && this.snapshot.status === "dirty") this.scheduleAutosave();
    };
  }

  async whenIdle(): Promise<void> {
    await this.activeSave;
  }

  async revert(): Promise<void> {
    const release = this.holdAutosave();
    try {
      await this.whenIdle();
      await this.reload();
    } finally {
      release();
    }
  }

  /** Reads the file and follows its changes on disk. */
  open(): void {
    if (this.disposed || this.unwatch) return;
    this.unwatch = this.file.watch((event) => this.receiveFileEvent(event));
    void this.reload();
  }

  pauseObservation(): () => void {
    this.unwatch?.();
    this.unwatch = null;
    return () => {
      if (!this.disposed && !this.unwatch)
        this.unwatch = this.file.watch((event) => this.receiveFileEvent(event));
    };
  }

  edit(content: string): void {
    if (this.disposed || !this.isLoaded() || content === this.snapshot.content) return;
    const modified = content !== this.persisted;
    let status: FileEditorStatus = modified ? "dirty" : "clean";
    if (this.snapshot.status === "conflict") status = "conflict";
    this.setSnapshot(
      {
        ...this.snapshot,
        status,
        content,
        modified,
        recovered: this.snapshot.recovered && modified,
        error: null,
      },
      "edit",
    );
    if (status === "dirty") this.scheduleAutosave();
    else this.clearAutosave();
  }

  async save(): Promise<void> {
    if (this.activeSave) await this.activeSave;
    if (this.saveHolds > 0) return;
    if (this.snapshot.status !== "dirty" && this.snapshot.status !== "error") return;
    await this.runWrite(false);
  }

  /** Writes the buffer over a file that changed on disk. */
  async overwrite(): Promise<void> {
    if (this.activeSave) await this.activeSave;
    if (this.saveHolds > 0) return;
    if (this.snapshot.conflict !== "changed") return;
    await this.runWrite(true);
  }

  /** Replaces the buffer with the file on disk. */
  async reload(): Promise<void> {
    if (this.disposed) return;
    const sequence = ++this.readSequence;
    const version = this.snapshot.version;
    try {
      const [content, recovery] = await Promise.all([this.file.readText(), this.readRecovery()]);
      if (this.disposed || sequence !== this.readSequence) return;
      if (this.isLoaded() && this.snapshot.version !== version) {
        if (content !== this.persisted) this.enterConflict("changed");
        return;
      }
      this.applyFile(content, recovery.draft, recovery.error);
    } catch (error) {
      if (this.disposed || sequence !== this.readSequence) return;
      if (this.isLoaded()) return;
      this.setSnapshot({ ...this.snapshot, status: "failed", error: errorMessage(error) });
    }
  }

  private async readRecovery() {
    if (this.isLoaded() || !this.recovery)
      return { draft: null, error: this.snapshot.recoveryError };
    this.recoveryRead ??= this.recovery.load();
    let draft: FileDraft | null = null;
    try {
      draft = await this.recoveryRead;
      this.recoveryLoadError = null;
    } catch (error) {
      this.recoveryLoadError = `Could not read saved drafts: ${errorMessage(error)}`;
    }
    return { draft, error: this.recoveryLoadError };
  }

  async backup(): Promise<void> {
    if (!this.recovery || !this.isLoaded()) return;
    const snapshot = this.snapshot;
    const draft: FileDraft | null = snapshot.modified
      ? { base: this.persisted, content: snapshot.content, lineSeparator: snapshot.lineSeparator }
      : null;
    try {
      await this.recovery.checkpoint(draft);
      if (!this.disposed && this.snapshot.recoveryError !== this.recoveryLoadError)
        this.setSnapshot({ ...this.snapshot, recoveryError: this.recoveryLoadError });
    } catch (error) {
      if (!this.disposed)
        this.setSnapshot({ ...this.snapshot, recoveryError: errorMessage(error) });
    }
  }

  async retryBackup(): Promise<void> {
    if (this.recoveryLoadError && !this.snapshot.modified) {
      this.recoveryRead = null;
      this.recoveryLoadError = null;
      this.setSnapshot({ ...this.snapshot, status: "loading" });
      await this.reload();
    } else await this.backup();
  }

  /**
   * Stops following the file. With `flush`, a modified buffer is written first, so switching to
   * another panel keeps the edit. The tab holds that write while it asks to discard it.
   */
  dispose({ flush }: { flush: boolean }): void {
    if (this.disposed) return;
    const status = this.snapshot.status;
    if (flush && this.snapshot.modified && status !== "conflict") {
      void this.file.writeText(this.snapshot.content).catch(() => undefined);
    }
    this.disposed = true;
    this.clearAutosave();
    this.unwatch?.();
    this.unwatch = null;
    this.listeners.clear();
    this.contentListeners.clear();
  }

  private receiveFileEvent(event: PluginFileEvent): void {
    if (this.disposed) return;
    if (!this.isLoaded()) {
      if (event.type === "changed") void this.reload();
      return;
    }
    if (this.saving) {
      this.eventDuringSave = event;
      return;
    }
    if (event.type === "deleted") {
      this.enterConflict("deleted");
      return;
    }
    void this.reconcile();
  }

  /** Follows a clean buffer to the disk; a modified one conflicts unless the disk matches it. */
  private async reconcile(): Promise<void> {
    const sequence = ++this.readSequence;
    let content: string;
    try {
      content = await this.file.readText();
    } catch {
      return;
    }
    if (this.disposed || sequence !== this.readSequence) return;
    if (this.saving) {
      this.eventDuringSave = { type: "changed" };
      return;
    }
    if (content === this.persisted) {
      this.adoptUnchangedFile();
      return;
    }
    if (!this.snapshot.modified) {
      this.applyFile(content);
      return;
    }
    this.enterConflict("changed");
  }

  private runWrite(force: boolean): Promise<void> {
    const content = this.snapshot.content;
    const task = Promise.resolve().then(() => this.write({ force, content }));
    this.activeSave = task;
    this.setSnapshot({
      ...this.snapshot,
      recovered: false,
      status: "saving",
      conflict: null,
      error: null,
    });
    return task.finally(() => {
      if (this.activeSave === task) this.activeSave = null;
    });
  }

  private async write({ force, content }: { force: boolean; content: string }): Promise<void> {
    if (this.disposed) return;
    this.clearAutosave();
    const sequence = ++this.saveSequence;
    this.saving = true;
    this.eventDuringSave = null;
    this.setSnapshot({ ...this.snapshot, status: "saving", conflict: null, error: null });
    try {
      await this.file.writeText(content, { force });
    } catch (error) {
      this.saving = false;
      if (this.disposed || sequence !== this.saveSequence) return;
      if (error instanceof PluginFileConflictError) this.enterConflict("changed");
      else if (error instanceof PluginFileDeletedError) this.enterConflict("deleted");
      else this.setSnapshot({ ...this.snapshot, status: "error", error: errorMessage(error) });
      this.receivePendingEvent();
      return;
    }
    this.saving = false;
    if (this.disposed || sequence !== this.saveSequence) return;
    this.persisted = content;
    const modified = this.snapshot.content !== this.persisted;
    this.setSnapshot({ ...this.snapshot, status: modified ? "dirty" : "clean", modified });
    void this.backup();
    if (modified) this.scheduleAutosave();
    this.receivePendingEvent();
  }

  private receivePendingEvent(): void {
    const event = this.eventDuringSave;
    this.eventDuringSave = null;
    if (event) this.receiveFileEvent(event);
  }

  private applyFile(
    content: string,
    recovered: FileDraft | null = null,
    recoveryError: string | null = this.snapshot.recoveryError,
  ): void {
    this.clearAutosave();
    this.saveSequence += 1;
    this.persisted = content;
    const restore = recovered !== null && recovered.content !== content;
    const conflict = restore && recovered.base !== content ? "changed" : null;
    let status: FileEditorStatus = "clean";
    if (conflict) status = "conflict";
    else if (restore) status = "dirty";
    this.setSnapshot(
      {
        status,
        content: restore ? recovered.content : content,
        lineSeparator: restore ? recovered.lineSeparator : detectLineSeparator(content),
        modified: restore,
        conflict,
        error: null,
        recovered: restore,
        recoveryError,
      },
      "reload",
    );
  }

  private adoptUnchangedFile(): void {
    if (this.snapshot.status !== "conflict") return;
    if (this.snapshot.recovered) return;
    const status = this.snapshot.modified ? "dirty" : "clean";
    this.setSnapshot({ ...this.snapshot, status, conflict: null, error: null });
    if (status === "dirty") this.scheduleAutosave();
  }

  private enterConflict(conflict: "changed" | "deleted"): void {
    this.clearAutosave();
    this.setSnapshot({ ...this.snapshot, status: "conflict", conflict, error: null });
  }

  private isLoaded(): boolean {
    return this.snapshot.status !== "loading" && this.snapshot.status !== "failed";
  }

  private scheduleAutosave(): void {
    this.clearAutosave();
    if (this.saveHolds > 0 || this.snapshot.recovered) return;
    this.autosave = this.clock.setTimeout(() => {
      this.autosave = null;
      void this.save();
    }, AUTOSAVE_DELAY_MS);
  }

  private clearAutosave(): void {
    if (!this.autosave) return;
    this.clock.clearTimeout(this.autosave);
    this.autosave = null;
  }

  private setSnapshot(
    snapshot: Omit<FileEditorSnapshot, "version">,
    origin?: "edit" | "reload",
  ): void {
    const before = this.snapshot;
    const changed = before.content !== snapshot.content;
    this.snapshot = { ...snapshot, version: before.version + (changed ? 1 : 0) };
    for (const listener of this.listeners) listener();
    if (changed && origin)
      for (const listener of this.contentListeners)
        listener({ before: before.content, after: snapshot.content, origin });
    if (changed || before.modified !== snapshot.modified) void this.backup();
  }
}

export interface FileEditorContentChange {
  before: string;
  after: string;
  origin: "edit" | "reload";
}

export function getFileConflictCallout(snapshot: FileEditorSnapshot): FileConflictCallout | null {
  if (snapshot.status !== "conflict" || !snapshot.conflict) return null;
  if (snapshot.conflict === "deleted") return { kind: "deleted" };
  return { kind: "changed", canOverwrite: snapshot.modified };
}

function detectLineSeparator(content: string): FileLineSeparator {
  for (let index = 0; index < content.length; index += 1) {
    const character = content.charCodeAt(index);
    if (character === 10) return "\n";
    if (character === 13) return content.charCodeAt(index + 1) === 10 ? "\r\n" : "\r";
  }
  return "\n";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
