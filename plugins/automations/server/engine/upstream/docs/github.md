# GitHub

## Read-only merge eligibility

```bash
mixer-automations github pr can-merge --repository owner/repo --number 42 --json
mixer-automations github pr can-merge --event-file "$MIXER_AUTOMATIONS_EVENT_FILE" --output merge-report.json
```

This command only reads GitHub. It never synchronizes branches, pushes, approves, comments, merges, or enables auto-merge. A completed evaluation exits zero even when a PR is ineligible. Authentication, network, malformed-data, and incomplete-pagination failures exit nonzero.

The version-1 report contains `repository`, `number`, `headSha`, `baseSha`, `observedAt`, `decision`, and `reasons`. Decisions are `eligible`, `ineligible`, and `unknown`. An eligible observation is not a promise that a later merge succeeds; live state and GitHub enforcement remain authoritative.

Scripted steps use a scoped daemon query, so the GitHub token stays in the daemon. In that mode the daemon derives the target and policy from persisted activated parent context, not the supplied event-file path. Outside a step, `--event-file` reads the versioned context file and ordinary CLI credentials apply. Do not combine it with explicit repository/number flags.

Declare this extension field in YAML to customize the evaluator:

```yaml
github.mergeCheck:
  allowedAuthors: [maintainer]
  requiredLabels: [automation]
  excludedLabels: [roboplane-ignore]
  qualityGateChecks: [SonarCloud Code Analysis, SonarQube Code Analysis, SonarQubeCloud Code Analysis]
```

All fields are optional. Author and required-label lists default empty, the excluded-label list defaults to `roboplane-ignore`, and the non-empty quality-gate name list defaults to the names above. Names are exact. These fields never authorize a mutation.

The checker requires an open, non-draft, same-repository PR, an allowed author and labels, no conflict, current-head approval from another user, no effective changes-requested review, at least one check or status, successful terminal checks/statuses, and a successful matching quality gate. Reviews and current-head checks/statuses are paginated, bounded to 100 pages per collection. Historical statuses and reviews are reduced to their effective latest state. Required checks must succeed, not merely be neutral or skipped.

The checker reads branch rules and classic protection. It evaluates required check names/application bindings and approval counts. It reports `unknown` when requirements cannot be read, data is incomplete, or requirements need additional authoritative evaluation, such as code-owner approval, last-push approval, merge queues, signatures, or other unsupported rules. Missing quality-gate evidence and unknown mergeability are never eligible. It refreshes the PR after collecting evidence and reports uncertainty if the target, revision, eligibility fields, or merge state changed.

The installed `example-scripted-04-check-merge-eligibility` topic contains a read-only `spa-storecustomer` workflow. It can coexist with existing agent merge workflows; it does not disable their separate merge authority.

## Scripted pull-request merges

YAML can request an audited merge without invoking an agent. Declare `github.pr.merge` under `safeActions`, and include a `mergeCheck` policy for the full eligibility gate:

```yaml
safeActions:
  github.pr.merge:
    max: 1
    allowedAuthors: ["dependabot[bot]"]
    method: squash
    mode: immediate
    approve: false
    minimumChecks: 1
    mergeCheck:
      excludedLabels: [roboplane-ignore]
```

From an active scripted step, request the action with:

```bash
mixer-automations actions request github.pr.merge \
  --input-json '{"version":1,"decision":"merge"}' \
  --request-key merge-ready
```

The daemon must be running. The command records a proposal; the merge occurs only after successful workflow execution and session cleanup. Scripted merges require `mergeCheck`, `mode: immediate`, and `approve: false`. The current head must already have approval. Existing agent merge policies may also opt into this gate.

The action's `mergeCheck` accepts the same fields as the read-only `github.mergeCheck` workflow field. The workflow field alone does not authorize a merge or configure the action's gate. Use a YAML anchor to share policy values, as shown in `examples/scripted/05-merge-or-investigate.yaml`. The action rechecks eligibility during preparation and execution, verifies the head and base constraints, and rejects unsupported requirements. An earlier eligible report is not authorization. GitHub enforces the merge's head SHA; server-side strict required checks are needed to enforce base currency across a concurrent base update.

The installed `example-scripted-05-merge-or-investigate` topic shows how to merge eligible PRs and hand off ineligible or unknown PRs to a caretaker. Its hourly PR schedule works with polling; check-completion triggers require webhooks. Keep the caretaker's `on: {}` so the same event does not launch both paths. Direct `gh pr merge` remains blocked. Inspect the final action status with `mixer-automations automations inspect <run> --json`.

For exhaustive workflow frontmatter, polling-versus-webhook action coverage, every matcher form, predicate availability, and complete examples, run `mixer-automations docs workflow-authoring`. This page explains GitHub runtime behavior and security in more depth.

The GitHub extension detects events. The agent handles GitHub work itself through normal `gh` and `git` commands.

Mixer Automations uses the token from an authenticated GitHub CLI by default:

```bash
gh auth login
```

To override that token, configure event access globally with either a literal token or an environment reference:

```json
{
  "extensions": {
    "github": {
      "token": "${GITHUB_TOKEN}",
      "pollInterval": "30s",
      "maxPages": 3,
      "publishGuard": {
        "enabled": true,
        "maxChangedFiles": null
      },
      "failureReports": {
        "enabled": true
      }
    }
  }
}
```

Set `maxChangedFiles` to a positive integer to bound publication size, or `null` to remove only the changed-file count limit while preserving all other publication guard checks.

A workflow that creates a new branch may authorize additional exact PR base branches without changing the activated publication base:

```yaml
github.pullRequests:
  newBranches:
    allowedBaseBranches: [feature/integration]
```

The publication guard still rejects every base not named by the workflow.

Mixer Automations reads environment references from the process that starts it; it does not load `$MIXER_AUTOMATIONS_HOME/.env`. If `extensions.github.token` is omitted, the extension runs `gh auth token`. If neither source is available, `mixer-automations extensions inspect github` reports whether GitHub CLI is missing or unauthenticated. `mixer-automations github status` prints the authenticated account. For private repositories, the token needs enough read access to retrieve repository events, issues, PRs, comments, checks, and commits. Agent-side writes use whatever credentials `gh` and `git` normally use in the daemon's user account, and Mixer Automations verifies that identity against the token identity.

## Webhooks

GitHub registers the `github.events` input handler. The bundled `webhooks` extension owns the HTTP listener, routing, body limits, deadlines, and delivery acknowledgements. GitHub owns signature verification, payload normalization, repository scope, matching, and activation. No HTTP server exists inside the GitHub extension.

Create `$MIXER_AUTOMATIONS_HOME/webhooks/github.yaml`:

```yaml
handler: github.events
secretEnv: GITHUB_WEBHOOK_SECRET
```

Export `GITHUB_WEBHOOK_SECRET` before starting the daemon and configure GitHub to send to `/webhooks/github`. To preserve a different remote URL, add `path: /github/webhook` to the endpoint definition. Set listener host and port under `extensions.webhooks.listener` in `config.json`. The old `extensions.github.webhook` setting is rejected with a configuration error.

The handler verifies `X-Hub-Signature-256` over unchanged bytes, requires `X-GitHub-Delivery`, and accepts only repositories named in active GitHub subscriptions. Put the shared listener behind HTTPS when exposed publicly. Read `mixer-automations docs webhooks` for the complete settings and diagnostics.

GitHub repository-event polling remains enabled by default and does not require a webhook. Before configuring `github.events`, set `extensions.github.polling: false`. Endpoint validation rejects simultaneous repository-event polling and webhook collection. GitHub supplies different identifiers for the two transports, and not every label transition has a shared exact identity; Mixer Automations does not deduplicate them using a lossy timestamp. PR schedules, matching, live activation, and Safe Actions remain available independently. With no enabled HTTP endpoints, the bundled webhook extension opens no port.

## Triggers

Common normalized event types are:

- `github.issue`
- `github.pull-request`
- `github.issue.comment`
- `github.pr.comment`
- `github.pr.review`
- `github.check`

`github.check` requires webhook delivery; GitHub's repository-events polling API does not provide check-run events. When the webhook associates a check run with a pull request, Mixer Automations binds the event to that PR so matching, exact checkout activation, and case memory work normally.

Events authored by the account behind the configured PAT are valid triggers. Opening or reopening your own issue therefore runs a matching workflow. With the publication guard enabled, your manual issue comments also reach workflow matching while a related run is active or has just completed. Runs on the same issue remain serialized.

The guarded `gh issue comment` command automatically appends a hidden publication marker to agent-created issue comments. It accepts an explicit `--body` or `--body-file`, including stdin with `--body-file -`, and does not modify the input file. Interactive editing, editing the last comment, and deleting the last comment are rejected for guarded issue comments. Before publication, Mixer Automations writes a receipt containing the run, repository, issue, and a hash of the marked body. A successful response confirms the GitHub comment ID when available. The poller and webhook listener suppress comments matching these receipts rather than suppressing every comment from the same account. Receipts survive restarts and are retained for duplicate deliveries and historical replays; they do not contain the comment text.

Issue comments published by agents must use guarded `gh issue comment` or an extension-owned Safe Action. External API and MCP clients do not pass through the command guard and cannot be identified by these receipts. This is the same host-harness trust boundary as guarded Git and PR publication, not a sandbox for arbitrary network clients.

PR comments, reviews, and PR synchronization events still use the same-account guard during a related agent run and for five minutes afterward. If `publishGuard.enabled` is explicitly disabled, issue comments retain that time-based guard as well. Exact mutations performed through GitHub Safe Actions remain deduplicated. Intentional event suppression is logged with the event/comment identity and reason, without the comment body.

Suppressed delivery IDs have durable receipts, so a redelivery remains suppressed after a short-lived publication marker expires. Published-head markers are reusable until expiry and refer to the original triggering head, not a newer head fetched during enrichment. A branch prefix alone never proves ownership. Safe Action label receipts are actor- and label-specific, do not consume unrelated human events, cover each newly added label, and are not created for labels already present. These short-lived label receipts still correlate mutations from the same PAT account; they are not an independent identity for manual changes made under that same account.

## Execution eligibility

Runs on one GitHub issue or PR wait in the durable queue rather than occupying workers while waiting for a case lock. Resource ownership precedes activation. Labels, draft state, and the checkout revision are refreshed after that wait. Ownership also protects pending finalized-hook delivery, so completion receipts exist before another equivalent run starts.

Activation verifies ordinary issue comments as well as PR comments. A changed or deleted issue comment is skipped before workspace creation. Failed branch-continuity queries preserve existing work instead of treating an unavailable answer as permission to start a replacement branch.

The optional `github.execution` field controls deterministic execution policy:

```yaml
github.execution:
  oncePerHead: true
  currentHeadChecks: true
  readyWhen: merge-eligible
```

All fields are optional. `oncePerHead` defaults to false. When enabled, successful PR lifecycle, check, and PR-schedule work records the workflow definition, repository, PR number, head SHA, and base SHA. Equivalent work is skipped without invoking an executor. Changing the definition or either revision permits new work. Receipts expire according to history retention at completion. Failed, blocked, canceled, and uncertain runs do not satisfy this policy. Comment and review requests remain independent even on an unchanged head. Manual execution and explicit replay bypass completed-work suppression; replay still revalidates filters and current-head checks. Use this policy only when revisions and the definition determine completed work. Leave it off for tasks that must react to subsequent CI or label changes on an already-handled head.

`currentHeadChecks` defaults to true. Checks for an older revision do not start an executor against the new head. Set it to false only when historical checks are intentional input. Check names remain distinct from PR titles throughout activation.

`readyWhen: merge-eligible` uses the existing read-only merge checker before execution. It requires a PR and uses the workflow's `github.mergeCheck` policy. Ineligible or unknown observations defer work rather than invoke a model. This field grants no merge, approval, or branch permission. Use it only for work that should start after all merge requirements pass, not for a workflow intended to repair failing CI.

GitHub requests have a bounded `extensions.github.requestTimeout`, defaulting to 30,000 milliseconds, and observe operation cancellation. Polling failures report degraded health; successful polling restores readiness unless an unresolved history gap remains. `pollInterval` must be positive and no larger than 24 hours.

Scheduled PRs are checked again after leaving the queue. A PR that has merged, closed, or stopped matching its scheduled filter completes as `no-op` without starting an executor. Authentication, network, and other activation errors still fail the run.

### Event history gaps

When a saved cursor is absent from the fetched event pages, Mixer Automations replays available events oldest-first and records a possible history gap. This does not identify which events, if any, were missed. Successful polling continues, but source readiness stays degraded until you acknowledge the unresolved gaps. Successful polls reset the consecutive failure count and update the last-success timestamp even while a historical warning remains. A repeated warning is not a new polling failure.

Inspect incidents before deciding whether to acknowledge them:

```bash
mixer-automations github gaps
mixer-automations github gaps --json
```

Each incident has a stable ID, repository, missing cursor, available-event boundaries, and detection time. Legacy records have an unknown detection time. New incidents preserve earlier records rather than replacing them. The report also retains acknowledgment times and reasons.

After reviewing affected work and recovering what you can, acknowledge one exact incident:

```bash
mixer-automations github gaps acknowledge --id <incident-id> --reason "Reviewed affected PRs and outstanding review requests"
```

Acknowledgment accepts the remaining historical uncertainty. It does not recover missing events, change the ingestion cursor, or acknowledge future gaps. Repeating the command preserves the original acknowledgment. The next successful poll restores readiness only when no unresolved gaps remain for subscribed repositories. Run this command locally outside an automation; it is not a scoped agent query. Restarting the daemon does not clear incidents or acknowledgments.

Use `mixer-automations github triggers --json` to inspect configured transport coverage and unsupported actions. Use `mixer-automations events explain <event-id> --json` to inspect recorded matching decisions, run outcomes, eligibility waits, and resource ownership without starting work. Older events without recorded decisions are identified as such rather than assigned an invented historical reason.

Submitted pull-request reviews retain their GitHub review identity. Activation fetches every page of inline comments belonging to that review, including comments omitted from the repository activity feed. A standalone `github.pr.comment` event authorizes a reply only to its exact triggering inline thread. When feedback is itself a reply, activation verifies its root comment belongs to the same PR and uses that root ID in the reply endpoint.

The publication guard permits marker-bound replies only to these activated thread roots. Reply permission is independent of branch-write permission, so review-only runs can answer their exact feedback without gaining permission to commit or push. The agent receives an exact endpoint and hidden marker for each target. Ordinary PR conversation comments grant no inline-reply permission. Repeated marked replies are deduplicated; arbitrary mutating `gh api` calls remain blocked. Rejections identify an unauthorized target, a repository or PR mismatch, or a missing marker.

Replaying an older submitted-review run recovers a missing numeric review ID from its persisted GitHub review URL when possible, then verifies the review and fetches its complete inline-comment set. Reply markers use the root replay lineage, so repeated replays do not publish the same marked reply twice.

Agent publications do not require a special branch prefix. Before the agent starts, Mixer Automations requires the effective `gh api user` identity to equal the account behind the configured PAT. A mismatch fails the run rather than publishing under another account.

Every run receives one deterministic branch capability:

- A new issue, issue follow-up, manual run, or scheduled run may claim one previously nonexistent remote branch using any valid naming convention. The branch must descend from the activated base revision, cannot be the base branch, and becomes the only branch the run may push. PR creation is allowed only from that confirmed branch to the activated base.
- A PR authored by the PAT account with its head in the workflow repository may update only that exact head branch. The remote must still be at the head SHA observed during activation, and the new head must be a fast-forward descendant.
- A PR not authored by the PAT account, a fork PR, and a closed or merged PR are review-only for normal checkout commands by default. A workflow may explicitly allow fast-forward updates to exact same-repository PR branches from named authors with `github.pullRequests.branchUpdates.allowedAuthors`; this does not permit PR edits, closure, competing PR creation, or direct merge. The allowlist uses exact GitHub logins and supports humans and bots, but not wildcards. Reviews, comments, and explicitly declared approval or merge Safe Actions remain separately controlled.

After a successful guarded `gh pr create`, the guard queries GitHub and requires exactly one open PR with the attested PAT author, expected head and base repositories, requested base branch, claimed head branch, and confirmed published SHA. It also rechecks the local checkout and live remote head. Only then does the same run gain `owned-pr` authority for that exact PR. It may edit the description with `gh pr edit <number>`, continue fast-forward pushes, and mark the PR ready with `gh pr ready <number>`. No second workflow, polling trigger, or agent run is needed. The original issue-comment scope is preserved. The run cannot create another PR, edit another PR, change the base, or merge. This permission change does not grant event-derived Safe Action authority.

Failed creation or failed/ambiguous read-back retains the creation intent without granting PR-edit or readiness permissions. Another create attempt is rejected until reconciliation, preventing a blind duplicate after response loss. A plain manual input containing a PR number still grants no permission to update an existing PR.

The guard rejects direct base-branch pushes, unrelated or existing branch claims, multiple refspecs, branch deletion, tags and broad push modes, remote changes, PR base changes, mutating `gh api` calls, and all direct `gh pr merge` commands. Before publication it also requires the attested checkout and origin, a clean worktree, the activated ancestry, the configured changed-file bound, and no sensitive `.env` files.

The activated base revision is an ancestry constraint, not a promise that the target branch still points to that revision. A writable PR branch may merge newer target-branch commits when the workflow permits synchronization, provided the resulting head preserves the activated base and remote-head ancestry. The PR-reported base SHA can differ from the live target tip, so synchronization decisions require an independent target-branch lookup. Direct merges into the target branch remain prohibited; a declared `github.pr.merge` Safe Action has separate authority and live-state validation.

## Deferred triggers

Opt into reconciliation when an event should wait for the issue or PR to become eligible:

```yaml
on:
  github.pr.review:
    events: [created]
    reconcile: true
    where:
      all:
        - author: "copilot-pull-request-reviewer[bot]"
        - pull-request-author: me
        - state: open
        - merged: false
        - draft: false
        - labels:
            all: ["mcalcagno:auto-pr"]
            none: [roboplane-ignore]
        - review-state: [commented, changes_requested]
```

A review submitted while the PR is a draft remains pending. Marking the PR ready wakes the original review route. Adding a required label or removing an exclusion label also wakes pending work. A periodic live-state check provides recovery when no state-change event arrives, including in webhook mode.

Event actions and event-specific predicates, such as the feedback author, body, review state, and check conclusion, must match. Failed resource predicates for labels, state, draft, merged, title, head/base branch, branch relation, or changed-file count can defer the event. For checks, `title` remains the original check name rather than the PR title. Nested `all`, `any`, and `not` retain their normal meaning. Merged PRs with a failed filter are discarded, not deferred.

Reconciliation is available to issue, PR, comment, review, and PR-associated check triggers with a resource identity. It is not part of `github.pr.schedule`, which already scans live PRs. Other triggers keep their event-only behavior unless they opt in.

Pending routes are durable per workflow and original event. They are checked every 30 seconds for up to seven days from the event time, and at most 100 due routes are evaluated per batch. Within a batch, workflows on the same resource share its read-only fetch. Queue saturation and transient GitHub failures preserve pending work for retry. Repeated notifications and daemon restarts do not create a second run for the same workflow and event. Execution still refreshes and checks eligibility before starting the agent or script.

If eligibility temporarily disappears after admission, a deferred matcher result returns the same run to the queue. This spends no executor attempt and starts no workspace. Resource notifications wake both pending routes and admitted eligibility waits. The original event's expiry remains the limit. Shutdown leaves queued work durable for the next start.

Removing, disabling, or editing a workflow invalidates its pending routes. Expired routes are discarded. Events already ignored by an older version are not automatically backfilled, and workflows that already ran are not replayed. To recover an old unmatched event, use `mixer-automations events reroute <event-id>` after enabling reconciliation. Events with existing pending routes cannot be manually rerouted into duplicate work.

The daemon log records `Workflow route deferred`, its resource key and reason, `Deferred route admitted`, and discarded routes. `resource_conditions` means the current resource filter failed. Reconciliation never removes the filter or grants additional mutation permissions.

## Workflow-authorized approval and merge

Approval and merge are disabled unless the workflow declares the exact Safe Action. The action input contains only a fixed decision; repository, PR number, author, method, and mode come from the activated event and workflow policy. The head is the activated SHA or an exact successor SHA confirmed through the same run's guarded publication chain.

```yaml
safeActions:
  github.pr.merge:
    max: 1
    allowedAuthors: ["dependabot[bot]"]
    method: squash
    mode: auto
    approve: true
    minimumChecks: 1
```

`allowedAuthors` is required and compared case-insensitively with the live PR author. `method` is `merge`, `squash`, or `rebase`. `mode` is `immediate` or `auto`. `approve` submits an approval for the exact reviewed head before merging. `minimumChecks` defaults to one and prevents a workflow from treating an empty check set as successful.

Immediate mode requires every observed check run to be completed with `success`, `neutral`, or `skipped`, every commit status to be `success`, and the observed count to meet `minimumChecks`. Auto mode merges immediately when that condition already passes; otherwise it enables GitHub auto-merge. Auto mode relies on the repository's GitHub auto-merge and branch-protection configuration to wait for required checks.

An authorized caretaker does not need a second run after repairing a PR. It may start at activated head `A`, make guarded fast-forward pushes `A -> B -> C`, poll the checks and reviews for `C`, and request approval plus merge for `C`. Mixer Automations accepts only the latest confirmed head in that same run's publication chain. A head supplied by another run or pushed externally is rejected, as are changes to the head repository or branch. Auto mode performs another live-head check immediately before enabling auto-merge.

For approval without merging, declare `github.pr.approve` with `max: 1` and `allowedAuthors`, then request `{ "version": 1, "decision": "approve" }`. For approve-and-merge, declare only `github.pr.merge` with `approve: true`, because one run accepts one Safe Action proposal. The merge request is `{ "version": 1, "decision": "merge" }`.

Immediately before every mutation, the extension re-fetches the exact PR and rejects changed heads, changed or non-allowlisted authors, drafts, closed PRs, conflicts, incomplete check pagination, and stale activation. The REST merge call includes the reviewed head SHA. See `mixer-automations docs safe-actions` for the serialized result envelope and a Dependabot workflow.

Confirmed capabilities are retained under `$MIXER_AUTOMATIONS_HOME/.roboplane/state` and copied into extension state. Issue runs that created a branch or PR can resume that exact publication branch in a later disposable workspace. Human-created PRs authored by the same PAT account are adopted from live GitHub state. Every later activation refreshes the current author, repository, state, branch, and head SHA; cached state never overrides GitHub.

Push intent is written before publication and confirmation is written only after success. On daemon startup and run finalization, uncertain receipts are reconciled against GitHub. The guard records the exact successfully published head SHA, so matching GitHub `opened` and `synchronize` events are suppressed regardless of branch name. A `roboplane` label may still be useful for visibility, but labels are not the ownership boundary.

The daemon performs conservative GitHub-state garbage collection at startup and hourly. Confirmed, finalized per-run publication receipts are retained for seven days. Pending or uncertain push and PR-creation receipts are never age-deleted. Expired self-event and published-head suppression markers are removed automatically. Garbage collection only removes local Mixer Automations state; it never deletes a remote branch, issue, pull request, comment, or review.

Inspect or run the same collector manually:

```bash
mixer-automations github gc --dry-run
mixer-automations github gc
```

The dry run performs no reconciliation or deletion. Applying a plan revalidates each file and state value first, so anything changed since planning is retained.

The guard is a reliability control around normal `git` and `gh` resolution through `PATH`, not a hostile-process sandbox. A deliberately malicious harness with host access could invoke another executable by absolute path or use another network client.

## Issue and pull-request memory

Every issue and pull request handled by Mixer Automations has one global agent-maintained memory file:

```text
~/.roboplane/.roboplane/cases/github/owner/repo/issue/42/memory.md
~/.roboplane/.roboplane/cases/github/owner/repo/pr/123/memory.md
```

Before each related run, the GitHub extension loads the existing note into the agent context and tells the agent where to update it. The note is a concise handoff containing prior work, decisions, verification, replies or commits, and unresolved next steps. GitHub and the current checkout remain authoritative; `memory.md` is only a continuity aid and is limited to 64 KiB.

Runs for the same issue or pull request are serialized so rapid comments cannot update the same memory concurrently. Different issues and pull requests may still run in parallel.

When GitHub reports an issue or pull request closed, its memory remains available for 24 hours. Before deletion, Mixer Automations verifies the case is still closed against GitHub. Reopening the case cancels cleanup, and an issue capability is retained while its linked pull request remains open. The daemon checks hourly and deletes the expired memory and matching local case capability together. Only `memory.md` is stored in a case directory; code workspaces remain disposable and are removed after every run.

Select GitHub actions with `events`:

```yaml
on:
  github.issue:
    events: [opened, edited]
```

Optional `where` filters support `all`, `any`, and `not` plus predicates for labels, author, actor, PR author, inline-review reply parent, requested reviewer, mentions, title, body, state, author association, branches, repositories, review state, check conclusion, draft, merged, fork, issue/PR number, changed-file count, and whether an issue event is a pull request.

```yaml
on:
  github.pull-request:
    events: [opened, synchronize]
    where:
      all:
        - draft: false
        - base-branch: main
        - labels:
            none: [skip-agent]
```

The complete normalized event payload is appended to the workflow prompt. The agent can fetch any additional context with `gh`.

## Account, author, reviewer, and mention filters

Use `me` in an identity predicate to mean the account returned by `GET /user` for the configured PAT. Resolution is dynamic, case-insensitive, and requires no duplicated username in configuration.

- `author` is the author of the triggering object. On a comment or review event, this is the person who wrote that comment or review.
- `actor` is the GitHub account that caused the event.
- `pull-request-author` is the account that opened the PR, including while matching its comments and reviews.
- `reply-to` is the author of the parent inline review comment. It exists only when a `github.pr.comment` event is a reply; top-level review comments do not match it. Mixer Automations resolves the parent comment from GitHub before workflow matching.
- `reviewer` matches a currently requested individual reviewer or requested team. Use `me` for the PAT account or `organization/team-slug` for a team.
- `mentioned` matches an explicit `@user` or `@organization/team-slug` in the triggering issue, PR, comment, or review body.

Plain values and arrays are the compact identity syntax. An array means “any of these identities.” `me` is supported in this compact syntax; the advanced string matcher objects remain useful for literal text matching.

Run only for inline review comments on PRs opened by the PAT account:

```yaml
on:
  github.pr.comment:
    events: [created]
    where:
      pull-request-author: me
```

PR conversation comments arrive as `github.issue.comment`, so include `pull-request: true`:

```yaml
on:
  github.issue.comment:
    events: [created]
    where:
      all:
        - pull-request: true
        - pull-request-author: me
```

Run when the PAT account or a team is requested for review:

```yaml
on:
  github.pull-request:
    events: [review_requested, synchronize]
    where:
      reviewer: [me, acme/platform]
```

Run when a comment explicitly mentions the PAT account or team:

```yaml
on:
  github.issue.comment:
    events: [created]
    where:
      mentioned: [me, acme/platform]
```

Run only when someone replies to an inline review comment authored by the PAT account:

```yaml
on:
  github.pr.comment:
    events: [created]
    where:
      all:
        - reply-to: me
        - not:
            author: me
        - not:
            pull-request-author: me
```

`reply-to: me` compares the live parent-comment author with the account returned by the PAT. It does not rely on an `@mention` or on the account still being a requested reviewer.

Team matching is explicit: `reviewer: acme/platform` matches a request sent to that team. Mixer Automations does not infer team membership and does not treat a team request as a direct `reviewer: me` match. To require multiple facts instead of accepting any identity, compose separate predicates with `all`.

## Workflow failure issues

When a workflow reaches a terminal `failed` status, the GitHub extension automatically opens a new issue in that run's repository. This behavior is enabled by default. Disable it globally for every repository, workflow, event type, and failure stage with `extensions.github.failureReports.enabled: false`; it cannot be configured per repository or workflow. Disabling reports does not affect local run records or logs.

For a multi-repository workflow, the report destination is the configured repository selected by the triggering event, schedule, or manual command. The destination cannot be redirected to another repository. The report contains the workflow and run identifiers, triggering event, timestamps, attempt number, sanitized terminal error, any cleanup error, and the local `mixer-automations automations inspect <run-id>` command.

The complete run log remains local. Mixer Automations removes common token and secret forms from the GitHub report and never includes the workflow prompt, event body, daemon environment, or full log. The PAT must be able to create issues in the workflow repository. If issue creation fails or issues are disabled, Mixer Automations records that failure only in the local log; reporting failures never create additional reporting attempts.

Failure reports contain an internal marker and are ignored by the GitHub event source, so they do not recursively start ordinary issue workflows. Each failed run creates its own issue. Retry attempts are not reported unless the run ultimately fails.
