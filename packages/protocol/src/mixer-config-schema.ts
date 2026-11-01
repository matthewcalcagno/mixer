import { z } from "zod";

const TCP_PORT_RANGE_PATTERN = /^(\d{1,5})-(\d{1,5})$/;

export const MixerServicePortAllocationSchema = z
  .object({
    range: z.string().trim().regex(TCP_PORT_RANGE_PATTERN).optional(),
    portScript: z.string().trim().min(1).optional(),
  })
  .strict()
  .refine(
    (value) => value.range !== undefined || value.portScript !== undefined,
    "Expected range or portScript",
  )
  .refine((value) => {
    if (!value.range) return true;
    const match = TCP_PORT_RANGE_PATTERN.exec(value.range);
    if (!match) return false;
    const start = Number(match[1]);
    const end = Number(match[2]);
    return start >= 1 && end <= 65_535 && start <= end;
  }, "Expected an inclusive TCP port range from 1-65535");

export function normalizeLifecycleCommands(commands: unknown): string[] {
  if (typeof commands === "string") {
    return commands.trim().length > 0 ? [commands] : [];
  }
  if (!Array.isArray(commands)) {
    return [];
  }
  return commands.filter((command): command is string => {
    return typeof command === "string" && command.trim().length > 0;
  });
}

export const MixerLifecycleCommandRawSchema = z.union([z.string(), z.array(z.string())]);

export const MixerScriptEntryRawSchema = z
  .object({
    type: z.unknown().optional(),
    command: z.unknown().optional(),
    port: z.unknown().optional(),
  })
  .passthrough();

export const MixerWorktreeConfigRawSchema = z
  .object({
    setup: MixerLifecycleCommandRawSchema.optional(),
    teardown: MixerLifecycleCommandRawSchema.optional(),
    terminals: z.unknown().optional(),
    servicePorts: MixerServicePortAllocationSchema.optional(),
  })
  .passthrough();

export const MixerMetadataGenerationEntrySchema = z
  .object({
    instructions: z.string().optional(),
  })
  .passthrough()
  .catch({});

export const MixerMetadataGenerationSchema = z
  .object({
    title: MixerMetadataGenerationEntrySchema.optional(),
    branchName: MixerMetadataGenerationEntrySchema.optional(),
    commitMessage: MixerMetadataGenerationEntrySchema.optional(),
    pullRequest: MixerMetadataGenerationEntrySchema.optional(),
  })
  // COMPAT(projectMetadataAgentTitle): `agentTitle` project metadata prompts were removed
  // in v0.1.96; keep legacy mixer.json parseable until 2026-12-16.
  .passthrough()
  .catch({});

export const MixerConfigRawSchema = z
  .object({
    worktree: MixerWorktreeConfigRawSchema.optional(),
    scripts: z.record(z.string(), MixerScriptEntryRawSchema).optional(),
    metadataGeneration: MixerMetadataGenerationSchema.optional(),
  })
  .passthrough();

export const WorktreeConfigSchema = MixerWorktreeConfigRawSchema.extend({
  setup: z.unknown().optional().transform(normalizeLifecycleCommands),
  teardown: z.unknown().optional().transform(normalizeLifecycleCommands),
})
  .passthrough()
  .catch({ setup: [], teardown: [] });

export const ScriptEntrySchema = MixerScriptEntryRawSchema.catch({});

export const MixerConfigSchema = MixerConfigRawSchema.extend({
  worktree: WorktreeConfigSchema.optional(),
  scripts: z.record(z.string(), ScriptEntrySchema).optional().catch({}),
  metadataGeneration: MixerMetadataGenerationSchema.optional(),
})
  .passthrough()
  .catch({});

export const MixerConfigRevisionSchema = z.object({
  mtimeMs: z.number(),
  size: z.number(),
});

export const ProjectConfigRpcErrorSchema = z.discriminatedUnion("code", [
  z.object({ code: z.literal("project_not_found") }),
  z.object({ code: z.literal("invalid_project_config") }),
  z.object({
    code: z.literal("stale_project_config"),
    currentRevision: MixerConfigRevisionSchema.nullable(),
  }),
  z.object({ code: z.literal("write_failed") }),
]);

export type MixerScriptEntryRaw = z.infer<typeof MixerScriptEntryRawSchema>;
export type MixerMetadataGenerationEntry = z.infer<typeof MixerMetadataGenerationEntrySchema>;
export type MixerMetadataGeneration = z.infer<typeof MixerMetadataGenerationSchema>;
export type MixerServicePortAllocation = z.infer<typeof MixerServicePortAllocationSchema>;
export type MixerConfigRaw = z.infer<typeof MixerConfigRawSchema>;
export type MixerConfig = z.infer<typeof MixerConfigSchema>;
export type MixerConfigRevision = z.infer<typeof MixerConfigRevisionSchema>;
export type ProjectConfigRpcError = z.infer<typeof ProjectConfigRpcErrorSchema>;
