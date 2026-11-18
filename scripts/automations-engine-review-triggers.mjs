// Keep review admission changes reproducible when refreshing the engine snapshot.
export function adaptGitHubReviewTriggers(file, text) {
  const replace = (before, after) => {
    if (!text.includes(before))
      throw new Error(`Review the upstream GitHub review-trigger seam in ${file}: ${before}`);
    text = text.replace(before, after);
  };
  if (file === "packages/extension-github/src/matcher.ts") {
    replace("function matchesEventFacts(", "export function matchesEventFacts(");
    replace(
      "  reviewer: stringMatcherSchema.optional(),",
      '  reviewer: stringMatcherSchema.optional(),\n  "approved-by": stringMatcherSchema.optional(),\n  "reviewed-by": stringMatcherSchema.optional(),',
    );
    replace(
      "  requestedReviewers?: string[];",
      "  requestedReviewers?: string[];\n  approvedBy?: string[];\n  reviewedBy?: string[];",
    );
    replace(
      "  if (predicate.mentioned",
      `  if (predicate["approved-by"] && !matchesAnyIdentity(data.approvedBy ?? [], predicate["approved-by"], identity)) return false;
  if (predicate["reviewed-by"] && !matchesAnyIdentity(data.reviewedBy ?? [], predicate["reviewed-by"], identity)) return false;
  if (predicate.mentioned`,
    );
    replace(
      '    "branch-relation": branchRelation, "changed-files": changedFiles, ...facts } = condition;',
      '    "branch-relation": branchRelation, "changed-files": changedFiles,\n    reviewer, "approved-by": approvedBy, "reviewed-by": reviewedBy, ...facts } = condition;',
    );
    replace(
      "branchRelation, changedFiles]\n",
      "branchRelation, changedFiles, reviewer, approvedBy, reviewedBy]\n",
    );
  }
  if (file === "packages/extension-github/src/index.ts") {
    replace(
      "        state.delete(`work:started:${hook.run.id}`);",
      `        if (key && outcome.success && outcome.data.outcome === "blocked") {
          state.set(key + ":blocked", { runId: hook.run.id, expiresAt: Date.now() + Math.min(30 * 60_000, api.config.historyRetentionMs()) });
        } else if (key && outcome.success && ["acted", "no-op"].includes(outcome.data.outcome)) {
          state.delete(key + ":blocked");
        }
        state.delete(\u0060work:started:\u0024{hook.run.id}\u0060);`,
    );
    replace(
      "        const receipt = key ? state.get<{ expiresAt: number }>(key) : undefined;",
      `        const blocked = key ? state.get<{ expiresAt: number }>(key + ":blocked") : undefined;
        if (key && blocked && blocked.expiresAt <= Date.now()) state.delete(key + ":blocked");
        if (blocked && blocked.expiresAt > Date.now()) return { kind: "ignore", reason: "work_blocked_retry_pending" };
        const receipt = key ? state.get<{ expiresAt: number }>(key) : undefined;`,
    );
    replace("evaluateGitHubTrigger,", "matchesEventFacts, evaluateGitHubTrigger,");
    replace('  }, "invalid cron expression"),', '  }, "invalid cron expression").optional(),');
    replace(
      "    const nextPrSchedule = (cron: string, after: Date) => CronExpressionParser.parse(cron, { currentDate: after }).next().toDate();",
      `    const nextPrSchedule = (cron: string | undefined, after: Date) => cron
      ? CronExpressionParser.parse(cron, { currentDate: after }).next().toDate()
      : new Date(after.getTime() + duration(config.pollInterval));`,
    );
    replace(
      "const prScheduleKey = (workflowId: string, repository: string, cron: string) =>",
      "const prScheduleKey = (workflowId: string, repository: string, cron: string | undefined) =>",
    );
    replace(
      '.update(cron).digest("hex").slice(0, 12)',
      '.update(cron ?? `poll:${config.pollInterval}`).digest("hex").slice(0, 12)',
    );
    replace(
      "    const enrichPullRequestIdentity = async",
      `${reviewEnrichment}\n    const enrichPullRequestIdentity = async`,
    );
    replace(
      "        const decision = evaluateGitHubTrigger(data, trigger,",
      `        const actions = trigger.events ?? trigger.types;
        if (actions && !actions.includes(data.action ?? "")) return false;
        if (trigger.where && matchesEventFacts(data, trigger.where, { login: user.login }, event.type !== "github.check") === false) return false;
        try {
          data = await enrichReviewHistory(event.repository, data, trigger.where, operation?.signal);
        } catch (error) {
          throw new Error("GitHub review-history matching failed for workflow " + (operation?.workflowId ?? "unknown") +
            " event " + event.id + " (" + event.type + "): " + (error instanceof Error ? error.message : String(error)), { cause: error });
        }
        const decision = evaluateGitHubTrigger(data, trigger,`,
    );
    replace(
      "        const key = workReceiptKey(operation?.workflow, { ...event, data: refreshed });",
      `        const rawTrigger = operation?.workflow?.on[event.type];
        const where = event.type === "github.pr.schedule"
          ? githubConditionSchema.parse(original.scheduledWhere)
          : githubTriggerSchema.parse(rawTrigger ?? {}).where;
        Object.assign(refreshed, await enrichReviewHistory(event.repository, refreshed, where, signal));
        if (needsReviewHistory(where) && where && !matchesGitHubCondition(refreshed, where, { login: (await authenticatedUser(signal)).login })) {
          const reason = event.type === "github.pr.schedule" ? "scheduled_pr_filter_changed" : "pr_filter_changed";
          return { data: refreshed as unknown as JsonValue, decision: { kind: "skip", reason } };
        }
        const key = workReceiptKey(operation?.workflow, { ...event, data: refreshed });
        const blocked = key ? state.get<{ expiresAt: number }>(key + ":blocked") : undefined;
        if (key && blocked && blocked.expiresAt <= Date.now()) state.delete(key + ":blocked");
        if (blocked && blocked.expiresAt > Date.now()) return { data: refreshed as unknown as JsonValue, decision: { kind: "skip", reason: "work_blocked_retry_pending" } };`,
    );
    replace(
      '                const data = pullRequestData("scheduled", undefined, pullRequest);',
      '                let data = pullRequestData("scheduled", undefined, pullRequest);',
    );
    replace(
      "                if (!matchesGitHubCondition(data, where, { login: identity.login })) continue;",
      `                data = await enrichReviewHistory(repository, data, where, context.signal);
                if (!matchesGitHubCondition(data, where, { login: identity.login })) continue;`,
    );
  }
  if (file === "packages/extension-github/src/index.test.ts") {
    replace(
      'describe("scheduled pull-request runs", () => {',
      `${admissionTests}\ndescribe("scheduled pull-request runs", () => {`,
    );
    replace(
      "async function scheduledSource(values: Map<string, unknown>) {",
      'async function scheduledSource(values: Map<string, unknown>, pollInterval = "30s") {',
    );
    replace(
      'const errors: unknown[] = [];\n    const api = {\n      config: { get: () => ({ token: "test-token" }) },',
      'const errors: unknown[] = [];\n    const api = {\n      config: { get: () => ({ token: "test-token", pollInterval }) },',
    );
    replace(
      '  it("starts one activated PR run per eligible PR and not for ignored, draft, or other authors",',
      `${reviewTests}\n  it("starts one activated PR run per eligible PR and not for ignored, draft, or other authors",`,
    );
  }
  if (file === "packages/extension-github/src/trigger-reliability.test.ts") {
    replace(
      '  it("suppresses only successful equivalent snapshot work, preserving new feedback and definition changes",',
      `${blockedRetryTest}\n  it("suppresses only successful equivalent snapshot work, preserving new feedback and definition changes",`,
    );
  }
  if (file === "packages/extension-github/src/matcher.test.ts") {
    replace(
      'describe("GitHub trigger matching", () => {',
      `describe("GitHub trigger matching", () => {
  it("composes requested-reviewer and review-history predicates with me and negation", () => {
    const identity = { login: "maintainer" };
    const trigger = { where: { all: [
      { reviewer: "me" }, { not: { "approved-by": "me" } }, { not: { "reviewed-by": "me" } },
    ] } };
    const data = { requestedReviewers: ["MAINTAINER"], approvedBy: [], reviewedBy: [] };
    expect(matchesGitHubTrigger(data, trigger, identity)).toBe(true);
    expect(matchesGitHubTrigger({ ...data, approvedBy: ["Maintainer"] }, trigger, identity)).toBe(false);
    expect(matchesGitHubTrigger({ ...data, reviewedBy: ["Maintainer"] }, trigger, identity)).toBe(false);
    expect(matchesGitHubTrigger({ ...data, requestedReviewers: [] }, trigger, identity)).toBe(false);
    expect(evaluateGitHubTrigger({ ...data, approvedBy: ["maintainer"] }, { ...trigger, reconcile: true }, identity)).toBe("defer");
  });`,
    );
  }
  if (file === "docs/workflow-authoring.md") {
    replace(
      "requires a repository, a cron expression, and a GitHub `where` condition:",
      "requires a repository and a GitHub `where` condition. Omit `cron` to scan at `extensions.github.pollInterval`, or supply it for an independent schedule:",
    );
  }
  if (file === "docs/github.md") {
    replace(
      "## Account, author, reviewer, and mention filters",
      `${reviewDocumentation}\n## Account, author, reviewer, and mention filters`,
    );
  }
  return text;
}

const reviewTests = `  it("uses configured polling cadence without a cron and filters already reviewed PRs before emission", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const { source, errors } = await scheduledSource(new Map(), "45s");
    const emitted: Event[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/user")) return Response.json({ login: "maintainer", id: 1 });
      if (url.includes("/pulls?")) return Response.json([64, 65, 66, 67, 68].map(number => pr(number, { requested_reviewers: [{ login: "maintainer" }] })));
      if (url.includes("/reviews?")) {
        const approved = url.includes("/64/");
        const current = url.includes("/65/");
        const pending = url.includes("/67/");
        const state = approved ? "APPROVED" : pending ? "PENDING" : "COMMENTED";
        return Response.json([{ state, commit_id: current || pending ? "a".repeat(40) : "c".repeat(40), user: { login: "MAINTAINER" } }]);
      }
      throw new Error("unexpected request " + url);
    }));
    const controller = new AbortController();
    try {
      source.start({ type: "github.pr.schedule", signal: controller.signal,
        subscriptions: [{ type: "github.pr.schedule", workflowId: "review.md", repository: "owner/repo", config: { where: { all: [
          { reviewer: "me" }, { not: { "approved-by": "me" } }, { not: { "reviewed-by": "me" } },
        ] } } }], emit: async event => { emitted.push(event); return true; } });
      await vi.advanceTimersByTimeAsync(44_999);
      expect(emitted).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      expect(errors).toEqual([]);
      expect(emitted.map(event => (event.data as GitHubEventData).number)).toEqual([66, 67, 68]);
    } finally { controller.abort(); source.stop?.(); vi.useRealTimers(); }
  });

  it("paginates approval history and rechecks it after queueing without treating failures as no approval", async () => {
    const { source } = await scheduledSource(new Map());
    let approved = false;
    let unavailable = false;
    const where = { all: [{ reviewer: "me" }, { not: { "approved-by": "me" } }] };
    const data = { ...pr(64), number: 64, isPullRequest: true, headSha: "a".repeat(40),
      pullRequestAuthor: "author", draft: false, requestedReviewers: ["maintainer"], workflowId: "review.md", scheduledWhere: where };
    const event: Event = { id: "scheduled", type: "github.pr.schedule", source: "github", repository: "owner/repo", timestamp: new Date().toISOString(), data };
    const firstPage = Array.from({ length: 100 }, () => ({ state: "COMMENTED", commit_id: "c".repeat(40), user: { login: "someone" } }));
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/user")) return Response.json({ login: "maintainer", id: 1 });
      if (url.endsWith("/pulls/64")) return Response.json(pr(64, { requested_reviewers: [{ login: "maintainer" }] }));
      if (url.includes("/reviews?")) {
        if (unavailable) return new Response("unavailable", { status: 503 });
        if (url.endsWith("page=1")) return Response.json(firstPage);
        return Response.json(approved ? [{ state: "APPROVED", commit_id: "c".repeat(40), user: { login: "maintainer" } }] : []);
      }
      throw new Error("unexpected request " + url);
    }));
    expect(await source.match!(event, { where }, { signal: new AbortController().signal, workflowId: "review.md" })).toBe(true);
    approved = true;
    expect(await source.match!(event, { where }, { signal: new AbortController().signal, workflowId: "review.md" })).toBe(false);
    expect(await source.activate!(event)).toMatchObject({ decision: { kind: "skip", reason: "scheduled_pr_filter_changed" } });
    unavailable = true;
    await expect(source.match!(event, { where }, { signal: new AbortController().signal, workflowId: "review.md" })).rejects.toThrow("503");
  });
`;

const reviewDocumentation = `## Review workflow admission

Use frontmatter to exclude PRs before an agent starts:

\`\`\`yaml
github.execution:
  oncePerHead: true
on:
  github.pr.schedule:
    where: &needs-review
      all:
        - reviewer: me
        - state: open
        - draft: false
        - merged: false
        - not: { pull-request-author: me }
        - not: { approved-by: me }
        - not: { reviewed-by: me }
        - labels: { none: [roboplane-ignore] }
\`\`\`

Omitting \`cron\` uses \`extensions.github.pollInterval\`. An explicit cron keeps its independent cadence. The live scan discovers existing review requests and new heads even when repository-event polling does not deliver those transitions.

\`approved-by\` matches an account with an APPROVED review anywhere in the complete available history, including an older head. Dismissed approvals no longer have APPROVED state in GitHub's review API and do not match. Keep a separate publication safeguard if your policy must exclude approvals that have since been dismissed.

\`reviewed-by\` matches an account with a submitted APPROVED, COMMENTED, or CHANGES_REQUESTED review on the current head. Pending and dismissed reviews do not count. A comment-only review therefore prevents repeated review of an unchanged head, but a new commit permits another review. Both predicates accept the same identity syntax as \`reviewer\`, including case-insensitive \`me\`.

Review history is fetched only for filters that use these predicates, with complete bounded pagination. Unavailable, malformed, or truncated history fails rather than treating an unknown history as empty. Filters are checked again against live PR state and fresh reviews after queueing, before workspace creation. These checks do not authorize publication. Refresh PR state and reviews immediately before publishing as well.

For webhook installations, the same \`where\` condition can also be used on \`github.pull-request\` with \`events: [review_requested, synchronize, ready_for_review, reopened]\`. Repository-event polling does not reliably deliver those actions. Keep the live PR scan for recovery instead of replacing it with unsupported event hooks.
`;

const reviewEnrichment = `    const needsReviewHistory = (condition: import("./matcher.js").GitHubCondition | undefined): boolean => {
      if (!condition) return false;
      if ("all" in condition) return condition.all.some(needsReviewHistory);
      if ("any" in condition) return condition.any.some(needsReviewHistory);
      if ("not" in condition) return needsReviewHistory(condition.not);
      return condition["approved-by"] !== undefined || condition["reviewed-by"] !== undefined;
    };
    const reviewHistorySchema = z.array(z.object({
      state: z.enum(["APPROVED", "COMMENTED", "CHANGES_REQUESTED", "DISMISSED", "PENDING"]),
      commit_id: z.string().nullable(),
      user: z.object({ login: z.string().min(1) }).nullable(),
    }));
    const enrichReviewHistory = async (repository: string | undefined, data: GitHubEventData,
      where: import("./matcher.js").GitHubCondition | undefined, signal?: AbortSignal): Promise<GitHubEventData> => {
      if (!needsReviewHistory(where)) return data;
      // Review history does not exist for issues or checks without an associated PR.
      // Keep boolean composition intact, including OR branches and negation.
      if (!data.isPullRequest) return { ...data, approvedBy: [], reviewedBy: [] };
      if (!repository || !data.isPullRequest || !data.number || !data.headSha) {
        throw new Error("Review-history filters require an identified pull request and head");
      }
      const approvedBy: string[] = [];
      const reviewedBy: string[] = [];
      for (let page = 1; page <= 100; page++) {
        const endpoint = "/repos/" + repository + "/pulls/" + data.number + "/reviews?per_page=100&page=" + page;
        const reviews = reviewHistorySchema.parse(await request("GET", endpoint, undefined, signal));
        for (const review of reviews) {
          if (!review.user) continue;
          if (review.state === "APPROVED") approvedBy.push(review.user.login);
          if (review.commit_id === data.headSha && ["APPROVED", "COMMENTED", "CHANGES_REQUESTED"].includes(review.state)) reviewedBy.push(review.user.login);
        }
        if (reviews.length < 100) return { ...data, approvedBy, reviewedBy };
      }
      throw new Error("GitHub review history exceeded 100 pages");
    };`;

const admissionTests = `describe("review-history event admission", () => {
  it.each(["github.issue.comment", "github.check"])("rejects a non-PR %s without fetching review history", async type => {
    const sources = await setupSources();
    const fetch = vi.fn(async () => Response.json({ login: "maintainer", id: 1 }));
    vi.stubGlobal("fetch", fetch);
    const event: Event = { id: "issue", type, source: "github", repository: "owner/repo", timestamp: "now",
      data: { action: "created", isPullRequest: false, number: 42 } };
    expect(await sources.get(type)!.match!(event, { where: { all: [
      { "pull-request": true }, { "approved-by": { exists: true } },
    ] } })).toBe(false);
    expect(fetch.mock.calls).toHaveLength(1);
  });

  it("preserves any and not semantics for issue events with PR review predicates", async () => {
    const source = (await setupSources()).get("github.issue.comment")!;
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ login: "maintainer", id: 1 })));
    const event: Event = { id: "issue", type: "github.issue.comment", source: "github", repository: "owner/repo", timestamp: "now",
      data: { action: "created", isPullRequest: false, number: 42, author: "human" } };
    expect(await source.match!(event, { where: { any: [{ "approved-by": "me" }, { author: "human" }] } })).toBe(true);
    expect(await source.match!(event, { where: { not: { "approved-by": "me" } } })).toBe(true);
    expect(await source.match!(event, { where: { "approved-by": { exists: true } } })).toBe(false);
  });

  it("skips excluded actions but fails closed for an applicable PR missing its head", async () => {
    const source = (await setupSources()).get("github.issue.comment")!;
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ login: "maintainer", id: 1 })));
    const event: Event = { id: "pr", type: "github.issue.comment", source: "github", repository: "owner/repo", timestamp: "now",
      data: { action: "deleted", isPullRequest: true, number: 42, pullRequestAuthor: "author", draft: false } };
    expect(await source.match!(event, { events: ["created"], where: { "approved-by": "me" } })).toBe(false);
    await expect(source.match!(event, { where: { "approved-by": "me" } })).rejects.toThrow("identified pull request and head");
  });
});`;

const blockedRetryTest = `  it("delays blocked snapshot retries without marking work successful, and permits recovery", async () => {
    const runtime = await fixture({ publishGuard: { enabled: false }, failureReports: { enabled: false } });
    const source = runtime.registry.eventSources.get("github.pull-request")!;
    const workflow: Workflow = { id: "qa.md", path: "/qa.md", name: "QA", repository: "owner/repo", agent: "fake", execution: "host", prompt: "Inspect", on: {}, safeActions: {},
      extensions: { "github.execution": { oncePerHead: true } } };
    const event: Event = { id: "qa", type: "github.pull-request", source: "github", timestamp: new Date().toISOString(), repository: "owner/repo", data: { number: 42, isPullRequest: true } };
    const operation = { signal: new AbortController().signal, workflow };
    const activation = await source.activate!(event, operation);
    const run: Run = { id: "blocked-run", workflowId: workflow.id, repository: "owner/repo", event, activation, status: "running", createdAt: event.timestamp, updatedAt: event.timestamp };
    const activated = { ...event, data: activation.data };
    await runtime.registry.runHooks("agent:before", { event: activated, run, workflow, instructions: [], metadata: {} });
    run.status = "completed";
    await runtime.registry.runHooks("run:finalized", { event, run, workflow, instructions: [], metadata: { outcome: { outcome: "blocked", reason: "publication unavailable" } } });
    const key = workReceiptKey(workflow, activated)!;
    expect(runtime.database.state("github").get(key)).toBeUndefined();
    expect(await source.activate!(event, operation)).toMatchObject({ decision: { kind: "skip", reason: "work_blocked_retry_pending" } });
    expect(await source.match!(activated, {}, operation)).toEqual({ kind: "ignore", reason: "work_blocked_retry_pending" });
    expect(await source.activate!(event, { ...operation, workflow: { ...workflow, prompt: "Fixed publication procedure" } })).not.toHaveProperty("decision");
    expect(await source.activate!({ ...event, provenance: { kind: "replay", sourceRunId: run.id, rootRunId: run.id, sourceEventId: event.id } }, operation)).not.toHaveProperty("decision");
    runtime.database.state("github").set(key + ":blocked", { runId: run.id, expiresAt: Date.now() - 1 });
    expect(await source.activate!(event, operation)).not.toHaveProperty("decision");
    expect(runtime.database.state("github").get(key + ":blocked")).toBeUndefined();
  });`;
