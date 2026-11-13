import { createHash } from "node:crypto";
import { toJSONSchema, z } from "zod";
import type { AgentHandoff, AgentRole, CommunicationPolicy, JsonValue } from "@mixer/automations-sdk";
import {
  maintainerCommunicationSchema, validateMaintainerCommunication, type CommunicationEvidence,
} from "./communication.js";
import { proposedFilesSchema } from "./proposal.js";

const base = {
  version: z.literal(1).default(1),
};

export const plannerHandoffSchema = z.object({
  ...base,
  role: z.literal("planner"),
  intent: z.enum(["noop", "respond", "review", "change"]),
  summary: z.string().min(1).max(20_000),
  plan: z.string().max(100_000).optional(),
  acceptanceCriteria: z.array(z.string().min(1).max(4_000)).max(50).default([]),
  risk: z.enum(["low", "medium", "high"]).default("medium"),
}).strict().superRefine((value, context) => {
  if (value.intent === "change" && !value.plan) {
    context.addIssue({ code: "custom", path: ["plan"], message: "A change intent requires a plan" });
  }
});

export const implementerHandoffSchema = z.object({
  ...base,
  role: z.literal("implementer"),
  summary: z.string().min(1).max(20_000),
  changed: z.boolean().default(true),
  tests: z.array(z.string().min(1).max(4_000)).max(50).default([]),
  files: proposedFilesSchema,
}).strict().superRefine((value, context) => {
  if (!value.changed && value.files.length) {
    context.addIssue({ code: "custom", path: ["files"], message: "An unchanged implementation cannot propose files" });
  }
});

export const reviewerHandoffSchema = z.object({
  ...base,
  role: z.literal("reviewer"),
  verdict: z.enum(["accept", "revise", "reject"]),
  summary: z.string().min(1).max(20_000),
  findings: z.array(z.object({
    severity: z.enum(["info", "warning", "blocking"]),
    message: z.string().min(1).max(10_000),
  }).strict()).max(100).default([]),
}).strict();

export const operatorHandoffSchema = z.object({
  ...base,
  role: z.literal("operator"),
  outcome: z.enum(["action", "no-action", "escalate"]),
  summary: z.string().min(1).max(20_000),
  communication: maintainerCommunicationSchema,
}).strict();

const schemas = {
  planner: plannerHandoffSchema,
  implementer: implementerHandoffSchema,
  reviewer: reviewerHandoffSchema,
  operator: operatorHandoffSchema,
} as const;

export type ProtocolHandoff =
  | z.infer<typeof plannerHandoffSchema>
  | z.infer<typeof implementerHandoffSchema>
  | z.infer<typeof reviewerHandoffSchema>
  | z.infer<typeof operatorHandoffSchema>;

export function outputSchema(role: AgentRole): Record<string, unknown> {
  return toJSONSchema(schemas[role]) as Record<string, unknown>;
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function jsonValue(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

export function parseHandoff(
  role: AgentRole,
  result: { output?: string; metadata?: JsonValue } | void,
  communication?: { policy: CommunicationPolicy; evidence: CommunicationEvidence },
): ProtocolHandoff {
  const metadata = result?.metadata;
  let candidate: unknown;
  if (metadata && typeof metadata === "object" && !Array.isArray(metadata) && "handoff" in metadata) {
    candidate = (metadata as { handoff?: unknown }).handoff;
  }
  if (candidate === undefined && result?.output) {
    const lines = result.output.split(/\r?\n/).filter((line) => line.startsWith("MIXER_AUTOMATIONS_HANDOFF "));
    if (lines.length > 1) throw new Error(`agent_${role}_handoff_multiple`);
    if (lines.length === 1) {
      try { candidate = JSON.parse(lines[0]!.slice("MIXER_AUTOMATIONS_HANDOFF ".length)); }
      catch { throw new Error(`agent_${role}_handoff_invalid_json`); }
    }
  }
  if (candidate === undefined) throw new Error(`agent_${role}_handoff_missing`);
  const parsed = schemas[role].safeParse(candidate);
  if (!parsed.success) throw new Error(`agent_${role}_handoff_invalid: ${parsed.error.issues[0]?.message ?? "invalid"}`);
  if (role === "operator") {
    if (!communication) throw new Error("agent_operator_communication_context_missing");
    const operator = parsed.data as z.infer<typeof operatorHandoffSchema>;
    return {
      ...operator,
      communication: validateMaintainerCommunication(operator.communication, communication.policy, communication.evidence),
    };
  }
  return parsed.data as ProtocolHandoff;
}

export function recordHandoff(runId: string, role: AgentRole, ordinal: number, payload: ProtocolHandoff): AgentHandoff {
  const value = jsonValue(payload);
  const hash = createHash("sha256").update(stable(value)).digest("hex");
  return { id: `handoff_${hash.slice(0, 16)}`, runId, role, ordinal, payload: value, hash, createdAt: new Date().toISOString() };
}
