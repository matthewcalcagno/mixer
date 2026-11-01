import { z } from "zod";

export const gitObjectIdSchema = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
export const editorGitCommitSchema = z.object({
  sha: gitObjectIdSchema,
  author: z.string(),
  email: z.string(),
  authoredAt: z.number(),
  summary: z.string(),
});
export const editorGitBlameSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("ready"),
    head: gitObjectIdSchema,
    commits: z.array(editorGitCommitSchema),
    lines: z.array(
      z.object({
        line: z.number().int().positive(),
        originalLine: z.number().int().positive(),
        sha: gitObjectIdSchema,
      }),
    ),
  }),
  z.object({
    kind: z.literal("unavailable"),
    reason: z.enum(["not_git", "untracked", "unborn", "too_large"]),
  }),
]);
export const editorGitCommitDetailsSchema = z.object({
  commit: editorGitCommitSchema,
  message: z.string(),
  parents: z.array(gitObjectIdSchema),
  patch: z.string(),
  url: z.string().nullable(),
  pullRequest: z
    .object({
      number: z.number().int().positive(),
      title: z.string(),
      url: z.string(),
      state: z.string(),
    })
    .nullable(),
  pullRequestError: z.string().nullable(),
  authorAvatar: z
    .string()
    .max(180_000)
    .regex(/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/)
    .optional(),
  authorProfileUrl: z.string().url().optional(),
});

export const WorkspaceGitBlameRequestSchema = z.object({
  type: z.literal("workspace.git.blame.request"),
  requestId: z.string(),
  workspaceId: z.string(),
  path: z.string().min(1),
  content: z.string().max(1024 * 1024),
});
export const WorkspaceGitBlameResponseSchema = z.object({
  type: z.literal("workspace.git.blame.response"),
  payload: z.object({
    requestId: z.string(),
    result: editorGitBlameSchema.nullable(),
    error: z.string().optional(),
  }),
});
export const WorkspaceGitCommitRequestSchema = z.object({
  type: z.literal("workspace.git.commit.request"),
  requestId: z.string(),
  workspaceId: z.string(),
  path: z.string().min(1),
  sha: gitObjectIdSchema,
});
export const WorkspaceGitCommitResponseSchema = z.object({
  type: z.literal("workspace.git.commit.response"),
  payload: z.object({
    requestId: z.string(),
    result: editorGitCommitDetailsSchema.nullable(),
    error: z.string().optional(),
  }),
});

export type EditorGitCommit = z.infer<typeof editorGitCommitSchema>;
export type EditorGitBlame = z.infer<typeof editorGitBlameSchema>;
export type EditorGitCommitDetails = z.infer<typeof editorGitCommitDetailsSchema>;
