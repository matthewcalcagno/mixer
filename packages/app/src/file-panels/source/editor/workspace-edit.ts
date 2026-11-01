import { z } from "zod";
import type { DocumentEditInput, WorkspaceFileMove } from "./documents";

const position = z.object({
  line: z.number().int().nonnegative(),
  character: z.number().int().nonnegative(),
});
const textEdit = z.object({
  range: z.object({ start: position, end: position }),
  newText: z.string(),
});
export const workspaceEditSchema = z.object({
  changes: z.record(z.string(), z.array(textEdit)).optional(),
  documentChanges: z
    .array(
      z.object({
        textDocument: z.object({ uri: z.string(), version: z.number().nullable() }),
        edits: z.array(textEdit),
      }),
    )
    .optional(),
});

export interface ReviewEdit {
  label: string;
  edits: DocumentEditInput[];
  move?: WorkspaceFileMove;
}

export function editInputs(
  edit: z.infer<typeof workspaceEditSchema>,
  path: (uri: string) => string,
): DocumentEditInput[] {
  const inputs = Object.entries(edit.changes ?? {}).map(([uri, edits]) => ({
    path: path(uri),
    edits,
  }));
  return [
    ...inputs,
    ...(edit.documentChanges ?? []).map((change) => ({
      path: path(change.textDocument.uri),
      version: change.textDocument.version,
      edits: change.edits,
    })),
  ];
}
