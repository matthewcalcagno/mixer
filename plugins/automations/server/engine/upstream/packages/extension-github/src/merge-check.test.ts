import { describe, expect, it } from "vitest";
import { checkMergeEligibility, mergeCheckPolicySchema } from "./merge-check.js";

const head = "a".repeat(40);
const base = "b".repeat(40);
const pullRequest = () => ({ number: 42, state: "open", merged: false, draft: false, user: { login: "maintainer" },
  labels: [{ name: "auto" }], head: { sha: head, ref: "fix", repo: { full_name: "owner/repo" } },
  base: { sha: base, ref: "main", repo: { full_name: "owner/repo" } }, mergeable: true, mergeable_state: "clean" });
const passingCheck = () => ({ id: 1, name: "SonarCloud Code Analysis", head_sha: head, status: "completed", conclusion: "success", app: { id: 7 } });
const approval = () => ({ id: 1, state: "APPROVED", commit_id: head, user: { login: "reviewer" } });
const policy = mergeCheckPolicySchema.parse({ allowedAuthors: ["maintainer"], requiredLabels: ["auto"] });
const reviewRuleParameters = () => ({
  required_approving_review_count: 1,
  require_code_owner_review: true,
  require_last_push_approval: false,
  dismiss_stale_reviews_on_push: true,
  required_review_thread_resolution: false,
  allowed_merge_methods: ["merge", "squash", "rebase"],
  required_reviewers: [],
  dismissal_restriction: { enabled: false, allowed_actors: [] },
  require_extra_approval_for_unattributed_changes: true,
});

async function evaluate(options: {
  pr?: Record<string, unknown>; checks?: unknown[]; statuses?: unknown[]; reviews?: unknown[];
  rules?: unknown[]; protected?: boolean; protection?: unknown; live?: Record<string, unknown>;
  requirementsError?: boolean; paginated?: boolean;
} = {}) {
  let reads = 0;
  const requests: string[] = [];
  const get = async (endpoint: string): Promise<unknown> => {
    requests.push(endpoint);
    if (endpoint.endsWith("/pulls/42")) return { ...pullRequest(), ...(reads++ ? options.live ?? options.pr : options.pr) };
    if (endpoint.includes("/check-runs")) {
      const checks = options.checks ?? [passingCheck()];
      if (options.paginated && endpoint.endsWith("page=1")) return { total_count: 101, check_runs: Array.from({ length: 100 }, (_, index) => ({ ...passingCheck(), id: index + 1, name: `check-${index}` })) };
      return { total_count: options.paginated ? 101 : checks.length, check_runs: checks };
    }
    if (endpoint.includes("/statuses?")) return options.statuses ?? [];
    if (endpoint.includes("/reviews?")) return options.reviews ?? [approval()];
    if (options.requirementsError) throw new Error("Forbidden");
    if (endpoint.includes("/rules/branches/")) return options.rules ?? [];
    if (endpoint.endsWith("/protection")) return options.protection ?? {};
    if (endpoint.includes("/branches/")) return { protected: options.protected ?? false };
    throw new Error(`Unexpected read: ${endpoint}`);
  };
  return { report: await checkMergeEligibility(get, "owner/repo", 42, policy), requests };
}

describe("read-only merge eligibility", () => {
  it("reports eligible only with complete passing evidence", async () => {
    const { report, requests } = await evaluate();
    expect({ decision: report.decision, reasons: report.reasons, head: report.headSha }).toEqual({ decision: "eligible", reasons: [], head });
    expect(requests.filter((request) => request.endsWith("/pulls/42"))).toHaveLength(2);
  });
  it.each([
    ["closed", { state: "closed" }, "pull_request_not_open"],
    ["merged", { merged: true }, "pull_request_not_open"],
    ["draft", { draft: true }, "pull_request_draft"],
    ["wrong author", { user: { login: "other" } }, "author_not_allowed"],
    ["missing label", { labels: [] }, "required_label_missing"],
    ["ignored", { labels: [{ name: "auto" }, { name: "roboplane-ignore" }] }, "excluded_label_present"],
    ["fork", { head: { sha: head, ref: "fix", repo: { full_name: "other/repo" } } }, "fork_or_missing_head_repository"],
    ["conflict", { mergeable: false }, "merge_conflict"],
    ["behind", { mergeable_state: "behind" }, "merge_state_behind"],
  ])("rejects %s", async (_name, pr, reason) => {
    const { report } = await evaluate({ pr }); expect(report.decision).toBe("ineligible"); expect(report.reasons).toContain(reason);
  });
  it.each(["failure", "cancelled", "timed_out", "action_required", "neutral", "skipped"])("does not accept a %s quality gate", async (conclusion) => {
    const { report } = await evaluate({ checks: [{ ...passingCheck(), conclusion }] }); expect(report.decision).toBe("ineligible");
  });
  it("does not accept pending checks", async () => {
    const { report } = await evaluate({ checks: [{ ...passingCheck(), status: "in_progress", conclusion: null }] }); expect(report.decision).toBe("ineligible");
  });
  it("reports missing quality gates as unknown", async () => {
    const { report } = await evaluate({ checks: [{ ...passingCheck(), name: "build" }] }); expect(report.decision).toBe("unknown");
  });
  it("requires at least one check or status", async () => {
    const { report } = await evaluate({ checks: [] }); expect(report.reasons).toContain("no_checks_or_statuses");
  });
  it.each([
    ["no reviews", []],
    ["stale approval", [{ ...approval(), commit_id: base }]],
    ["dismissed approval", [{ ...approval(), state: "DISMISSED" }]],
    ["author approval", [{ ...approval(), user: { login: "maintainer" } }]],
    ["superseded approval", [approval(), { ...approval(), id: 2, state: "CHANGES_REQUESTED" }]],
  ])("rejects %s", async (_name, reviews) => {
    const { report } = await evaluate({ reviews }); expect(report.decision).toBe("ineligible");
  });
  it("does not let a comment erase an approval", async () => {
    const { report } = await evaluate({ reviews: [approval(), { ...approval(), id: 2, state: "COMMENTED" }] }); expect(report.decision).toBe("eligible");
  });
  it("uses latest status instead of a superseded failure", async () => {
    const { report } = await evaluate({ statuses: [{ id: 1, context: "build", state: "failure", sha: head }, { id: 2, context: "build", state: "success", sha: head }] }); expect(report.decision).toBe("eligible");
  });
  it("accepts real REST status objects without a redundant SHA field", async () => {
    const { report } = await evaluate({ statuses: [{ id: 1, context: "build", state: "success" }] }); expect(report.decision).toBe("eligible");
  });
  it("reports unresolved conversation requirements as unknown", async () => {
    const { report } = await evaluate({ protected: true, protection: { required_conversation_resolution: { enabled: true } } }); expect(report.decision).toBe("unknown");
  });
  it("paginates checks before deciding", async () => {
    const { report, requests } = await evaluate({ paginated: true }); expect(report.decision).toBe("eligible"); expect(requests.some((request) => request.includes("check-runs") && request.endsWith("page=2"))).toBe(true);
  });
  it("does not claim eligibility when rules cannot be read", async () => {
    const { report } = await evaluate({ requirementsError: true }); expect(report.decision).toBe("unknown");
  });
  it("does not claim eligibility for unsupported rules", async () => {
    const { report } = await evaluate({ rules: [{ type: "merge_queue" }] }); expect(report.decision).toBe("unknown");
  });
  it("reports unsupported review-rule parameters without treating a valid GitHub rule as malformed", async () => {
    const { report } = await evaluate({ rules: [{ type: "pull_request", parameters: reviewRuleParameters() }] });
    expect({ decision: report.decision, reasons: report.reasons }).toEqual({
      decision: "unknown",
      reasons: [
        "unsupported_pull_request_parameter:required_reviewers",
        "unsupported_pull_request_parameter:dismissal_restriction",
        "unsupported_pull_request_parameter:require_extra_approval_for_unattributed_changes",
        "review_requirements_need_authoritative_evaluation",
      ],
    });
  });
  it("continues evaluating required checks after unsupported review-rule parameters", async () => {
    const { report } = await evaluate({ rules: [
      { type: "pull_request", parameters: reviewRuleParameters() },
      { type: "required_status_checks", parameters: {
        strict_required_status_checks_policy: true, required_status_checks: [{ context: "required-build" }],
      } },
    ] });
    expect(report.decision).toBe("ineligible");
    expect(report.reasons).toContain("required_check_not_successful:required-build");
    expect(report.reasons).not.toContain("repository_requirements_unavailable_or_invalid");
  });
  it("does not silently accept an unknown future review requirement", async () => {
    const { report } = await evaluate({ rules: [{ type: "pull_request", parameters: {
      required_approving_review_count: 1, require_code_owner_review: false, require_last_push_approval: false,
      future_approval_requirement: true,
    } }] });
    expect({ decision: report.decision, reasons: report.reasons }).toEqual({
      decision: "unknown", reasons: ["unsupported_pull_request_parameter:future_approval_requirement"],
    });
  });
  it("still rejects malformed known review requirements", async () => {
    const { report } = await evaluate({ rules: [{ type: "pull_request", parameters: {
      ...reviewRuleParameters(), required_approving_review_count: "one",
    } }] });
    expect({ decision: report.decision, reasons: report.reasons }).toEqual({
      decision: "unknown", reasons: ["repository_requirements_unavailable_or_invalid"],
    });
  });
  it("rejects a missing required check", async () => {
    const { report } = await evaluate({ rules: [{ type: "required_status_checks", parameters: { strict_required_status_checks_policy: false, required_status_checks: [{ context: "required-build", integration_id: 8 }] } }] }); expect(report.reasons).toContain("required_check_not_successful:required-build");
  });
  it("does not allow skipped required checks", async () => {
    const { report } = await evaluate({ checks: [passingCheck(), { ...passingCheck(), id: 2, name: "build", conclusion: "skipped" }], protected: true,
      protection: { required_status_checks: { strict: false, contexts: ["build"] } } }); expect(report.decision).toBe("ineligible");
  });
  it("does not invent a code-owner approval decision", async () => {
    const { report } = await evaluate({ protected: true, protection: { required_pull_request_reviews: { required_approving_review_count: 1, require_code_owner_reviews: true } } }); expect(report.decision).toBe("unknown");
  });
  it("reports races as unknown", async () => {
    const { report } = await evaluate({ live: { head: { sha: "c".repeat(40), ref: "fix", repo: { full_name: "owner/repo" } } } }); expect(report.decision).toBe("unknown"); expect(report.reasons).toContain("pull_request_changed_during_evaluation");
  });
});
