import type { z } from "zod";
import type { ProviderMixerToolsPolicy } from "@mixer/protocol/provider-config";

export class MixerToolInputError extends Error {
  readonly status = 400;

  constructor(
    message: string,
    readonly issues?: z.ZodError["issues"],
  ) {
    super(message);
    this.name = "MixerToolInputError";
  }
}

export interface MixerToolExecutionContext {
  signal?: AbortSignal;
  sendUpdate?: (update: MixerToolResult) => void;
}

export interface MixerToolResult {
  content: Array<{ type: string; text?: string; [key: string]: unknown }>;
  structuredContent?: unknown;
  isError?: boolean;
}

export interface MixerToolConfig {
  title?: string;
  description?: string;
  inputSchema?: z.ZodRawShape | z.ZodType;
  outputSchema?: z.ZodRawShape;
}

export interface MixerToolDefinition extends MixerToolConfig {
  name: string;
  description: string;
  handler: (input: unknown, context: MixerToolExecutionContext) => Promise<MixerToolResult>;
}

export interface MixerToolCatalog {
  tools: ReadonlyMap<string, MixerToolDefinition>;
  getTool(name: string): MixerToolDefinition | undefined;
  executeTool(
    name: string,
    input: unknown,
    context?: MixerToolExecutionContext,
  ): Promise<MixerToolResult>;
}

export interface MixerToolRuntimeContext {
  callerAgentId?: string;
  mixerToolPolicy?: ProviderMixerToolsPolicy;
  enableVoiceTools?: boolean;
  voiceOnly?: boolean;
}

export type MixerToolCatalogFactory = (
  context: MixerToolRuntimeContext,
) => MixerToolCatalog | Promise<MixerToolCatalog>;
