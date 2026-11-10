import { defineRpc } from "@mixer/plugin";
import { z } from "zod";

const workspace = z.union([
  z.object({ workspaceId: z.string().min(1) }),
  z.object({ projectId: z.string().min(1) }),
]);
export type GitScope = z.infer<typeof workspace>;
export function gitScopeKey(scope: GitScope): string {
  return "projectId" in scope ? `project:${scope.projectId}` : scope.workspaceId;
}
export const documentRpc = defineRpc({
  name: "git.document",
  input: workspace.and(z.object({ path: z.string().min(1), staged: z.boolean() })),
  output: z.object({
    original: z.string(),
    modified: z.string(),
    revision: z.string(),
    editable: z.boolean(),
  }),
});
export const saveDocumentRpc = defineRpc({
  name: "git.save",
  input: workspace.and(
    z.object({
      path: z.string().min(1),
      revision: z.string(),
      content: z.string().max(1_000_000),
    }),
  ),
  output: z.object({ revision: z.string() }),
});
export const prepareTrashRpc = defineRpc({
  name: "git.trash.prepare",
  input: workspace.and(
    z.object({ paths: z.array(z.string().min(1)).min(1), revision: z.string() }),
  ),
  output: z.array(z.string()),
});
// Lightweight explorer metadata: never read file contents or generate diffs.
export const decorationsRpc = defineRpc({
  name: "git.decorations",
  input: workspace,
  output: z.array(z.object({ path: z.string(), index: z.string(), worktree: z.string() })),
});
export const statusRpc = defineRpc({
  name: "git.status",
  input: workspace,
  output: z.object({
    branch: z.string(),
    upstream: z.string(),
    ahead: z.number(),
    behind: z.number(),
    revision: z.string(),
    hasRemote: z.boolean(),
    operation: z
      .object({
        kind: z.enum(["merge", "rebase", "cherry-pick", "revert"]),
        id: z.string(),
        message: z.string(),
      })
      .nullable()
      .optional(),
    files: z.array(
      z.object({ path: z.string(), index: z.string(), worktree: z.string(), head: z.string() }),
    ),
  }),
});
export const autoFetchRpc = defineRpc({
  name: "git.autofetch",
  input: workspace,
  output: z.object({ lastFetched: z.number().nullable(), error: z.string().nullable() }),
});
export const diffRpc = defineRpc({
  name: "git.diff",
  input: workspace.and(z.object({ path: z.string().min(1), staged: z.boolean() })),
  output: z.object({ patch: z.string() }),
});
export const actionRpc = defineRpc({
  name: "git.action",
  input: workspace.and(
    z.object({
      revision: z.string(),
      action: z.discriminatedUnion("kind", [
        z.object({
          kind: z.enum(["stage", "unstage", "discard"]),
          paths: z.array(z.string().min(1)).min(1),
        }),
        z.object({ kind: z.literal("commit"), message: z.string().trim().min(1) }),
        z.object({ kind: z.literal("amend"), message: z.string().trim().min(1) }),
        z.object({ kind: z.enum(["fetch", "pull", "push", "sync", "publish", "abort"]) }),
        z.object({ kind: z.literal("continue"), message: z.string().trim().min(1) }),
        z.object({
          kind: z.literal("patch"),
          path: z.string().min(1),
          staged: z.boolean(),
          patch: z.string(),
          hunk: z.number().int().nonnegative(),
          discard: z.boolean(),
        }),
      ]),
    }),
  ),
  output: z.object({
    message: z.string(),
    error: z.object({ message: z.string(), conflict: z.boolean() }).optional(),
  }),
});

export class GitActionError extends Error {
  constructor(
    message: string,
    readonly conflict: boolean,
  ) {
    super(message);
    this.name = "GitActionError";
  }
}
