import {
  getReleaseContext,
  githubApi,
  git,
  PREVIEW_MARKER,
  renderPreview,
} from "./mixer-release-notes.mjs";

import { isMainModule } from "./is-main-module.mjs";

function eligible(pr, repo) {
  return (
    pr.state === "open" &&
    pr.base.ref === "main" &&
    pr.head.ref === "develop" &&
    pr.head.repo?.full_name === repo
  );
}

export function updateReleasePreview({
  repo,
  number,
  api = githubApi,
  runGit = git,
  contextFor = getReleaseContext,
}) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo || "")) throw new Error("Missing GITHUB_REPOSITORY");
  if (number && !/^\d+$/.test(number)) throw new Error("Invalid pull request number");
  const prs = number
    ? [api(`repos/${repo}/pulls/${number}`)]
    : api(`repos/${repo}/pulls?state=open&base=main&per_page=100`, { paginate: true });
  for (const pr of prs) {
    if (!eligible(pr, repo)) continue;
    // Fetch the commit as data; never check out or execute PR-owned files in this privileged workflow.
    runGit("fetch", "origin", pr.head.sha);
    runGit("fetch", "origin", pr.base.sha);
    const labels = pr.labels.map(({ name }) => name);
    const context = contextFor({
      source: pr.head.sha,
      labels,
      repo,
      releasePr: pr,
      additionalSource: pr.base.sha,
    });
    const body = renderPreview(context);
    if (body.length > 60000)
      throw new Error(
        "Release preview exceeds GitHub's comment limit; consolidate the PR Release notes sections",
      );
    const current = api(`repos/${repo}/pulls/${pr.number}`);
    const fingerprint = (pull) =>
      JSON.stringify([
        pull.state,
        pull.head.sha,
        pull.base.sha,
        pull.body,
        pull.labels.map(({ name }) => name).sort(),
      ]);
    if (fingerprint(current) !== fingerprint(pr)) continue;
    const comments = api(`repos/${repo}/issues/${pr.number}/comments?per_page=100`, {
      paginate: true,
    });
    const existing = comments.find(
      (comment) =>
        comment.user.login === "github-actions[bot]" && comment.body.startsWith(PREVIEW_MARKER),
    );
    if (existing?.body === body) continue;
    api(
      existing
        ? `repos/${repo}/issues/comments/${existing.id}`
        : `repos/${repo}/issues/${pr.number}/comments`,
      {
        method: existing ? "PATCH" : "POST",
        data: { body },
      },
    );
  }
}
if (isMainModule(import.meta.url))
  updateReleasePreview({
    repo: process.env.GITHUB_REPOSITORY,
    number: process.env.RELEASE_PR_NUMBER,
  });
