import type { SharedFileDocument } from "./documents";
import type { EditorStorage, EditorViewState } from "./persistence";

const writes = new Map<string, Promise<void>>();

export class EditorViewSession {
  shouldReveal(revision: number, hasSavedState: boolean): boolean {
    if (!hasSavedState) return true;
    return (
      revision > 0 && this.input.document.navigationRevisions.get(this.input.viewId) !== revision
    );
  }
  navigated(revision: number) {
    const current = this.input.document.navigationRevisions.get(this.input.viewId) ?? 0;
    this.input.document.navigationRevisions.set(this.input.viewId, Math.max(current, revision));
  }
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pending: { key: string; state: EditorViewState } | null = null;
  constructor(
    private readonly input: {
      document: SharedFileDocument;
      viewId: string;
      serverId: string;
      storage: EditorStorage | null;
      onError(message: string): void;
    },
  ) {}

  private key() {
    return JSON.stringify([
      this.input.serverId,
      this.input.document.store.root,
      this.input.document.path,
      this.input.viewId,
    ]);
  }

  async load(): Promise<EditorViewState | null> {
    const cached = this.input.document.viewStates.get(this.input.viewId);
    if (cached) return cached;
    const fallback = this.input.document.viewStates.get("last") ?? null;
    if (!this.input.storage) return fallback;
    const state = (await this.input.storage.readView(this.key())) ?? fallback;
    if (state) this.input.document.viewStates.set(this.input.viewId, state);
    return state;
  }

  save(state: EditorViewState): void {
    this.input.document.viewStates.set(this.input.viewId, state);
    this.input.document.viewStates.set("last", state);
    this.pending = { key: this.key(), state };
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), 150);
  }

  flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const pending = this.pending;
    this.pending = null;
    const storage = this.input.storage;
    if (!pending || !storage) return;
    const previous = writes.get(pending.key) ?? Promise.resolve();
    const task = previous
      .catch(() => undefined)
      .then(() => storage.writeView(pending.key, pending.state));
    writes.set(pending.key, task);
    void task
      .catch((error: unknown) =>
        this.input.onError(error instanceof Error ? error.message : String(error)),
      )
      .finally(() => {
        if (writes.get(pending.key) === task) writes.delete(pending.key);
      });
  }
}
