import { z } from "zod";
import type {
  AgentRole, CommunicationPolicy, Event, MaintainerCommunication, Run, VerificationResult, WorkspaceArtifact,
} from "@mixer/automations-sdk";

const emoji = /\p{Extended_Pictographic}/u;
const markdownHeading = /^\s{0,3}#{1,6}\s+/m;
const standaloneBoldHeading = /^\s*(?:\*\*|__)[^*_\n]{1,60}(?:\*\*|__)\s*:?\s*$/m;
const fencedBlock = /```[\s\S]*?```/g;

export const maintainerReferenceSchema = z.object({
  source: z.enum(["event", "repository", "workspace", "verification", "run"]),
  value: z.string().trim().min(1).max(2_000),
}).strict();

export const maintainerMessageSchema = z.object({
  purpose: z.enum(["reply", "review", "change", "report", "status"]),
  subject: z.string().trim().min(1).max(96).optional(),
  body: z.string().trim().min(1).max(12_000),
  references: z.array(maintainerReferenceSchema).max(40).default([]),
}).strict().superRefine((message, context) => {
  if ((message.purpose === "change" || message.purpose === "report") && !message.subject) {
    context.addIssue({ code: "custom", path: ["subject"], message: `A ${message.purpose} message requires a subject` });
  }
  if (message.purpose !== "change" && message.purpose !== "report" && message.subject) {
    context.addIssue({ code: "custom", path: ["subject"], message: "Only change and report messages may have a subject" });
  }
});

export const maintainerCommunicationSchema = z.object({
  version: z.literal(1).default(1),
  language: z.string().trim().min(2).max(64),
  messages: z.array(maintainerMessageSchema).min(1).max(4),
}).strict().superRefine((communication, context) => {
  const purposes = new Set<string>();
  for (let index = 0; index < communication.messages.length; index++) {
    const purpose = communication.messages[index]!.purpose;
    if (purposes.has(purpose)) {
      context.addIssue({ code: "custom", path: ["messages", index, "purpose"], message: `Duplicate ${purpose} message` });
    }
    purposes.add(purpose);
  }
});

export interface CommunicationEvidence {
  event: Event;
  run: Run;
  artifact?: WorkspaceArtifact;
  verification?: readonly VerificationResult[];
}

function styleError(value: string, subject = false): string | undefined {
  if (emoji.test(value)) return "emoji_not_allowed";
  if (markdownHeading.test(value) || standaloneBoldHeading.test(value)) return "markdown_heading_not_allowed";
  if (subject && /[\r\n]/.test(value)) return "subject_must_be_one_line";
  if (!subject) {
    const withoutCode = value.replace(fencedBlock, "");
    const paragraphs = withoutCode.split(/\n\s*\n/).filter((part) => part.trim()).length;
    const listItems = withoutCode.split(/\r?\n/).filter((line) => /^\s*(?:[-*+] |\d+[.)] )/.test(line)).length;
    if (paragraphs > 10) return "too_many_paragraphs";
    if (listItems > 8) return "too_many_list_items";
    if (/\b(?:as an ai|as a language model|i am an ai)\b/i.test(withoutCode)) return "agent_identity_not_allowed";
  }
  return undefined;
}

function collectScalars(value: unknown, values: Set<string>, seen = new WeakSet<object>()): void {
  if (typeof value === "string" || typeof value === "number") {
    values.add(String(value));
    return;
  }
  if (!value || typeof value !== "object") return;
  if (seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) collectScalars(item, values, seen);
    return;
  }
  for (const item of Object.values(value as Record<string, unknown>)) collectScalars(item, values, seen);
}

interface EvidenceValues {
  event: Set<string>;
  repository: Set<string>;
  workspace: Set<string>;
  verification: Set<string>;
  run: Set<string>;
}

function evidenceValues(evidence: CommunicationEvidence): EvidenceValues {
  const event = new Set<string>();
  collectScalars(evidence.event, event);
  const verification = new Set<string>();
  for (const item of evidence.verification ?? []) {
    verification.add(item.command);
    verification.add([item.command, ...item.args].join(" "));
  }
  return {
    event,
    repository: new Set(evidence.run.repository ? [evidence.run.repository] : []),
    workspace: new Set([
      ...(evidence.artifact?.baseRevision ? [evidence.artifact.baseRevision] : []),
      ...(evidence.artifact?.files ?? []).map((file) => file.path),
    ]),
    verification,
    run: new Set([evidence.run.id, evidence.run.workflowId]),
  };
}

function appearsIn(values: Iterable<string>, token: string): boolean {
  for (const value of values) if (value === token || value.includes(token)) return true;
  return false;
}

function validateTextReferences(text: string, allowed: EvidenceValues): void {
  for (const match of text.matchAll(/(?:^|[^\w])#(\d+)\b/g)) {
    const number = match[1]!;
    if (!allowed.event.has(number) && !appearsIn(allowed.event, `#${number}`)) {
      throw new Error(`communication_text_reference_unverified:#${number}`);
    }
  }
  for (const match of text.matchAll(/https?:\/\/[^\s<>\)\]`]+/g)) {
    const url = match[0].replace(/[.,;:!?]+$/, "");
    if (!appearsIn(allowed.event, url)) throw new Error(`communication_text_reference_unverified:${url}`);
  }
  for (const match of text.matchAll(/\bcommit\s+[`']?([0-9a-f]{7,40})\b/gi)) {
    const revision = match[1]!;
    if (!appearsIn(allowed.event, revision) && !appearsIn(allowed.workspace, revision)) {
      throw new Error(`communication_text_reference_unverified:${revision}`);
    }
  }
}

export function communicationPolicy(language: string): CommunicationPolicy {
  return { language, style: "maintainer-direct" };
}

export function validateMaintainerCommunication(
  candidate: unknown,
  policy: CommunicationPolicy,
  evidence: CommunicationEvidence,
): MaintainerCommunication {
  const parsed = maintainerCommunicationSchema.parse(candidate);
  if (parsed.language.localeCompare(policy.language, undefined, { sensitivity: "accent" }) !== 0) {
    throw new Error(`communication_language_mismatch:${policy.language}`);
  }
  const allowed = evidenceValues(evidence);
  for (const message of parsed.messages) {
    const bodyError = styleError(message.body);
    if (bodyError) throw new Error(`communication_${message.purpose}_${bodyError}`);
    if (message.subject) {
      const subjectError = styleError(message.subject, true);
      if (subjectError) throw new Error(`communication_change_${subjectError}`);
    }
    validateTextReferences(`${message.subject ?? ""}\n${message.body}`, allowed);
    for (const reference of message.references) {
      if (!allowed[reference.source]!.has(reference.value)) {
        throw new Error(`communication_reference_unverified:${reference.source}:${reference.value}`);
      }
    }
  }
  return parsed;
}

export function communicationInstructions(policy: CommunicationPolicy, role: AgentRole): string[] {
  const common = [
    `All public-facing maintainer communication must be written in ${policy.language}.`,
    "Write like an experienced repository maintainer: lead with the conclusion, use direct natural sentences, and be precise about what changed and what was verified.",
    "Do not use emojis, greetings, sign-offs, Markdown headings, canned Summary/Changes/Tests sections, promotional language, or references to being an AI, agent, bot, or automation.",
    "Use short paragraphs. Use a small list only when it is genuinely clearer than prose. Preserve Markdown only for code, file paths, symbols, links, or technically useful snippets.",
    "Never invent an issue, pull request, commit, file, check, test result, URL, or symbol. Distinguish verified facts from inferences and say plainly when verification failed or was unavailable.",
  ];
  if (role !== "operator") return common;
  return [
    ...common,
    "The communication bundle is the sole source of public prose for every integration. Safe Action inputs contain decisions and technical metadata, not duplicate public messages.",
    "Choose message purposes by intent: reply for issue or discussion comments, review for code review text, change for a proposed change title and description, report for a newly discovered problem title and explanation, and status for a non-conversational operational result.",
    "For a change subject, use a concise imperative engineering title. In its body, explain why the change is needed, what it does, and the actual verification result without template-like section headings.",
    "For a report subject, state the concrete problem without alarmism. In its body, explain the evidence, impact, location, and a practical next step without pretending a fix was implemented.",
    "Add structured references only when their exact values are present in the event, repository, changed-file artifact, verification commands, or run identifiers. The core rejects unverified references.",
  ];
}
