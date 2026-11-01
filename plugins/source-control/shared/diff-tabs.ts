import { z } from "zod";

export const diffTargetSchema = z.object({ path: z.string().min(1), staged: z.boolean() });
export const diffTabSchema = z.object({
  id: z.string().min(1),
  workspaceId: z.string().min(1),
  selection: diffTargetSchema,
  pinned: z.boolean(),
});
export type DiffTab = z.infer<typeof diffTabSchema>;
