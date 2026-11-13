import { defineRpc, defineSettings } from "@mixer/plugin";
import { z } from "zod";

export const workflowId = z
  .string()
  .max(512)
  .refine(
    (value) =>
      /\.(?:md|ya?ml)$/i.test(value) &&
      (!value.includes("/") || configurationRootName(value) !== "config.json") &&
      !/[\\:]/.test(value) &&
      Array.from(value).every((character) => character.charCodeAt(0) >= 32) &&
      value.split("/").every((part) => part !== "" && part !== "." && part !== ".."),
    "Expected a workflow path inside Automations",
  );

export const automationFileId = z.union([z.literal("config.json"), workflowId]);
export const automationDirectoryId = z
  .string()
  .max(512)
  .refine(
    (value) =>
      configurationRootName(value) !== "config.json" &&
      !/[\\:]/.test(value) &&
      Array.from(value).every((character) => character.charCodeAt(0) >= 32) &&
      value.split("/").every((part) => part !== "" && part !== "." && part !== ".."),
    "Use a relative folder path without traversal. config.json is reserved for configuration.",
  );

function configurationRootName(value: string) {
  return value
    .split("/")[0]
    .replace(/[. ]+$/, "")
    .toLowerCase();
}

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
  output: z.object({
    workflows: z.array(workflow),
    limited: z.boolean(),
    configuration: z.boolean().default(false),
    directories: z.array(automationDirectoryId).default([]),
  }),
});
export const openRpc = defineRpc({
  name: "automations.workflows.open",
  input: z.object({ path: automationFileId }),
  output: z.object({ workspaceId: z.string(), path: automationFileId }),
});
const workflowSource = z.object({
  path: automationFileId,
  content: z.string().max(1024 * 1024),
  version: z.string().regex(/^[0-9a-f]{64}$/),
});
export const readWorkflowRpc = defineRpc({
  name: "automations.workflows.read",
  input: openRpc.input,
  output: workflowSource,
});
export const saveWorkflowRpc = defineRpc({
  name: "automations.workflows.save",
  input: workflowSource,
  output: workflowSource,
});
export const deleteWorkflowRpc = defineRpc({
  name: "automations.workflows.delete",
  input: workflowSource.pick({ path: true, version: true }),
  output: z.object({ path: automationFileId }),
});
export const setWorkflowEnabledRpc = defineRpc({
  name: "automations.workflows.set-enabled",
  input: workflowSource.pick({ version: true }).extend({ path: workflowId, enabled: z.boolean() }),
  output: workflowSource,
});
export const createRpc = defineRpc({
  name: "automations.workflows.create",
  input: z.object({ path: automationFileId }),
  output: z.object({ path: automationFileId }),
});
export const createDirectoryRpc = defineRpc({
  name: "automations.directories.create",
  input: z.object({ path: automationDirectoryId }),
  output: z.object({ path: automationDirectoryId }),
});
export const moveWorkflowRpc = defineRpc({
  name: "automations.workflows.move",
  input: z.object({
    path: workflowId,
    destination: workflowId,
    version: workflowSource.shape.version,
  }),
  output: workflowSource,
});
export const prepareChatRpc = defineRpc({
  name: "automations.chat.prepare",
  input: z.object({ path: workflowId.optional() }),
  output: z.object({ workspaceId: z.string(), title: z.string(), systemPrompt: z.string() }),
});

export const runId = z.union([z.string().uuid(), z.string().regex(/^rp_[a-f0-9]{12}$/)]);
export const actionName = z.enum(["github.pr.approve", "github.pr.merge"]);
export const safeActionSchema = z.object({
  apiUrl: z.url().optional(),
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
export const runResultSchema = z.object({
  outcome: z.string().max(100).optional(),
  reason: z
    .string()
    .max(128 * 1024)
    .optional(),
  verification: z.array(z.string().max(8192)).max(256).optional(),
  unresolved: z.array(z.string().max(8192)).max(256).optional(),
});
export const runSchema = z.object({
  engine: z
    .object({
      steps: z.array(z.json()),
      actions: z.array(z.json()),
      event: z.json(),
      workspace: z.json().optional(),
      verification: z.array(z.json()),
    })
    .optional(),
  result: runResultSchema.optional(),
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
  status: z.enum([
    "queued",
    "running",
    "succeeded",
    "failed",
    "interrupted",
    "attention",
    "skipped",
  ]),
  createdAt: z.number(),
  finishedAt: z.number().optional(),
  agentId: z.string().optional(),
  error: z.string().optional(),
  action: safeActionSchema.optional(),
  actionError: z.string().optional(),
  actionAttempts: z
    .array(
      z.object({
        id: z.string().uuid(),
        at: z.number(),
        status: z.enum(["requested", "blocked", "applied", "uncertain"]),
        message: z.string().optional(),
      }),
    )
    .default([]),
  output: z.string().default(""),
});
export const startRunRpc = defineRpc({
  name: "automations.runs.start",
  input: z.object({ path: workflowId }),
  output: z.object({ id: runId }),
});
export const replayRunRpc = defineRpc({
  name: "automations.runs.replay",
  input: z.object({ id: runId, workflow: z.enum(["snapshot", "current"]) }),
  output: z.object({ id: runId }),
});
export const cancelRunRpc = defineRpc({
  name: "automations.runs.cancel",
  input: z.object({ id: runId, reason: z.string().trim().min(1).max(1000) }),
  output: z.object({ cancelled: z.boolean() }),
});
export const listRunsRpc = defineRpc({
  name: "automations.runs.list",
  input: z.object({}),
  output: z.object({ runs: z.array(runSchema.omit({ output: true, result: true })) }),
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

export const reconcileActionRpc = defineRpc({
  name: "automations.runs.reconcile-action",
  input: z.object({ id: runId }),
  output: runSchema,
});
export const configurationInfoRpc = defineRpc({
  name: "automations.configuration.info",
  input: z.object({}),
  output: z.object({
    fileConfigured: z.boolean(),
    agentProvider: z.string(),
    error: z.string().optional(),
  }),
});

export const runtimeStatusRpc = defineRpc({
  name: "automations.runtime.status",
  input: z.object({}),
  output: z.object({
    paused: z.boolean(),
    notices: z.array(z.object({ source: z.string(), message: z.string() })).optional(),
    listening: z.boolean(),
    pending: z.number().int().nonnegative(),
    schedulesEnabled: z.boolean(),
    integrations: z.array(
      z.object({
        name: z.string(),
        ready: z.boolean(),
        message: z.string(),
      }),
    ),
    errors: z.array(z.object({ source: z.string(), message: z.string() })),
  }),
});
export const runtimeControlRpc = defineRpc({
  name: "automations.runtime.control",
  input: z.object({ action: z.enum(["start", "stop", "restart"]) }),
  output: runtimeStatusRpc.output,
});
