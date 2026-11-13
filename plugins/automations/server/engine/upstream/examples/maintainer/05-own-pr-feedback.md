---
name: Resolve feedback on my pull requests
repository: owner/repo
agent: codex
on:
  github.issue.comment:
    events: [created]
    where:
      all:
        - pull-request: true
        - pull-request-author: me
        - not:
            author: me
  github.pr.comment:
    events: [created]
    where:
      all:
        - pull-request-author: me
        - not:
            author: me
  github.pr.review:
    events: [submitted, edited]
    where:
      all:
        - pull-request-author: me
        - review-state: [changes_requested, commented]
        - not:
            author: me
---

Own the newly submitted feedback on the triggering pull request through a verified GitHub response. Read repository instructions, the exact triggering comment or review, its surrounding thread, the complete PR conversation, all unresolved review threads, current head SHA, current diff, linked issues, and relevant code and tests. Determine what the reviewer is actually asking; do not respond from a truncated event payload or keyword match.

Evaluate each new actionable point independently. Check whether it is correct for the current revision, already addressed by a later commit, duplicates another open thread, conflicts with repository conventions, is explicitly optional, or falls outside this PR's intended scope. When a review contains multiple findings, handle all new findings from that review coherently, but do not sweep unrelated old feedback into the run.

For feedback that should change the code:

1. Check out the existing PR branch and confirm its remote head has not moved unexpectedly.
2. Implement the smallest complete correction without undoing unrelated work.
3. Add or update regression coverage that demonstrates the concern when practical.
4. Run the exact focused tests plus relevant formatting, lint, or type checks. Never invent a passing result.
5. Commit with a specific message and push normally to the same branch. Never create a second PR or force-push.
6. Refresh GitHub and verify the commit is present.
7. Reply directly in the relevant thread with what changed, the short commit SHA, and the meaningful tests run. If one commit addresses several review comments, reply to each affected thread with the part relevant to that thread rather than posting one vague top-level message.
8. Resolve an inline thread only after the concern is fully addressed and the pushed commit is visible. Leave it open if a reviewer decision is still needed.

For feedback that should not change the code, reply briefly with concrete evidence: point to the existing behavior, test, API contract, linked issue, scope decision, or later commit. If the feedback is valid but intentionally deferred, say why it is outside this PR and link or create a follow-up issue only when it represents real work. Do not dismiss feedback merely because the requested change is inconvenient.

After changes, update the PR description when the implementation, scope, verification, or linked issues materially changed. Check current CI: report only failures relevant to the feedback, and distinguish unrelated base-branch or infrastructure failures with exact run evidence. Do not announce that everything is resolved if threads or checks remain open.

Public replies should sound like a maintainer: `Updated in abc1234 — <specific change>. <specific tests> pass.` is better than a long template. Use minimal Markdown, no emojis, no generic thanks-only acknowledgment, no "as an AI," and no repeated summaries. Do not merge, approve your own PR, dismiss reviews, or ask for terminal input. Update case memory with every decision, pushed commit, reply, test result, resolved thread, and remaining blocker.
