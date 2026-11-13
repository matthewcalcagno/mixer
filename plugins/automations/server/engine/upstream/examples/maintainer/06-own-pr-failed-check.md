---
name: Repair failed checks on my pull requests
repository: owner/repo
agent: codex
on:
  github.check:
    events: [completed]
    where:
      all:
        - pull-request: true
        - pull-request-author: me
        - check-conclusion: [failure, timed_out, action_required]
---

Own diagnosis of the specific failed check on the triggering pull request. Start by refreshing the PR, head SHA, check suite, and workflow runs with `gh`. The webhook may be stale: do nothing if the failure belongs to an older head, a newer revision is already running, the check has passed on retry, or another maintainer has already diagnosed it.

Read the complete failing job and step logs, not only the check title or final line. Extract the failing command, test, platform, error, first relevant stack frame, and whether multiple jobs share the same cause. Inspect recent runs on the PR and base branch. When possible, compare the same job at the merge base or latest default branch to classify the failure as:

- introduced by the PR;
- exposed by the PR but rooted in existing behavior;
- already failing on the default branch;
- a flaky test with evidence from retries or historical runs;
- infrastructure, runner, network, quota, dependency-service, or cancellation failure;
- inconclusive because required logs or platform access are unavailable.

If this PR caused a fixable failure, reproduce it locally when practical, implement the smallest correction on the existing PR branch, add or improve regression coverage when the failure revealed a real gap, run focused verification, commit, and push normally. Refresh GitHub to verify the new commit and checks. Leave one concise PR update naming the failed check, root cause, fixing commit SHA, and tests run, unless direct review-thread replies already communicate the same result.

If the failure is unrelated to the PR, do not change product code to hide it. For a proven base-branch failure, link exact failing runs or revisions and an existing tracking issue; create a focused issue only if it is persistent, actionable, and not already tracked. For an evidenced transient infrastructure or flaky failure, rerun only when repository permissions and policy allow it, and avoid repeated reruns. If logs are insufficient, state the missing evidence and useful next step without guessing.

Read existing PR comments before posting and do not repeat a CI diagnosis already present. Never disable a meaningful test, weaken an assertion, add arbitrary sleeps or retries, update snapshots blindly, create another PR, force-push, merge, expose secrets from logs, or ask for terminal input. Use direct prose, exact check/run links, commit SHAs, and test results; no emojis or generic status commentary. Record the classification, evidence, actions, new head, and remaining checks in case memory.
