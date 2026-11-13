import type { GitHubEventData } from "./github-matcher.js";

export function valueAt(payload: unknown, path: string) {
  let value = payload;
  for (const key of path.split(".")) {
    if (
      typeof value !== "object" ||
      value === null ||
      Array.isArray(value) ||
      !Object.hasOwn(value, key)
    )
      return undefined;
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}

export function githubFacts(payload: unknown): GitHubEventData {
  const text = (...paths: string[]) =>
    paths
      .map((path) => valueAt(payload, path))
      .find((value): value is string => typeof value === "string");
  const bool = (path: string) => {
    const value = valueAt(payload, path);
    return typeof value === "boolean" ? value : undefined;
  };
  const number = (...paths: string[]) =>
    paths
      .map((path) => valueAt(payload, path))
      .find((value): value is number => typeof value === "number");
  const names = (path: string, key: string) => {
    const entries = valueAt(payload, path);
    return Array.isArray(entries)
      ? entries
          .map((item) => valueAt(item, key))
          .filter((value): value is string => typeof value === "string")
      : [];
  };
  const rawAction = text("action");
  const headRepository = text("pull_request.head.repo.full_name");
  const baseRepository = text("pull_request.base.repo.full_name", "repository.full_name");
  return {
    action: rawAction === "submitted" ? "created" : rawAction,
    author: text(
      "comment.user.login",
      "review.user.login",
      "pull_request.user.login",
      "issue.user.login",
    ),
    actor: text("sender.login", "actor.login"),
    pullRequestAuthor: text("pull_request.user.login"),
    requestedReviewers: [
      ...names("pull_request.requested_reviewers", "login"),
      ...[text("requested_reviewer.login")].filter((name): name is string => !!name),
    ],
    requestedTeams: [
      ...names("pull_request.requested_teams", "slug"),
      ...[text("requested_team.slug")].filter((name): name is string => !!name),
    ],
    title: text("pull_request.title", "issue.title", "check_run.name"),
    body: text("comment.body", "review.body", "pull_request.body", "issue.body"),
    state: text("pull_request.state", "issue.state"),
    authorAssociation: text(
      "comment.author_association",
      "review.author_association",
      "pull_request.author_association",
      "issue.author_association",
    ),
    labels: [...names("pull_request.labels", "name"), ...names("issue.labels", "name")],
    headBranch: text("pull_request.head.ref"),
    baseBranch: text("pull_request.base.ref"),
    headRepository,
    baseRepository,
    reviewState: text("review.state"),
    checkConclusion: text("check_run.conclusion"),
    eventLabel: text("label.name"),
    draft: bool("pull_request.draft"),
    merged: bool("pull_request.merged"),
    fork:
      headRepository && baseRepository
        ? headRepository.toLowerCase() !== baseRepository.toLowerCase()
        : undefined,
    number: number("pull_request.number", "issue.number", "number"),
    changedFiles: number("pull_request.changed_files"),
    isPullRequest: !!(valueAt(payload, "pull_request") || valueAt(payload, "issue.pull_request")),
  };
}
