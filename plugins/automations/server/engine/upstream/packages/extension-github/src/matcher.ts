import { RE2JS } from "re2js";
import { z } from "zod";

const stringOperations = [
  "equals", "not-equals", "one-of", "not-one-of", "starts-with", "ends-with",
  "contains", "matches", "not-matches", "exists",
] as const;

const stringMatcherObjectSchema = z.object({
  equals: z.string().optional(),
  "not-equals": z.string().optional(),
  "one-of": z.array(z.string()).min(1).optional(),
  "not-one-of": z.array(z.string()).min(1).optional(),
  "starts-with": z.string().optional(),
  "ends-with": z.string().optional(),
  contains: z.string().optional(),
  matches: z.string().min(1).max(512).optional(),
  "not-matches": z.string().min(1).max(512).optional(),
  exists: z.boolean().optional(),
  "case-sensitive": z.boolean().default(false),
}).strict().superRefine((value, context) => {
  const operations = stringOperations.filter((operation) => value[operation] !== undefined);
  if (operations.length !== 1) {
    context.addIssue({ code: "custom", message: "string matcher requires exactly one operation" });
    return;
  }
  const pattern = value.matches ?? value["not-matches"];
  if (pattern) {
    try { RE2JS.compile(pattern); }
    catch (error) {
      context.addIssue({ code: "custom", message: `invalid RE2 pattern: ${error instanceof Error ? error.message : String(error)}` });
    }
  }
});

export const stringMatcherSchema = z.union([
  z.string(),
  z.array(z.string()).min(1),
  stringMatcherObjectSchema,
]);

const labelsMatcherSchema = z.object({
  any: z.array(z.string()).min(1).optional(),
  all: z.array(z.string()).min(1).optional(),
  none: z.array(z.string()).min(1).optional(),
}).strict().refine((value) => value.any || value.all || value.none, "labels matcher cannot be empty");

const numberMatcherSchema = z.union([
  z.number(),
  z.object({
    equals: z.number().optional(),
    gt: z.number().optional(),
    gte: z.number().optional(),
    lt: z.number().optional(),
    lte: z.number().optional(),
  }).strict().refine((value) => Object.values(value).some((item) => item !== undefined), "number matcher cannot be empty"),
]);

const predicateSchema = z.object({
  labels: labelsMatcherSchema.optional(),
  author: stringMatcherSchema.optional(),
  actor: stringMatcherSchema.optional(),
  "pull-request-author": stringMatcherSchema.optional(),
  "reply-to": stringMatcherSchema.optional(),
  reviewer: stringMatcherSchema.optional(),
  mentioned: stringMatcherSchema.optional(),
  title: stringMatcherSchema.optional(),
  body: stringMatcherSchema.optional(),
  state: stringMatcherSchema.optional(),
  "author-association": stringMatcherSchema.optional(),
  "head-branch": stringMatcherSchema.optional(),
  "base-branch": stringMatcherSchema.optional(),
  "head-repository": stringMatcherSchema.optional(),
  "base-repository": stringMatcherSchema.optional(),
  "review-state": stringMatcherSchema.optional(),
  "check-conclusion": stringMatcherSchema.optional(),
  "event-label": stringMatcherSchema.optional(),
  draft: z.boolean().optional(),
  merged: z.boolean().optional(),
  fork: z.boolean().optional(),
  "branch-relation": z.enum(["same", "different"]).optional(),
  number: numberMatcherSchema.optional(),
  "changed-files": numberMatcherSchema.optional(),
  "pull-request": z.boolean().optional(),
}).strict().refine((value) => Object.keys(value).length > 0, "GitHub predicate cannot be empty");

export type GitHubCondition =
  | { all: GitHubCondition[] }
  | { any: GitHubCondition[] }
  | { not: GitHubCondition }
  | z.infer<typeof predicateSchema>;

export const githubConditionSchema: z.ZodType<GitHubCondition> = z.lazy(() => z.union([
  z.object({ all: z.array(githubConditionSchema).min(1) }).strict(),
  z.object({ any: z.array(githubConditionSchema).min(1) }).strict(),
  z.object({ not: githubConditionSchema }).strict(),
  predicateSchema,
]));

const githubTriggerObjectSchema = z.object({
  events: z.array(z.string()).min(1).optional(),
  types: z.array(z.string()).min(1).optional(),
  names: z.array(z.string()).min(1).optional(),
  where: githubConditionSchema.optional(),
  reconcile: z.boolean().optional(),
}).strict().refine((value) => !(value.events && value.types), "use either events or types, not both");

export const githubTriggerSchema = z.union([z.null(), githubTriggerObjectSchema]).transform((value) => value ?? {});

export interface GitHubEventData {
  action?: string;
  author?: string;
  actor?: string;
  pullRequestAuthor?: string;
  requestedReviewers?: string[];
  requestedTeams?: string[];
  title?: string;
  body?: string | null;
  state?: string;
  authorAssociation?: string;
  labels?: string[];
  headBranch?: string;
  baseBranch?: string;
  headRepository?: string;
  baseRepository?: string;
  reviewState?: string;
  checkConclusion?: string | null;
  eventLabel?: string;
  draft?: boolean;
  merged?: boolean;
  fork?: boolean;
  number?: number;
  changedFiles?: number;
  isPullRequest?: boolean;
  headSha?: string;
  /** Revision carried by the original event, never replaced by live PR enrichment. */
  triggerHeadSha?: string;
  baseSha?: string;
  headRef?: string;
  baseRef?: string;
  headRepositoryId?: number;
  baseRepositoryId?: number;
  commentId?: number;
  commentNodeId?: string;
  commentKind?: "conversation" | "review";
  commentPath?: string;
  replyToCommentId?: number;
  replyToAuthor?: string;
  reviewId?: number;
  reviewNodeId?: string;
  reviewComments?: Array<{ id: number; nodeId?: string; body?: string | null; path?: string; replyToCommentId?: number }>;
  maintainerCanModify?: boolean;
  [key: string]: unknown;
}

function normalize(value: string, caseSensitive: boolean): string {
  return caseSensitive ? value : value.toLocaleLowerCase("en-US");
}

export function matchesString(value: string | null | undefined, rawMatcher: z.infer<typeof stringMatcherSchema>): boolean {
  if (typeof rawMatcher === "string") return value !== undefined && value !== null && normalize(value, false) === normalize(rawMatcher, false);
  if (Array.isArray(rawMatcher)) {
    return value !== undefined && value !== null && rawMatcher.some((candidate) => normalize(value, false) === normalize(candidate, false));
  }
  if (rawMatcher.exists !== undefined) return rawMatcher.exists === (value !== undefined && value !== null);
  if (value === undefined || value === null) return false;
  const caseSensitive = rawMatcher["case-sensitive"];
  const actual = normalize(value, caseSensitive);
  if (rawMatcher.equals !== undefined) return actual === normalize(rawMatcher.equals, caseSensitive);
  if (rawMatcher["not-equals"] !== undefined) return actual !== normalize(rawMatcher["not-equals"], caseSensitive);
  if (rawMatcher["one-of"]) return rawMatcher["one-of"].some((candidate) => actual === normalize(candidate, caseSensitive));
  if (rawMatcher["not-one-of"]) return rawMatcher["not-one-of"].every((candidate) => actual !== normalize(candidate, caseSensitive));
  if (rawMatcher["starts-with"] !== undefined) return actual.startsWith(normalize(rawMatcher["starts-with"], caseSensitive));
  if (rawMatcher["ends-with"] !== undefined) return actual.endsWith(normalize(rawMatcher["ends-with"], caseSensitive));
  if (rawMatcher.contains !== undefined) return actual.includes(normalize(rawMatcher.contains, caseSensitive));
  const pattern = rawMatcher.matches ?? rawMatcher["not-matches"]!;
  const flags = caseSensitive ? 0 : RE2JS.CASE_INSENSITIVE;
  const matched = RE2JS.compile(pattern, flags).test(value);
  return rawMatcher["not-matches"] === undefined ? matched : !matched;
}

function matchesLabels(labels: string[], matcher: z.infer<typeof labelsMatcherSchema>): boolean {
  const actual = new Set(labels.map((label) => normalize(label, false)));
  if (matcher.any && !matcher.any.some((label) => actual.has(normalize(label, false)))) return false;
  if (matcher.all && !matcher.all.every((label) => actual.has(normalize(label, false)))) return false;
  if (matcher.none && matcher.none.some((label) => actual.has(normalize(label, false)))) return false;
  return true;
}

function matchesNumber(value: number | undefined, matcher: z.infer<typeof numberMatcherSchema>): boolean {
  if (value === undefined) return false;
  if (typeof matcher === "number") return value === matcher;
  if (matcher.equals !== undefined && value !== matcher.equals) return false;
  if (matcher.gt !== undefined && value <= matcher.gt) return false;
  if (matcher.gte !== undefined && value < matcher.gte) return false;
  if (matcher.lt !== undefined && value >= matcher.lt) return false;
  if (matcher.lte !== undefined && value > matcher.lte) return false;
  return true;
}

export interface GitHubMatchIdentity {
  login?: string;
}

function resolveMe(value: string, identity: GitHubMatchIdentity): string | undefined {
  return normalize(value, false) === "me" ? identity.login : value;
}

function matchesIdentity(
  value: string | null | undefined,
  matcher: z.infer<typeof stringMatcherSchema>,
  identity: GitHubMatchIdentity,
): boolean {
  if (typeof matcher === "string") {
    const resolved = resolveMe(matcher, identity);
    return resolved !== undefined && matchesString(value, resolved);
  }
  if (Array.isArray(matcher)) {
    return matcher.some((candidate) => {
      const resolved = resolveMe(candidate, identity);
      return resolved !== undefined && matchesString(value, resolved);
    });
  }
  return matchesString(value, matcher);
}

function matchesAnyIdentity(
  values: string[],
  matcher: z.infer<typeof stringMatcherSchema>,
  identity: GitHubMatchIdentity,
): boolean {
  return values.some((value) => matchesIdentity(value, matcher, identity));
}

function mentionedIdentities(body: string | null | undefined): string[] {
  if (!body) return [];
  return [...body.matchAll(/(^|[^\w])@([a-z\d](?:[a-z\d-]{0,38})(?:\/[a-z\d](?:[a-z\d_-]{0,99}))?)/giu)]
    .map((match) => match[2]!)
    .filter((value, index, values) => values.findIndex((item) => normalize(item, false) === normalize(value, false)) === index);
}

function matchesPredicate(
  data: GitHubEventData,
  predicate: z.infer<typeof predicateSchema>,
  identity: GitHubMatchIdentity,
): boolean {
  const strings: Array<[keyof typeof predicate, string | null | undefined]> = [
    ["author", data.author], ["actor", data.actor], ["title", data.title], ["body", data.body],
    ["state", data.state], ["author-association", data.authorAssociation], ["head-branch", data.headBranch],
    ["base-branch", data.baseBranch], ["head-repository", data.headRepository],
    ["base-repository", data.baseRepository], ["review-state", data.reviewState],
    ["check-conclusion", data.checkConclusion], ["event-label", data.eventLabel],
    ["pull-request-author", data.pullRequestAuthor],
    ["reply-to", data.replyToAuthor],
  ];
  for (const [key, value] of strings) {
    const matcher = predicate[key];
    if (matcher !== undefined && !matchesIdentity(value, matcher as z.infer<typeof stringMatcherSchema>, identity)) return false;
  }
  if (predicate.reviewer && !matchesAnyIdentity(
    [...(data.requestedReviewers ?? []), ...(data.requestedTeams ?? [])],
    predicate.reviewer,
    identity,
  )) return false;
  if (predicate.mentioned && !matchesAnyIdentity(mentionedIdentities(data.body), predicate.mentioned, identity)) return false;
  if (predicate.labels && !matchesLabels(data.labels ?? [], predicate.labels)) return false;
  for (const [key, value] of [["draft", data.draft], ["merged", data.merged], ["fork", data.fork]] as const) {
    if (predicate[key] !== undefined && (value === undefined || predicate[key] !== value)) return false;
  }
  if (predicate["branch-relation"]) {
    if (data.headBranch === undefined || data.baseBranch === undefined) return false;
    const relation = data.headBranch === data.baseBranch ? "same" : "different";
    if (relation !== predicate["branch-relation"]) return false;
  }
  if (predicate.number !== undefined && !matchesNumber(data.number, predicate.number)) return false;
  if (predicate["changed-files"] !== undefined && !matchesNumber(data.changedFiles, predicate["changed-files"])) return false;
  if (predicate["pull-request"] !== undefined && data.isPullRequest !== predicate["pull-request"]) return false;
  return true;
}

export function matchesGitHubCondition(
  data: GitHubEventData,
  condition: GitHubCondition,
  identity: GitHubMatchIdentity = {},
): boolean {
  if ("all" in condition) return condition.all.every((child) => matchesGitHubCondition(data, child, identity));
  if ("any" in condition) return condition.any.some((child) => matchesGitHubCondition(data, child, identity));
  if ("not" in condition) return !matchesGitHubCondition(data, condition.not, identity);
  return matchesPredicate(data, condition, identity);
}

export function matchesGitHubTrigger(data: GitHubEventData, rawConfig: unknown, identity: GitHubMatchIdentity = {}): boolean {
  const config = githubTriggerSchema.parse(rawConfig);
  const events = config.events ?? config.types;
  if (events && !events.includes(data.action ?? "")) return false;
  if (config.names && !config.names.some((name) => (data.labels ?? []).some((label) => normalize(label, false) === normalize(name, false)))) {
    return false;
  }
  return config.where ? matchesGitHubCondition(data, config.where, identity) : true;
}

// Unknown means the condition depends on live resource state. Preserve boolean
// structure, especially negation, instead of dropping failed mutable predicates.
function matchesEventFacts(data: GitHubEventData, condition: GitHubCondition, identity: GitHubMatchIdentity, resourceTitle: boolean): boolean | undefined {
  if ("all" in condition) {
    const results = condition.all.map((child) => matchesEventFacts(data, child, identity, resourceTitle));
    return results.includes(false) ? false : results.includes(undefined) ? undefined : true;
  }
  if ("any" in condition) {
    const results = condition.any.map((child) => matchesEventFacts(data, child, identity, resourceTitle));
    return results.includes(true) ? true : results.includes(undefined) ? undefined : false;
  }
  if ("not" in condition) {
    const result = matchesEventFacts(data, condition.not, identity, resourceTitle);
    return result === undefined ? undefined : !result;
  }
  const { labels, state, draft, merged, title, "head-branch": headBranch, "base-branch": baseBranch,
    "branch-relation": branchRelation, "changed-files": changedFiles, ...facts } = condition;
  if (!matchesPredicate(data, resourceTitle ? facts : { ...facts, title }, identity)) return false;
  return [labels, state, draft, merged, resourceTitle ? title : undefined, headBranch, baseBranch, branchRelation, changedFiles]
    .some((value) => value !== undefined) ? undefined : true;
}

export function evaluateGitHubTrigger(data: GitHubEventData, rawConfig: unknown, identity: GitHubMatchIdentity = {}, resourceTitle = true): "match" | "ignore" | "defer" {
  const config = githubTriggerSchema.parse(rawConfig);
  const events = config.events ?? config.types;
  if (events && !events.includes(data.action ?? "")) return "ignore";
  if (matchesGitHubTrigger(data, config, identity)) return "match";
  if (!config.reconcile || data.merged === true || (config.where && matchesEventFacts(data, config.where, identity, resourceTitle) === false)) return "ignore";
  return "defer";
}
