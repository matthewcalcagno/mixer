import { defineRpc, defineSettings } from "@mixer/plugin";
import { z } from "zod";

export const workflowId = z
  .string()
  .max(512)
  .refine(
    (value) =>
      /\.(?:md|ya?ml)$/i.test(value) &&
      !/[\\:]/.test(value) &&
      Array.from(value).every((character) => character.charCodeAt(0) >= 32) &&
      value.split("/").every((part) => part !== "" && part !== "." && part !== ".."),
    "Expected a workflow path inside Automations",
  );

const envName = z
  .string()
  .regex(/^(?:[A-Za-z_][A-Za-z0-9_]{0,127})?$/)
  .default("");
export const integrationSettings = z
  .object({
    webhookPort: z.number().int().min(0).max(65535).default(0),
    webhookSecretEnv: envName,
    githubSecretEnv: envName,
    githubTokenEnv: envName,
    githubActionTokenEnv: envName,
    jiraBaseUrl: z.string().trim().max(2048).default(""),
    jiraTokenEnv: envName,
  })
  .default(() => ({
    webhookPort: 0,
    webhookSecretEnv: "",
    githubSecretEnv: "",
    githubTokenEnv: "",
    githubActionTokenEnv: "",
    jiraBaseUrl: "",
    jiraTokenEnv: "",
  }));

export const automationSettings = defineSettings({
  id: "preferences",
  scope: "host",
  version: 1,
  schema: z.object({
    agentProvider: z.string().trim().max(200).default(""),
    retentionDays: z.number().int().min(1).max(365).default(7),
    integrations: integrationSettings,
    schedulesEnabled: z.boolean().default(false),
  }),
});

const workflow = z.object({
  path: workflowId,
  kind: z.enum(["agent", "steps"]),
  name: z.string(),
  disabled: z.boolean(),
  cron: z.string().optional(),
  repositories: z.array(z.string()).default([]),
  triggers: z.array(z.string()).default([]),
  error: z.string().optional(),
});
export const listRpc = defineRpc({
  name: "automations.workflows.list",
  input: z.object({}),
  output: z.object({ workflows: z.array(workflow), limited: z.boolean() }),
});
export const openRpc = defineRpc({
  name: "automations.workflows.open",
  input: z.object({ path: workflowId }),
  output: z.object({ workspaceId: z.string(), path: workflowId }),
});
export const createRpc = defineRpc({
  name: "automations.workflows.create",
  input: z.object({
    kind: z.enum(["agent", "steps"]).default("agent"),
    name: z
      .string()
      .trim()
      .regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/),
  }),
  output: openRpc.output,
});
export const chatRpc = defineRpc({
  name: "automations.chat.open",
  input: z.object({ path: workflowId.optional() }),
  output: z.object({ agentId: z.string() }),
});

export const runId = z.string().uuid();
export const actionName = z.enum(["github.pr.approve", "github.pr.merge"]);
export const safeActionSchema = z.object({
  name: actionName,
  status: z.enum(["proposed", "applying", "applied", "blocked", "uncertain"]),
  repository: z.string(),
  number: z.number().int().positive(),
  sha: z.string().regex(/^[0-9a-f]{40}$/i),
  branch: z.string().min(1),
  baseBranch: z.string().min(1),
  author: z.string().min(1),
  method: z.enum(["merge", "squash", "rebase"]).optional(),
  minimumChecks: z.number().int().min(1).max(100).optional(),
  message: z.string().optional(),
});
export const runSchema = z.object({
  id: runId,
  path: workflowId,
  name: z.string(),
  trigger: z.enum(["manual", "schedule", "github", "jira", "webhook", "imported"]),
  repository: z.string().optional(),
  revision: z.string().optional(),
  importedId: z.string().optional(),
  importedAt: z.number().optional(),
  sourceStatus: z.string().optional(),
  outcome: z.string().optional(),
  scheduledFor: z.number().optional(),
  status: z.enum(["queued", "running", "succeeded", "failed", "interrupted", "attention"]),
  createdAt: z.number(),
  finishedAt: z.number().optional(),
  agentId: z.string().optional(),
  error: z.string().optional(),
  action: safeActionSchema.optional(),
  actionError: z.string().optional(),
  output: z.string().default(""),
});
export const startRunRpc = defineRpc({
  name: "automations.runs.start",
  input: openRpc.input,
  output: z.object({ id: runId }),
});
export const listRunsRpc = defineRpc({
  name: "automations.runs.list",
  input: z.object({}),
  output: z.object({ runs: z.array(runSchema.omit({ output: true })) }),
});
export const getRunRpc = defineRpc({
  name: "automations.runs.get",
  input: z.object({ id: runId }),
  output: runSchema,
});

export const importRpc = defineRpc({
  name: "automations.import.roboplane",
  input: z.object({ home: z.string().trim().min(1).max(4096) }),
  output: z.object({ workflows: z.number(), runs: z.number(), skipped: z.number() }),
});

export const applyActionRpc = defineRpc({
  name: "automations.runs.apply-action",
  input: z.object({ id: runId, action: actionName, sha: safeActionSchema.shape.sha }),
  output: runSchema,
});

export const runtimeStatusRpc = defineRpc({
  name: "automations.runtime.status",
  input: z.object({}),
  output: z.object({
    paused: z.boolean(),
    listening: z.boolean(),
    pending: z.number().int().nonnegative(),
  }),
});
export const runtimeControlRpc = defineRpc({
  name: "automations.runtime.control",
  input: z.object({ action: z.enum(["start", "stop", "restart"]) }),
  output: runtimeStatusRpc.output,
});
