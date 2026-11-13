import { createHash } from "node:crypto";
import { z, type Event, type Workflow } from "@mixer/automations-sdk";
import type { GitHubEventData } from "./matcher.js";

export const executionPolicySchema = z.object({
  oncePerHead: z.boolean().default(false),
  currentHeadChecks: z.boolean().default(true),
  readyWhen: z.literal("merge-eligible").optional(),
}).strict();

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(",")}}`;
  return JSON.stringify(value);
}

/** Snapshot work is distinct from comment/review requests, even on an unchanged head. */
export function workReceiptKey(workflow: Workflow | undefined, event: Event): string | undefined {
  if (event.provenance?.kind === "replay" || !workflow || !executionPolicySchema.parse(workflow.extensions?.["github.execution"] ?? {}).oncePerHead
    || !["github.pull-request", "github.check", "github.pr.schedule"].includes(event.type)) return;
  const data = event.data as GitHubEventData;
  if (!event.repository || !data.isPullRequest || !data.number || !data.headSha || !data.baseSha) return;
  const { path: _path, ...definition } = workflow;
  const identity = [definition, event.repository, data.number, data.headSha, data.baseSha];
  return `work:completed:${createHash("sha256").update(stable(identity)).digest("hex")}`;
}
