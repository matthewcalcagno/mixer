import { describe, expect, it } from "vitest";
import type { Event } from "@mixer/automations-sdk";
import { isSelfAuthoredGitHubEvent, needsActiveRunSelfGuard, normalizeGitHubRepositoryEvent, normalizeGitHubWebhookEvent } from "./index.js";
import { evaluateGitHubTrigger, githubTriggerSchema, matchesGitHubTrigger } from "./matcher.js";

describe("GitHub trigger matching", () => {
  const feedback = { action: "created", author: "copilot-pull-request-reviewer[bot]", pullRequestAuthor: "octocat",
    reviewState: "COMMENTED", state: "open", draft: true, merged: false, labels: ["automation"] };
  const reconciling = { events: ["created"], reconcile: true, where: { all: [
    { author: "copilot-pull-request-reviewer[bot]" }, { "pull-request-author": "me" },
    { "review-state": "commented" }, { draft: false }, { state: "open" }, { labels: { all: ["automation"], none: ["ignore"] } },
  ] } };

  it("defers draft reviews and matches them after readiness without changing the event action", () => {
    expect(evaluateGitHubTrigger(feedback, reconciling, { login: "octocat" })).toBe("defer");
    expect(evaluateGitHubTrigger({ ...feedback, draft: false }, reconciling, { login: "octocat" })).toBe("match");
    expect(evaluateGitHubTrigger(feedback, { ...reconciling, reconcile: false }, { login: "octocat" })).toBe("ignore");
  });

  it("defers missing labels but never defers another author's review or the wrong action", () => {
    expect(evaluateGitHubTrigger({ ...feedback, draft: false, labels: [] }, reconciling, { login: "octocat" })).toBe("defer");
    expect(evaluateGitHubTrigger({ ...feedback, author: "someone-else" }, reconciling, { login: "octocat" })).toBe("ignore");
    expect(evaluateGitHubTrigger({ ...feedback, action: "updated" }, reconciling, { login: "octocat" })).toBe("ignore");
    expect(evaluateGitHubTrigger({ ...feedback, merged: true }, reconciling, { login: "octocat" })).toBe("ignore");
  });

  it("preserves nested any and not when deciding whether eligibility can change", () => {
    expect(evaluateGitHubTrigger(feedback, { reconcile: true, where: { not: { any: [
      { author: "copilot-pull-request-reviewer[bot]" }, { labels: { all: ["ignore"] } },
    ] } } })).toBe("ignore");
    expect(evaluateGitHubTrigger(feedback, { reconcile: true, where: { not: { all: [
      { author: "copilot-pull-request-reviewer[bot]" }, { draft: true },
    ] } } })).toBe("defer");
    expect(evaluateGitHubTrigger({ ...feedback, draft: false }, { reconcile: true, where: { not: { all: [
      { author: "copilot-pull-request-reviewer[bot]" }, { draft: true },
    ] } } })).toBe("match");
  });
  const issue = {
    action: "opened",
    author: "octocat",
    actor: "maintainer",
    title: "Parser crashes on empty input",
    body: "A reproducible parser failure",
    state: "open",
    authorAssociation: "CONTRIBUTOR",
    labels: ["bug", "priority-high"],
    number: 42,
  };

  it("combines event, label, and author predicates with all", () => {
    expect(matchesGitHubTrigger(issue, {
      events: ["opened"],
      where: {
        all: [
          { labels: { any: ["bug"] } },
          { author: { equals: "OctoCat" } },
          { number: { gte: 40, lt: 50 } },
        ],
      },
    })).toBe(true);
  });

  it("supports nested any and not chains", () => {
    expect(matchesGitHubTrigger(issue, {
      where: {
        all: [
          { any: [{ title: { "starts-with": "parser" } }, { labels: { all: ["security"] } }] },
          { not: { author: { "ends-with": "[bot]" } } },
          { labels: { none: ["wontfix"] } },
        ],
      },
    })).toBe(true);
  });

  it("supports safe regular expressions and negative matches", () => {
    expect(matchesGitHubTrigger(issue, {
      where: {
        all: [
          { title: { matches: "^(parser|lexer)\\s+crashes" } },
          { body: { "not-matches": "works as intended" } },
        ],
      },
    })).toBe(true);
    expect(githubTriggerSchema.safeParse({ where: { title: { matches: "(?=unsafe)" } } }).success).toBe(false);
  });

  it("matches pull request branches and relations", () => {
    const pullRequest = {
      action: "synchronize",
      author: "developer",
      labels: ["ready-for-review"],
      headBranch: "feature/parser-v2",
      baseBranch: "main",
      headRepository: "owner/repo",
      baseRepository: "owner/repo",
      draft: false,
      merged: false,
      fork: false,
      changedFiles: 8,
    };
    expect(matchesGitHubTrigger(pullRequest, {
      types: ["opened", "synchronize"],
      names: ["ready-for-review"],
      where: {
        all: [
          { "head-branch": { "starts-with": "feature/" } },
          { "base-branch": { "not-one-of": ["legacy", "release-v1"] } },
          { "branch-relation": "different", draft: false, fork: false },
          { "changed-files": { lte: 10 } },
        ],
      },
    })).toBe(true);
  });

  it("matches the label that caused a lifecycle event independently of current labels", () => {
    const pullRequest = {
      action: "labeled",
      eventLabel: "mcalcagno:auto-qa",
      labels: ["release-type/current", "mcalcagno:auto-qa"],
    };
    expect(matchesGitHubTrigger(pullRequest, {
      events: ["labeled"],
      where: { "event-label": "mcalcagno:auto-qa" },
    })).toBe(true);
    expect(matchesGitHubTrigger({ ...pullRequest, eventLabel: "release-type/current" }, {
      events: ["labeled"],
      where: { "event-label": "mcalcagno:auto-qa" },
    })).toBe(false);
  });

  it("distinguishes pull-request conversation comments from ordinary issues", () => {
    expect(matchesGitHubTrigger({ ...issue, isPullRequest: true }, { where: { "pull-request": true } })).toBe(true);
    expect(matchesGitHubTrigger({ ...issue, isPullRequest: false }, { where: { "pull-request": true } })).toBe(false);
  });

  it("resolves the PAT account and GitHub teams in identity predicates", () => {
    const comment = {
      action: "created",
      author: "reviewer",
      actor: "reviewer",
      pullRequestAuthor: "maintainer",
      requestedReviewers: ["maintainer"],
      requestedTeams: ["acme/platform"],
      replyToAuthor: "maintainer",
      body: "Could @maintainer and @acme/platform take a look?",
      isPullRequest: true,
    };
    const identity = { login: "Maintainer" };

    expect(matchesGitHubTrigger(comment, { where: { "pull-request-author": "me" } }, identity)).toBe(true);
    expect(matchesGitHubTrigger(comment, { where: { reviewer: "me" } }, identity)).toBe(true);
    expect(matchesGitHubTrigger(comment, { where: { reviewer: "acme/platform" } }, identity)).toBe(true);
    expect(matchesGitHubTrigger(comment, { where: { mentioned: ["me", "acme/security"] } }, identity)).toBe(true);
    expect(matchesGitHubTrigger(comment, { where: { mentioned: "acme/platform" } }, identity)).toBe(true);
    expect(matchesGitHubTrigger(comment, { where: { "reply-to": "me" } }, identity)).toBe(true);
    expect(matchesGitHubTrigger(comment, { where: { "reply-to": "someone-else" } }, identity)).toBe(false);
    expect(matchesGitHubTrigger(comment, { where: { "pull-request-author": "someone-else" } }, identity)).toBe(false);
  });

  it("does not treat me as a literal login when PAT identity is unavailable", () => {
    expect(matchesGitHubTrigger({ author: "me" }, { where: { author: "me" } })).toBe(false);
  });

  it.each(["draft", "merged", "fork"] as const)("requires evidence for an explicit %s boolean condition", (field) => {
    const config = { where: { [field]: false } };
    expect(matchesGitHubTrigger({}, config)).toBe(false);
    expect(matchesGitHubTrigger({ [field]: true }, config)).toBe(false);
    expect(matchesGitHubTrigger({ [field]: false }, config)).toBe(true);
  });

  it.each([
    ["maintainer", "issue-reply: Include the hook.", true],
    ["maintainer", "issue-reply:\nInclude the hook.", true],
    ["maintainer", "Ordinary maintainer reply.", false],
    ["maintainer", "/reply Include the hook.", false],
    ["maintainer", "issue-reply:later", false],
    ["contributor", "An answer without a mention.", true],
  ])("routes a follow-up comment from %s with body %j", (author, body, expected) => {
    expect(matchesGitHubTrigger({ author, body, action: "created", isPullRequest: false, labels: ["auto-issue"] }, {
      events: ["created"], where: { all: [
        { "pull-request": false }, { labels: { any: ["auto-issue"], none: ["roboplane-ignore"] } },
        { any: [{ not: { author: "me" } }, { all: [{ author: "me" }, { body: { matches: "^issue-reply:(\\s|$)" } }] }] },
      ] },
    }, { login: "maintainer" })).toBe(expected);
  });

  it("rejects ambiguous and unknown matcher configuration", () => {
    expect(githubTriggerSchema.safeParse({ events: ["opened"], types: ["opened"] }).success).toBe(false);
    expect(githubTriggerSchema.safeParse({ where: { author: { equals: "a", contains: "b" } } }).success).toBe(false);
    expect(githubTriggerSchema.safeParse({ where: { arbitrary: { equals: "value" } } }).success).toBe(false);
  });
});

describe("GitHub event ownership", () => {
  it("recognizes the PAT account without case sensitivity", () => {
    const event = { actor: { name: "Maintainer" } } as Parameters<typeof isSelfAuthoredGitHubEvent>[0];
    expect(isSelfAuthoredGitHubEvent(event, "maintainer")).toBe(true);
    expect(isSelfAuthoredGitHubEvent(event, "contributor")).toBe(false);
    expect(isSelfAuthoredGitHubEvent(event, undefined)).toBe(false);
  });

  it("allows PAT-authored issue lifecycle events and guards recursive replies", () => {
    const issue = { actor: { name: "maintainer" }, type: "github.issue", data: { action: "reopened", number: 4 } } as Event;
    const comment = { ...issue, type: "github.issue.comment", data: { action: "created", number: 4 } } as Event;
    const synchronize = { ...issue, type: "github.pull-request", data: { action: "synchronize", number: 4 } } as Event;
    expect(needsActiveRunSelfGuard(issue, "maintainer")).toBe(false);
    expect(needsActiveRunSelfGuard(comment, "maintainer")).toBe(true);
    expect(needsActiveRunSelfGuard(synchronize, "maintainer")).toBe(true);
    expect(needsActiveRunSelfGuard(comment, "someone-else")).toBe(false);
  });
});

describe("GitHub event normalization", () => {
  it.each([
    { state: "open", merged: undefined, expected: false },
    { state: "closed", merged: undefined, expected: undefined },
    { state: undefined, merged: undefined, expected: undefined },
    { state: "closed", merged: true, expected: true },
    { state: "closed", merged: false, expected: false },
    { state: "open", merged: true, expected: true },
  ])("normalizes merged state from $state and $merged without defaulting unknown states", ({ state, merged, expected }) => {
    const event = normalizeGitHubRepositoryEvent({
      id: "101", type: "PullRequestEvent",
      payload: { action: "synchronize", pull_request: { number: 7, state, merged } },
    }, "owner/repo");
    expect(event).toMatchObject({
      type: "github.pull-request",
      data: { number: 7, merged: expected, pullRequest: { number: 7, merged: expected } },
    });
  });

  it("normalizes exact issue actions and fields", () => {
    const event = normalizeGitHubRepositoryEvent({
      id: "100",
      type: "IssuesEvent",
      created_at: "2026-01-01T00:00:00Z",
      actor: { id: 1, login: "maintainer" },
      payload: {
        action: "labeled",
        label: { name: "bug" },
        issue: {
          number: 42,
          title: "Failure",
          body: "Details",
          state: "open",
          user: { login: "octocat" },
          labels: [{ name: "bug" }],
        },
      },
    }, "owner/repo");
    expect(event).toMatchObject({
      id: "github:owner/repo:100",
      type: "github.issue",
      repository: "owner/repo",
      data: { action: "labeled", author: "octocat", actor: "maintainer", labels: ["bug"], eventLabel: "bug" },
    });
  });

  it("normalizes pull request branch and fork metadata", () => {
    const event = normalizeGitHubRepositoryEvent({
      id: "101",
      type: "PullRequestEvent",
      actor: { login: "reviewer" },
      payload: {
        action: "synchronize",
        pull_request: {
          number: 7,
          title: "Feature",
          user: { login: "developer" },
          head: { ref: "feature/x", repo: { id: 2, full_name: "fork/repo" } },
          base: { ref: "main", repo: { id: 1, full_name: "owner/repo" } },
          draft: false,
          changed_files: 3,
          requested_reviewers: [{ login: "maintainer" }],
          requested_teams: [{ slug: "platform", organization: { login: "owner" } }],
        },
      },
    }, "owner/repo");
    expect(event).toMatchObject({
      type: "github.pull-request",
      data: {
        action: "synchronize",
        headBranch: "feature/x",
        baseBranch: "main",
        fork: true,
        draft: false,
        changedFiles: 3,
        pullRequestAuthor: "developer",
        requestedReviewers: ["maintainer"],
        requestedTeams: ["owner/platform"],
      },
    });
  });

  it("normalizes the label that caused a pull request lifecycle event", () => {
    const event = normalizeGitHubWebhookEvent({
      action: "labeled",
      sender: { login: "maintainer" },
      label: { name: "mcalcagno:auto-qa" },
      pull_request: {
        number: 7,
        state: "open",
        user: { login: "developer" },
        labels: [{ name: "release-type/current" }, { name: "mcalcagno:auto-qa" }],
        head: { ref: "feature", sha: "a".repeat(40), repo: { id: 1, full_name: "owner/repo" } },
        base: { ref: "main", sha: "b".repeat(40), repo: { id: 1, full_name: "owner/repo" } },
      },
    }, "pull_request", "delivery-label", "owner/repo");
    expect(event).toMatchObject({
      type: "github.pull-request",
      data: { action: "labeled", eventLabel: "mcalcagno:auto-qa", labels: ["release-type/current", "mcalcagno:auto-qa"] },
    });
  });

  it("preserves exact PR revisions and comment identity", () => {
    const sha = "a".repeat(40);
    const event = normalizeGitHubWebhookEvent({
      action: "created",
      sender: { id: 2, login: "reviewer" },
      repository: { full_name: "owner/repo" },
      issue: { number: 8, title: "Fix", pull_request: { url: "https://api.github.com/repos/owner/repo/pulls/8" } },
      pull_request: {
        number: 8, title: "Fix", state: "open", user: { login: "developer" },
        head: { ref: "feature", sha, repo: { id: 1, full_name: "owner/repo" } },
        base: { ref: "main", sha: "b".repeat(40), repo: { id: 1, full_name: "owner/repo" } },
      },
      comment: { id: 55, node_id: "IC_55", body: "I updated this", in_reply_to_id: 44 },
    }, "pull_request_review_comment", "delivery-1", "owner/repo");
    expect(event).toMatchObject({
      id: "github:owner/repo:delivery-1", type: "github.pr.comment",
      data: { headSha: sha, headRepository: "owner/repo", commentId: 55, commentKind: "review", replyToCommentId: 44 },
    });
  });

  it("preserves submitted review identity for aggregate activation", () => {
    const event = normalizeGitHubWebhookEvent({
      action: "submitted",
      sender: { id: 2, login: "reviewer" },
      repository: { full_name: "owner/repo" },
      pull_request: {
        number: 8, title: "Fix", state: "open", user: { login: "developer" },
        head: { ref: "feature", sha: "a".repeat(40), repo: { id: 1, full_name: "owner/repo" } },
        base: { ref: "main", sha: "b".repeat(40), repo: { id: 1, full_name: "owner/repo" } },
      },
      review: { id: 77, node_id: "PRR_77", state: "commented", body: "" },
    }, "pull_request_review", "delivery-review", "owner/repo");
    expect(event).toMatchObject({
      type: "github.pr.review",
      data: { action: "created", reviewId: 77, reviewNodeId: "PRR_77", reviewState: "commented" },
    });
  });

  it("binds check runs to their pull request when GitHub supplies one", () => {
    const sha = "c".repeat(40);
    const event = normalizeGitHubWebhookEvent({
      action: "completed",
      sender: { id: 2, login: "github-actions[bot]" },
      repository: { full_name: "owner/repo" },
      check_run: {
        name: "tests", status: "completed", conclusion: "failure", head_sha: sha,
        pull_requests: [{ number: 12 }],
      },
    }, "check_run", "delivery-check", "owner/repo");
    expect(event).toMatchObject({
      type: "github.check",
      data: { action: "completed", number: 12, isPullRequest: true, headSha: sha, checkConclusion: "failure" },
    });
  });
});
