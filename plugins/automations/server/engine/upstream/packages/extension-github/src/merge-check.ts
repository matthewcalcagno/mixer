import fs from "node:fs";
import { z } from "zod";

export const mergeCheckPolicySchema = z.object({
  allowedAuthors: z.array(z.string().min(1)).default([]),
  requiredLabels: z.array(z.string().min(1)).default([]),
  excludedLabels: z.array(z.string().min(1)).default(["roboplane-ignore"]),
  qualityGateChecks: z.array(z.string().min(1)).min(1).default(["SonarCloud Code Analysis", "SonarQube Code Analysis", "SonarQubeCloud Code Analysis"]),
}).strict();
type Policy = z.infer<typeof mergeCheckPolicySchema>;
type Get = (endpoint: string) => Promise<unknown>;
const sha = z.string().regex(/^[a-f0-9]{40}$/);
const prSchema = z.object({
  number: z.number().int().positive(), state: z.enum(["open", "closed"]), merged: z.boolean(), draft: z.boolean(),
  user: z.object({ login: z.string().min(1) }), labels: z.array(z.object({ name: z.string() })),
  head: z.object({ sha, ref: z.string(), repo: z.object({ full_name: z.string() }).nullable() }),
  base: z.object({ sha, ref: z.string(), repo: z.object({ full_name: z.string() }) }),
  mergeable: z.boolean().nullable(), mergeable_state: z.string(),
});
const checkSchema = z.object({ id: z.number(), name: z.string(), head_sha: sha, status: z.string(), conclusion: z.string().nullable(), app: z.object({ id: z.number() }).nullable().optional() });
const statusSchema = z.object({ id: z.number(), context: z.string(), state: z.string(), sha: sha.optional() });
const reviewSchema = z.object({ id: z.number(), state: z.string(), commit_id: sha.nullable(), user: z.object({ login: z.string() }).nullable() });
const ruleSchema = z.object({ type: z.string(), parameters: z.record(z.string(), z.unknown()).optional() });
const pullRequestRuleParametersSchema = z.object({
  required_approving_review_count: z.number().int().nonnegative(), require_code_owner_review: z.boolean(), require_last_push_approval: z.boolean(),
  dismiss_stale_reviews_on_push: z.boolean().optional(), required_review_thread_resolution: z.boolean().optional(),
  allowed_merge_methods: z.array(z.enum(["merge", "squash", "rebase"])).optional(),
}).catchall(z.unknown());
const protectionSchema = z.object({
  required_status_checks: z.object({ strict: z.boolean(), contexts: z.array(z.string()), checks: z.array(z.object({ context: z.string(), app_id: z.number().nullable() })).optional() }).nullable().optional(),
  required_pull_request_reviews: z.object({ required_approving_review_count: z.number().int(), require_code_owner_reviews: z.boolean(), require_last_push_approval: z.boolean().optional() }).nullable().optional(),
  required_signatures: z.object({ enabled: z.boolean() }).optional(),
  required_linear_history: z.object({ enabled: z.boolean() }).optional(),
  required_conversation_resolution: z.object({ enabled: z.boolean() }).optional(),
  lock_branch: z.object({ enabled: z.boolean() }).optional(),
  restrictions: z.unknown().optional(),
});

export interface MergeCheckReport {
  version: 1;
  repository: string;
  number: number;
  headSha: string;
  baseSha: string;
  observedAt: string;
  decision: "eligible" | "ineligible" | "unknown";
  reasons: string[];
}

async function pages<T>(get: Get, endpoint: string, schema: z.ZodType<T>, key?: string): Promise<T[]> {
  const result: T[] = [];
  for (let page = 1; page <= 100; page++) {
    const response = await get(`${endpoint}${endpoint.includes("?") ? "&" : "?"}per_page=100&page=${page}`);
    const raw = key ? z.record(z.string(), z.unknown()).parse(response)[key] : response;
    const items = z.array(schema).parse(raw);
    result.push(...items);
    if (items.length < 100) {
      if (key) {
        const count = z.object({ total_count: z.number().int().nonnegative().optional() }).parse(response).total_count;
        if (count !== undefined && count > result.length) throw new Error("merge_check_incomplete_collection");
      }
      return result;
    }
  }
  throw new Error("merge_check_pagination_limit");
}

export async function checkMergeEligibility(get: Get, repository: string, number: number, policy: Policy, options: { mergeMethod?: "merge" | "squash" | "rebase" } = {}): Promise<MergeCheckReport> {
  const endpoint = `/repos/${repository}`;
  const pr = prSchema.parse(await get(`${endpoint}/pulls/${number}`));
  if (pr.number !== number || pr.base.repo.full_name !== repository) throw new Error("merge_check_target_mismatch");
  const blocked: string[] = [];
  const uncertain: string[] = [];
  if (pr.state !== "open" || pr.merged) blocked.push("pull_request_not_open");
  if (pr.draft) blocked.push("pull_request_draft");
  if (pr.head.repo?.full_name !== repository) blocked.push("fork_or_missing_head_repository");
  if (policy.allowedAuthors.length && !policy.allowedAuthors.some((author) => author.toLowerCase() === pr.user.login.toLowerCase())) blocked.push("author_not_allowed");
  const labels = new Set(pr.labels.map((label) => label.name));
  if (policy.requiredLabels.some((label) => !labels.has(label))) blocked.push("required_label_missing");
  if (policy.excludedLabels.some((label) => labels.has(label))) blocked.push("excluded_label_present");
  if (pr.mergeable === false) blocked.push("merge_conflict");
  if (pr.mergeable === null || !["clean", "behind", "blocked", "dirty", "unstable", "unknown", "draft", "has_hooks"].includes(pr.mergeable_state)) uncertain.push("mergeability_unknown");
  if (["blocked", "behind", "dirty", "draft"].includes(pr.mergeable_state)) blocked.push(`merge_state_${pr.mergeable_state}`);
  if (["unknown", "has_hooks"].includes(pr.mergeable_state)) uncertain.push(`merge_state_${pr.mergeable_state}`);
  const [checks, statuses, reviews] = await Promise.all([
    pages(get, `${endpoint}/commits/${pr.head.sha}/check-runs?filter=latest`, checkSchema, "check_runs"),
    pages(get, `${endpoint}/commits/${pr.head.sha}/statuses`, statusSchema),
    pages(get, `${endpoint}/pulls/${number}/reviews`, reviewSchema),
  ]);
  const latestChecks = new Map<string, z.infer<typeof checkSchema>>();
  for (const check of checks) {
    if (check.head_sha !== pr.head.sha) { uncertain.push("check_head_mismatch"); continue; }
    const key = `${check.app?.id ?? "unknown"}:${check.name}`;
    if ((latestChecks.get(key)?.id ?? -1) < check.id) latestChecks.set(key, check);
  }
  const latestStatuses = new Map<string, z.infer<typeof statusSchema>>();
  for (const status of statuses) {
    if (status.sha !== undefined && status.sha !== pr.head.sha) { uncertain.push("status_head_mismatch"); continue; }
    if ((latestStatuses.get(status.context)?.id ?? -1) < status.id) latestStatuses.set(status.context, status);
  }
  if (!latestChecks.size && !latestStatuses.size) blocked.push("no_checks_or_statuses");
  for (const check of latestChecks.values()) {
    if (check.status !== "completed") blocked.push(`check_pending:${check.name}`);
    else if (!check.conclusion || !["success", "neutral", "skipped"].includes(check.conclusion)) blocked.push(`check_failed:${check.name}`);
  }
  for (const status of latestStatuses.values()) if (status.state !== "success") blocked.push(`status_not_successful:${status.context}`);
  const gates = [...latestChecks.values()].filter((check) => policy.qualityGateChecks.includes(check.name));
  const gateStatuses = [...latestStatuses.values()].filter((status) => policy.qualityGateChecks.includes(status.context));
  if (!gates.length && !gateStatuses.length) uncertain.push("quality_gate_missing");
  if (gates.some((gate) => gate.status !== "completed" || gate.conclusion !== "success") || gateStatuses.some((gate) => gate.state !== "success")) blocked.push("quality_gate_not_successful");
  const effective = new Map<string, z.infer<typeof reviewSchema>>();
  for (const review of reviews) {
    if (!review.user || review.state === "COMMENTED" || review.state === "PENDING") continue;
    const key = review.user.login.toLowerCase();
    if ((effective.get(key)?.id ?? -1) < review.id) effective.set(key, review);
  }
  const approvals = [...effective.values()].filter((review) => review.state === "APPROVED" && review.commit_id === pr.head.sha && review.user?.login.toLowerCase() !== pr.user.login.toLowerCase());
  if (!approvals.length) blocked.push("current_head_approval_missing");
  if ([...effective.values()].some((review) => review.state === "CHANGES_REQUESTED")) blocked.push("changes_requested");

  const required: Array<{ name: string; app?: number | null }> = [];
  const checkRequirements = (raw: unknown) => {
    const value = z.object({ strict_required_status_checks_policy: z.boolean(), required_status_checks: z.array(z.object({ context: z.string(), integration_id: z.number().nullable().optional() })) }).parse(raw);
    for (const check of value.required_status_checks) required.push({ name: check.context, app: check.integration_id });
    if (value.strict_required_status_checks_policy && pr.mergeable_state !== "clean") blocked.push("strict_checks_require_clean_base");
  };
  try {
    const rules = z.array(ruleSchema).parse(await get(`${endpoint}/rules/branches/${encodeURIComponent(pr.base.ref)}`));
    for (const rule of rules) {
      if (rule.type === "required_status_checks") checkRequirements(rule.parameters);
      else if (rule.type === "pull_request") {
        const value = pullRequestRuleParametersSchema.parse(rule.parameters);
        for (const parameter of Object.keys(value)) {
          if (!Object.hasOwn(pullRequestRuleParametersSchema.shape, parameter)) uncertain.push(`unsupported_pull_request_parameter:${parameter}`);
        }
        if (approvals.length < value.required_approving_review_count) blocked.push("required_approval_count_not_met");
        if (value.require_code_owner_review || value.require_last_push_approval) uncertain.push("review_requirements_need_authoritative_evaluation");
        if (value.required_review_thread_resolution) uncertain.push("conversation_resolution_not_evaluated");
        if (value.allowed_merge_methods?.length === 0) blocked.push("no_merge_methods_allowed");
        if (options.mergeMethod && value.allowed_merge_methods && !value.allowed_merge_methods.includes(options.mergeMethod)) blocked.push("merge_method_not_allowed");
      } else if (!["deletion", "non_fast_forward", "creation"].includes(rule.type)) uncertain.push(`unsupported_repository_rule:${rule.type}`);
    }
    const branch = z.object({ protected: z.boolean() }).parse(await get(`${endpoint}/branches/${encodeURIComponent(pr.base.ref)}`));
    if (branch.protected) {
      const protection = protectionSchema.parse(await get(`${endpoint}/branches/${encodeURIComponent(pr.base.ref)}/protection`));
      if (protection.required_status_checks) {
        for (const name of protection.required_status_checks.contexts) required.push({ name });
        for (const check of protection.required_status_checks.checks ?? []) required.push({ name: check.context, app: check.app_id });
        if (protection.required_status_checks.strict && pr.mergeable_state !== "clean") blocked.push("strict_checks_require_clean_base");
      }
      const reviewPolicy = protection.required_pull_request_reviews;
      if (reviewPolicy && approvals.length < reviewPolicy.required_approving_review_count) blocked.push("required_approval_count_not_met");
      if (reviewPolicy?.require_code_owner_reviews || reviewPolicy?.require_last_push_approval) uncertain.push("review_requirements_need_authoritative_evaluation");
      if (protection.required_signatures?.enabled || protection.required_linear_history?.enabled) uncertain.push("commit_or_merge_method_requirements_not_evaluated");
      if (protection.required_conversation_resolution?.enabled) uncertain.push("conversation_resolution_not_evaluated");
      if (protection.lock_branch?.enabled) blocked.push("base_branch_locked");
      if (protection.restrictions != null) uncertain.push("merge_actor_restrictions_not_evaluated");
    }
  } catch { uncertain.push("repository_requirements_unavailable_or_invalid"); }
  for (const requirement of required) {
    const successfulCheck = [...latestChecks.values()].some((check) => check.name === requirement.name &&
      (requirement.app == null || requirement.app === -1 || check.app?.id === requirement.app) && check.status === "completed" && check.conclusion === "success");
    const successfulStatus = requirement.app == null || requirement.app === -1 ? latestStatuses.get(requirement.name)?.state === "success" : false;
    if (!successfulCheck && !successfulStatus) blocked.push(`required_check_not_successful:${requirement.name}`);
  }
  const live = prSchema.parse(await get(`${endpoint}/pulls/${number}`));
  if (live.number !== pr.number || live.base.repo.full_name !== pr.base.repo.full_name || live.head.sha !== pr.head.sha || live.base.sha !== pr.base.sha || live.head.ref !== pr.head.ref || live.base.ref !== pr.base.ref ||
    live.state !== pr.state || live.merged !== pr.merged || live.draft !== pr.draft || live.user.login !== pr.user.login ||
    live.head.repo?.full_name !== pr.head.repo?.full_name || live.mergeable !== pr.mergeable || live.mergeable_state !== pr.mergeable_state ||
    JSON.stringify(live.labels.map((label) => label.name).sort()) !== JSON.stringify(pr.labels.map((label) => label.name).sort())) uncertain.push("pull_request_changed_during_evaluation");
  const reasons = [...new Set([...blocked, ...uncertain])];
  return { version: 1, repository, number, headSha: pr.head.sha, baseSha: pr.base.sha, observedAt: new Date().toISOString(),
    decision: uncertain.includes("pull_request_changed_during_evaluation") ? "unknown" : blocked.length ? "ineligible" : uncertain.length ? "unknown" : "eligible", reasons };
}

export async function mergeCheckCommand(args: readonly string[], get: Get): Promise<void> {
  const options: Record<string, string> = {};
  for (let index = 0; index < args.length; index++) {
    const key = args[index];
    const value = args[index + 1];
    if (key === "--json") continue;
    if (!key || !["--event-file", "--output", "--repository", "--number"].includes(key) || options[key] !== undefined || !value || value.startsWith("--")) throw new Error("Usage: mixer-automations github pr can-merge --event-file path [--output path] [--json], or --repository owner/repo --number N");
    options[key] = value; index++;
  }
  let policy = mergeCheckPolicySchema.parse({});
  let repository = options["--repository"];
  let number: unknown = options["--number"] ? Number(options["--number"]) : undefined;
  if (options["--event-file"]) {
    if (repository || number !== undefined) throw new Error("--event-file cannot be combined with --repository or --number");
    if (fs.statSync(options["--event-file"]).size > 1024 * 1024) throw new Error("Event file exceeds 1 MiB");
    const envelope = z.object({ version: z.literal(1), repository: z.string(), workflow: z.object({ extensions: z.record(z.string(), z.unknown()) }).optional(),
      event: z.object({ repository: z.string(), data: z.object({ number: z.number().int().positive(), isPullRequest: z.literal(true) }) }) }).parse(JSON.parse(fs.readFileSync(options["--event-file"], "utf8")));
    if (envelope.repository !== envelope.event.repository) throw new Error("Event repository mismatch");
    repository = envelope.repository; number = envelope.event.data.number;
    policy = mergeCheckPolicySchema.parse(envelope.workflow?.extensions["github.mergeCheck"] ?? {});
  }
  const target = z.object({ repository: z.string().regex(/^[^\s/]+\/[^\s/]+$/), number: z.number().int().positive() }).parse({ repository, number });
  const report = await checkMergeEligibility(get, target.repository, target.number, policy);
  const text = JSON.stringify(report, null, 2) + "\n";
  if (options["--output"]) fs.writeFileSync(options["--output"], text, { mode: 0o600 });
  process.stdout.write(text);
}
