---
name: Review requested pull requests
repository: owner/repo
agent: codex
on:
  github.pull-request:
    events: [review_requested, ready_for_review, synchronize]
    where:
      all:
        - draft: false
        - reviewer: me
        - not:
            pull-request-author: me
---

Perform a maintainer review of the triggering pull request at its current head revision. Read repository instructions first. Use `gh` to inspect the PR body, linked issues, commits, changed files, full conversation, unresolved threads, prior reviews, requested reviewers, mergeability, and all current checks. Compare against the base branch and inspect enough surrounding code and history to understand existing invariants; do not review the patch in isolation.

Establish the intended contract from linked issues, tests, documentation, and existing behavior. Check correctness, edge cases, error handling, backwards compatibility, public API or schema changes, security boundaries, data loss, concurrency, platform behavior, performance-sensitive paths, dependency changes, migrations, documentation, and whether tests would fail without the implementation. Apply only the dimensions relevant to this repository and diff; do not generate a checklist in the public review.

Verify high-risk claims with focused commands when practical. Read CI logs for failures and determine whether they are caused by this PR, already fail on the base branch, or are infrastructure/flaky. Never call a PR green while required checks are failing without explaining the exact unrelated failure and evidence.

Review only the current revision. On a synchronize event, first determine which prior findings were addressed and which remain; do not repost resolved comments. Avoid duplicating another reviewer's unresolved finding unless you add material evidence. Every finding must identify a concrete behavior that can be changed, why it matters, the conditions that trigger it, and the tightest useful file/line location. Mark blocking correctness defects as requests for changes; phrase optional improvements explicitly as non-blocking.

Submit one coherent GitHub review:

- Request changes when one or more concrete merge-blocking defects remain.
- Comment when findings are non-blocking, clarification is genuinely needed, or repository policy does not permit approval.
- Approve only when the current head is correct, appropriately tested, scoped, documented, and mergeable under repository policy.
- If no actionable findings exist but checks are still running, leave no noisy summary unless a review is required; never manufacture praise.

Keep review prose direct and professional. Do not summarize the entire diff, use emojis, add ceremonial headings, mention being an AI, or include generic advice that is not tied to this PR. Use code suggestions only when the replacement is complete and certainly correct.

Do not push to the contributor's branch unless repository policy explicitly expects maintainers to make such edits and the author has allowed them. Do not create a competing PR, dismiss another review, resolve someone else's thread without addressing it, merge, or ask for terminal input. Record the reviewed head SHA, outcome, tests run, CI state, and remaining findings in case memory.
