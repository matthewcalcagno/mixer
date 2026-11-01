import type { ToolCallDetail } from "../agent-types.js";
import { getMixerToolLeafName, isMixerToolName } from "../tool-name-normalization.js";
import { getMixerToolEntry, MIXER_TOOL_CATALOG, type MixerToolName } from "./catalog.js";
import { toSummaryText } from "./summary-text.js";

export { buildAgentMessageDisplay, type AgentMessageDisplay } from "./agent-message.js";
export {
  buildMixerToolDetailSections,
  type MixerToolDetailField,
  type MixerToolDetailSection,
} from "./detail-sections.js";
export { MAX_SUMMARY_CHARS } from "./summary-text.js";
export type { MixerToolName };

export interface MixerToolDisplayInput {
  toolName: string;
  detail: ToolCallDetail;
  /** Title of the agent named by the call's `agentId`, when the caller knows it. */
  targetAgentTitle?: string;
}

export interface MixerToolDisplay {
  displayName: string;
  summary?: string;
}

export const MIXER_TOOL_NAMES = Object.keys(MIXER_TOOL_CATALOG) as readonly MixerToolName[];

/** Returns null for tools outside the Mixer namespace. */
export function buildMixerToolDisplay(input: MixerToolDisplayInput): MixerToolDisplay | null {
  // Canonical details own internal lifecycle rows such as worktree setup.
  if (input.detail.type !== "unknown") return null;
  const leafName = mixerLeafName(input.toolName);
  if (!leafName) return null;
  const entry = getMixerToolEntry(leafName);
  if (!entry) return { displayName: humanizeLeafName(leafName) };

  const toolInput = readToolInput(input.detail);
  const targetAgent = input.targetAgentTitle ?? readString(toolInput.agentId);
  const summary = formatContext(entry.context?.(toolInput, targetAgent));
  return { displayName: entry.label, ...(summary ? { summary } : {}) };
}

/** A semantic action label for summaries, sharing the tool presentation catalog. */
export function getMixerToolActionLabel(toolName: string): string | null {
  const leafName = mixerLeafName(toolName);
  if (!leafName) return null;
  return getMixerToolEntry(leafName)?.completedLabel ?? humanizeLeafName(leafName);
}

/** The agent a Mixer call acts on, so callers can resolve its title. */
export function getMixerToolTargetAgentId(
  toolName: string,
  detail: ToolCallDetail | undefined,
): string | null {
  if (!detail || !mixerLeafName(toolName)) return null;
  return readString(readToolInput(detail).agentId) ?? null;
}

function mixerLeafName(toolName: string): string | null {
  if (isMixerToolName(toolName)) return getMixerToolLeafName(toolName);
  const normalized = toolName.trim().toLowerCase();
  return normalized.startsWith("mixer_") && !normalized.startsWith("mixer__")
    ? normalized.slice("mixer_".length)
    : null;
}

function readToolInput(detail: ToolCallDetail): Readonly<Record<string, unknown>> {
  if (detail.type !== "unknown") return {};
  const value = detail.input;
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function formatContext(value: unknown): string | undefined {
  if (typeof value === "string") return toSummaryText(value);
  if (typeof value === "number") return String(value);
  if (Array.isArray(value)) {
    const [first, ...rest] = value;
    const head = typeof first === "string" ? toSummaryText(first) : undefined;
    if (!head) return undefined;
    return rest.length > 0 ? `${head} +${rest.length}` : head;
  }
  return undefined;
}

function humanizeLeafName(leafName: string): string {
  const sentence = leafName
    .replace(/[._-]+/g, " ")
    .trim()
    .toLowerCase();
  return `${sentence[0]?.toUpperCase() ?? ""}${sentence.slice(1)}`;
}
