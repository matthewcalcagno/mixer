---
name: Review and merge Dependabot updates
repository: owner/repo
agent: codex
thinking: high
github.pullRequests:
  branchUpdates:
    allowedAuthors: ["dependabot[bot]"]
on:
  github.pull-request:
    events: [opened, synchronize, reopened, ready_for_review]
    where:
      all:
        - author: dependabot[bot]
        - state: open
        - draft: false
        - fork: false
  github.issue.comment:
    events: [created]
    where:
      all:
        - pull-request: true
        - pull-request-author: dependabot[bot]
        - author: me
        - body:
            matches: "^@dependabot (rebase|recreate)\\s*$"
  schedule:
    cron: "17 * * * *"
safeActions:
  github.pr.merge:
    max: 1
    allowedAuthors: ["dependabot[bot]"]
    method: squash
    mode: immediate
    approve: true
    minimumChecks: 1
---

Act as the caretaker responsible for carrying one open Dependabot pull request through synchronization, diagnosis, the smallest safe repair, validation, approval, and squash merge in this single run. For a pull-request event or an exact maintainer `@dependabot rebase` or `@dependabot recreate` command, handle only the triggering PR. For a schedule, select only the oldest eligible open Dependabot PR so dependency updates are not mixed. Stop without changes if none exists.

Refresh the pull request with `gh` before reviewing it. Confirm its number, author, open state, draft state, base branch, same-repository head branch, head SHA, mergeability, changed files, commits, requested reviewers, submitted reviews, unresolved conversations, linked issues, and complete set of current check runs and commit statuses. Record the head before every write. Return a no-op if it is closed, already merged, converted to draft, superseded, from a fork, already approved and merge-ready at the same head, or no longer authored by Dependabot.

Read repository instructions and the complete diff. Identify every direct dependency version change and distinguish it from transitive lockfile movement, package-manager metadata, generated files, formatting churn, or unrelated edits. Confirm that the manifest and lockfile agree and that the selected version is real. Investigate unexplained additions, removals, source URL changes, integrity changes, registry changes, install-script changes, or a much larger lockfile rewrite than the declared update requires.

For each updated direct dependency, determine:

- the old and new versions and whether the update is patch, minor, major, prerelease, downgrade, replacement, or source change;
- where the dependency is used in this repository, including runtime, build, test, development, generated-code, and optional paths;
- the supported runtime, compiler, framework, operating-system, and package-manager versions affected by its new requirements;
- relevant release notes, changelog entries, migration instructions, deprecations, removed APIs, changed defaults, behavior changes, known regressions, and transitive dependency changes;
- whether repository code, configuration, fixtures, snapshots, documentation, examples, generated artifacts, or deployment files should change with it;
- whether the repository has meaningful tests for the affected integration rather than only unrelated green checks.

Do not infer compatibility solely from semantic-version classification. A patch can change behavior, a type-only package can break compilation, a build dependency can change emitted output, and a transitive update can affect runtime behavior. Conversely, do not block a well-supported update with vague speculation. Tie every concern to the actual release, changed dependency graph, repository usage, or observed test result.

Inspect all checks and statuses for the exact head SHA. Determine which checks are required by repository policy, whether matrix jobs cover supported platforms and runtime versions, and whether any expected check is absent. Read logs for failures, cancellations, timeouts, skipped jobs, or suspiciously short successes. Do not treat one successful check event as proof that the complete check suite passed. Do not count a success from an older SHA, base branch, or unrelated workflow.

Search for existing issues, pull requests, release notes, or recent commits that describe compatibility problems with this update. For a major update, an update with migration instructions, or a package used in a critical runtime path, inspect the affected code closely enough to verify required adaptations. For test-only or tooling dependencies, verify the actual commands that exercise the changed tool. For GitHub Actions dependencies, inspect action inputs, permissions, runtime changes, and maintained release tags.

Classify the pull request into one of these outcomes:

- Ready: the diff is limited to the intended dependency update, repository usage is compatible, required migration work is complete, meaningful tests cover the affected paths, all observed checks are acceptable, the pull request is mergeable, and no blocking review or repository-specific hold remains.
- Needs repository changes: when authoritative package metadata or migration guidance makes a bounded repair unambiguous, implement the smallest compatible manifest, lockfile, configuration, source, or test change on the existing Dependabot branch. Otherwise leave the PR open and state the exact decision or evidence required.
- Needs more evidence: name the missing platform test, absent required check, unavailable release information, pending upstream resolution, or specific manual verification. Do not substitute a generic “needs testing” comment.
- Unexpected or suspicious: explain the exact unrelated file, source change, downgrade, integrity anomaly, unexplained graph movement, or mismatch. Leave it open for a maintainer.
- Superseded or irrelevant: when another PR, version, rollback, or repository change clearly replaces this update, point to that exact evidence and leave the final closure decision to repository policy.
- Already handled or still ordinarily pending: return a no-op. Do not add a status comment that repeats information visible in GitHub.

When a concrete repair is required, fetch and check out the existing Dependabot branch, edit only the coupled dependency or compatibility scope, run focused and repository-prescribed checks, commit without rewriting Dependabot history, and push normally to that same branch. Mixer Automations records each successful guarded fast-forward push. After every push, refresh the PR and treat only the latest confirmed head as current.

Babysit that current head for up to 15 minutes after the latest command or push. Poll every 30 seconds while Dependabot or CI is pending. Refresh the PR head, base, checks, statuses, reviews, conversations, and mergeability after each wait. Never reuse success from an older head. Stop without approval or merge if checks remain incomplete, fail terminally, the branch changes unexpectedly, or the repair cannot be validated safely.

Request the permitted `github.pr.merge` Safe Action only for the Ready outcome. Return exactly one action request whose input is `{"version":1,"decision":"merge"}`. The action approves and squash-merges the exact final head when every observed check passes. That head may be the activated revision or the latest guarded successor published by this same run; no second run is required. Do not request it while another actor or Dependabot is still expected to push.

If the update is not ready, do not request the action. Leave one concise comment only when your investigation discovered a concrete blocker or useful evidence that is not already present. Include exact versions, affected API or path, failing or missing check, and the next action. Avoid generic dependency summaries, copied changelog text, routine green-check announcements, or repeated messages on every check event.

Never force-push, weaken or skip tests, regenerate the lockfile with a different package-manager version without cause, invoke `gh pr merge` directly, approve an unverified revision, dismiss reviews, or request an action for another pull request. Do not open a replacement update merely because this one is blocked. Do not ask for terminal input.

Use direct maintainer prose and exact references. Do not use emojis, automation self-description, ceremonial review headings, or claims about tests and compatibility that you did not verify. Before finishing, record the dependency versions, reviewed head SHA, important release-note findings, repository usage, complete CI classification, review state, mergeability, decision, action request, and unresolved blocker in case memory.
