import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";

const receiptFields = {
  version: z.literal(1),
  id: z.string().uuid(),
  runId: z.string().min(1),
  repository: z.string().min(1),
  number: z.number().int().positive(),
  bodyHash: z.string().regex(/^[a-f0-9]{64}$/),
  createdAt: z.string().datetime(),
};
const receiptSchema = z.discriminatedUnion("status", [
  z.object({ ...receiptFields, status: z.literal("pending") }).strict(),
  z.object({ ...receiptFields, status: z.literal("confirmed"), commentId: z.number().int().positive() }).strict(),
]);

/** Keep receipts after matching: duplicate deliveries and historical replays need the same provenance. */
export function publishedIssueComment(input: {
  stateDirectory: string;
  repository: string;
  number: number;
  body: string;
  commentId?: number;
}): z.infer<typeof receiptSchema> | undefined {
  const marker = /<!-- roboplane:([\w-]+):issue-comment:([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}) -->$/.exec(input.body);
  if (!marker) return undefined;
  const file = path.join(input.stateDirectory, "github-published-comments", `${marker[2]}.json`);
  let value: unknown;
  try { value = JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
  const parsed = receiptSchema.parse(value);
  if (parsed.id !== marker[2] || parsed.runId !== marker[1] || parsed.repository !== input.repository || parsed.number !== input.number ||
      parsed.bodyHash !== createHash("sha256").update(input.body).digest("hex") ||
      (parsed.status === "confirmed" && parsed.commentId !== input.commentId)) return undefined;
  return parsed;
}
