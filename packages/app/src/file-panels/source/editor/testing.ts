import type { DraftRecord, EditorStorage, EditorViewState } from "./persistence";

export class InMemoryEditorStorage implements EditorStorage {
  readonly records = new Map<string, DraftRecord>();
  readonly views = new Map<string, EditorViewState>();
  failWrites = false;
  async drafts(fileKey: string) {
    return structuredClone(
      [...this.records.values()].filter((record) => record.fileKey === fileKey),
    );
  }
  async writeDraft(record: DraftRecord) {
    if (this.failWrites) throw new Error("Storage quota exceeded");
    this.records.set(record.id, structuredClone(record));
  }
  async clearDraft(id: string, restored: DraftRecord | null) {
    if (this.failWrites) throw new Error("Storage quota exceeded");
    this.records.delete(id);
    if (!restored) return;
    const current = this.records.get(restored.id);
    if (current && JSON.stringify(current) === JSON.stringify(restored))
      this.records.delete(restored.id);
  }
  async readView(key: string) {
    return structuredClone(this.views.get(key) ?? null);
  }
  async writeView(key: string, state: EditorViewState) {
    this.views.set(key, structuredClone(state));
  }
}
