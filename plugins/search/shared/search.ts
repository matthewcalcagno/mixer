import { defineRpc } from "@mixer/plugin";
import { z } from "zod";

export const optionsSchema = z.object({
  query: z
    .string()
    .min(1)
    .max(1000)
    .refine((value) => !/[\r\n]/.test(value), "Search one line at a time"),
  caseSensitive: z.boolean(),
  wholeWord: z.boolean(),
  regex: z.boolean(),
  includes: z.string().max(2000),
  excludes: z.string().max(2000),
  respectIgnore: z.boolean(),
});
export const matchSchema = z.object({
  line: z.number().int().positive(),
  column: z.number().int().positive(),
  preview: z.string(),
  start: z.number().int().nonnegative(),
  end: z.number().int().nonnegative(),
});
export const resultSchema = z.object({
  status: z.enum(["complete", "cancelled"]),
  files: z.array(z.object({ path: z.string(), matches: z.array(matchSchema) })),
  count: z.number().int().nonnegative(),
  limited: z.boolean(),
  limitReason: z.enum(["results", "output", "timeout"]).nullable(),
  elapsedMs: z.number().nonnegative(),
});
const identitySchema = z.object({
  channelId: z.string().uuid(),
  requestId: z.string().uuid(),
});
export const scopeSchema = z.union([
  z.object({ workspaceId: z.string().min(1) }),
  z.object({ projectId: z.string().min(1) }),
]);
export type SearchScope = z.infer<typeof scopeSchema>;
export function searchScopeKey(scope: SearchScope): string {
  return "projectId" in scope ? `project:${scope.projectId}` : `workspace:${scope.workspaceId}`;
}
export const searchRpc = defineRpc({
  name: "search.text",
  input: identitySchema.extend({ options: optionsSchema }).and(scopeSchema),
  output: resultSchema,
});
export const cancelRpc = defineRpc({
  name: "search.cancel",
  input: identitySchema.and(scopeSchema),
  output: z.object({ cancelled: z.boolean() }),
});
export type SearchOptions = z.infer<typeof optionsSchema>;
export type SearchResult = z.infer<typeof resultSchema>;
export type SearchMatch = z.infer<typeof matchSchema>;

/** Commas inside a brace glob, such as **\/*.{ts,tsx}, are not separators. */
export function splitGlobs(value: string): string[] {
  const patterns: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index <= value.length; index++) {
    if (value[index] === "{") depth++;
    if (value[index] === "}") depth--;
    if (depth < 0) throw new Error("Unbalanced braces in file filters");
    if (index === value.length || (value[index] === "," && depth === 0)) {
      const pattern = value.slice(start, index).trim();
      if (pattern) patterns.push(pattern);
      start = index + 1;
    }
  }
  if (depth !== 0) throw new Error("Unbalanced braces in file filters");
  if (patterns.length > 20) throw new Error("Use at most 20 file patterns per filter");
  return patterns;
}
