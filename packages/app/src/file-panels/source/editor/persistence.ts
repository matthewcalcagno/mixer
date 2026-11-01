import { z } from "zod";

export function editorPersistenceId(): string {
  // getRandomValues also works on HTTP profiles where randomUUID is unavailable.
  const words = crypto.getRandomValues(new Uint32Array(4));
  return Array.from(words, (word) => word.toString(16).padStart(8, "0")).join("");
}

const position = z.object({
  lineNumber: z.number().int().positive(),
  column: z.number().int().positive(),
});
export const monacoViewStateSchema = z.object({
  cursorState: z
    .array(z.object({ inSelectionMode: z.boolean(), selectionStart: position, position }))
    .max(1000),
  viewState: z.object({
    scrollTop: z.number().optional(),
    scrollTopWithoutViewZones: z.number().optional(),
    scrollLeft: z.number(),
    firstPosition: position,
    firstPositionDeltaTop: z.number(),
  }),
  contributionsState: z.record(z.string(), z.unknown()),
});
export const editorViewStateSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("monaco"), state: monacoViewStateSchema }),
  z.object({
    kind: z.literal("codemirror"),
    length: z.number().int().nonnegative(),
    ranges: z
      .array(
        z.object({ anchor: z.number().int().nonnegative(), head: z.number().int().nonnegative() }),
      )
      .min(1)
      .max(1000),
    mainIndex: z.number().int().nonnegative(),
    scrollTop: z.number().nonnegative(),
    scrollLeft: z.number().nonnegative(),
    folds: z.array(
      z.object({ from: z.number().int().nonnegative(), to: z.number().int().nonnegative() }),
    ),
  }),
]);
export type EditorViewState = z.infer<typeof editorViewStateSchema>;
export const fileDraftSchema = z.object({
  base: z.string().max(1024 * 1024),
  content: z.string().max(8 * 1024 * 1024),
  lineSeparator: z.enum(["\n", "\r\n", "\r"]),
});
export type FileDraft = z.infer<typeof fileDraftSchema>;
export const draftRecordSchema = fileDraftSchema.extend({
  id: z.string(),
  fileKey: z.string(),
  updatedAt: z.number(),
  owner: z.string().optional(),
});
export type DraftRecord = z.infer<typeof draftRecordSchema>;

export interface EditorStorage {
  drafts(fileKey: string): Promise<DraftRecord[]>;
  writeDraft(record: DraftRecord): Promise<void>;
  clearDraft(id: string, restored: DraftRecord | null): Promise<void>;
  readView(key: string): Promise<EditorViewState | null>;
  writeView(key: string, state: EditorViewState): Promise<void>;
}
export interface FileRecovery {
  load(): Promise<FileDraft | null>;
  checkpoint(draft: FileDraft | null): Promise<void>;
}

/** Every model owns a separate record. Resolving one draft must not erase a sibling window's edits. */
export class FileRecoveryJournal implements FileRecovery {
  private readonly id = editorPersistenceId();
  private restored: DraftRecord | null = null;
  private pending: { draft: FileDraft | null } | null = null;
  private writing: Promise<void> | null = null;
  constructor(
    private readonly storage: EditorStorage,
    private readonly key: () => string,
  ) {}

  async load(): Promise<FileDraft | null> {
    const records = await this.storage.drafts(this.key());
    records.sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
    this.restored = records[0] ?? null;
    return this.restored;
  }

  checkpoint(draft: FileDraft | null): Promise<void> {
    this.pending = { draft };
    if (!this.writing) {
      this.writing = this.drain();
    }
    return this.writing;
  }

  private async drain(): Promise<void> {
    await Promise.resolve();
    try {
      while (this.pending) {
        // Keep typing off the storage path. Like VS Code's backup tracker, coalesce content
        // changes independently of autosave; browser shutdown cannot await a final disk save.
        if (this.pending.draft) await new Promise<void>((resolve) => setTimeout(resolve, 100));
        const { draft } = this.pending;
        this.pending = null;
        if (draft)
          await this.storage.writeDraft({
            ...draft,
            id: this.id,
            fileKey: this.key(),
            updatedAt: Date.now(),
          });
        else {
          await this.storage.clearDraft(this.id, this.restored);
          this.restored = null;
        }
      }
    } finally {
      this.writing = null;
    }
  }
}
