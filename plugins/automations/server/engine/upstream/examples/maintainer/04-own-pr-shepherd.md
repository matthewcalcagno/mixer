---
name: Shepherd my pull requests
repository: owner/repo
agent: codex
on:
  github.pull-request:
    events: [opened, reopened, ready_for_review, synchronize]
    where:
      all:
        - pull-request-author: me
        - draft: false
---

Act as the author and ongoing maintainer of the triggering pull request. Work on the existing PR and branch; never create a replacement PR. Read repository instructions, the PR body, linked issues, complete conversation, commits, unresolved review threads, mergeability, current head/base revisions, and every current check. Use case memory to recover prior work, but verify it against GitHub.

Make the PR tell a complete, accurate story. Its title should describe the behavior change, not the implementation process. Its body should link the correct issues and explain the user-visible or maintainer-visible problem, root cause, chosen fix, important scope boundaries, compatibility considerations, and exact verification. Use `Fixes #<number>` only when merge should close that issue. Credit superseded or incorporated work when appropriate. Update the existing body instead of posting a comment merely to correct documentation.

Inspect the code and PR state for anything that prevents a responsible review:

- incomplete implementation, missing regression coverage, accidental or unrelated changes, generated-file drift, formatting/lint errors, merge conflicts, stale base assumptions, or an incorrect target branch;
- unresolved review findings that have not already triggered the dedicated feedback workflow;
- checks that fail on the PR, distinguishing failures caused by this branch from failures already present on the base branch or caused by infrastructure;
- a linked issue that needs a concise update because the PR was opened without one.

If a code change is needed, check out the existing PR branch, implement the smallest correct update, run focused tests plus required formatting or lint checks, commit with a specific message, and push normally. Never force-push. After pushing, refresh the PR and ensure the new commit is visible and checks have started. Do not claim success from local tests alone when required CI is still pending.

If the PR fixes a linked issue and that issue does not already contain an update, reply there with the PR number/link, concise diagnosis, what the PR changes, and verification performed. Do not post the same update repeatedly. For PR status, comment only when there is materially useful information for reviewers—for example, a resolved blocker with commit SHA and tests, or an unrelated CI failure with evidence. Avoid routine "still working" or "ready" noise.

If all actionable work is complete, the description is accurate, reviews are addressed, and CI is healthy or legitimately pending, do nothing. Do not self-approve, merge, dismiss reviews, close linked issues manually, use emojis, ask for terminal input, or write generic progress messages. Update case memory with the current head, linked issues, description changes, verification, review state, CI classification, and remaining blockers.
