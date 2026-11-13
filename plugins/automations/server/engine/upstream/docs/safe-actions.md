# Authority and Safe Actions

Safe Actions are explicit extension-owned capabilities authorized by workflow frontmatter. Core owns discovery, policy validation, request persistence, limits, dry-run staging, immutable plans, execution receipts, and restart reconciliation. Extensions own the action schema, policy, live-state checks, and external mutation.

Subprocess harnesses receive a serialized catalog containing only the actions declared by that workflow. To request one, the final `MIXER_AUTOMATIONS_RESULT` line includes its name and input:

```text
MIXER_AUTOMATIONS_RESULT: {"version":1,"outcome":"acted","actions":[{"name":"github.pr.merge","input":{"version":1,"decision":"merge"}}]}
```

The request is only a proposal. Mixer Automations applies it after the harness exits and validates the input, workflow policy, deterministic limit, activated event, and current external state. A prompt cannot authorize an undeclared action, select a different repository or pull request, or override policy fields.

YAML workflows declare the same policies and submit proposals with `mixer-automations actions request <name> --input-json JSON --request-key key` from an active step. This command requires the daemon and uses a lease-fenced step token. It never performs the mutation while the shell is running. A successful requesting attempt and successful workflow execution are required before application; retries deduplicate the request, while failure or cancellation discards unplanned proposals. See `mixer-automations docs scripted-workflows` for the complete contract.

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

Unknown actions and invalid policies make `mixer-automations automations validate` fail. `mixer-automations automations files` lists every enabled action. At most one Safe Action proposal is accepted per run; `github.pr.merge` can optionally submit the approval as part of its one reconciled operation.

## GitHub pull-request approval and merge

`github.pr.approve` approves the exact activated pull request at the head revision reviewed by the harness, or at an exact successor head confirmed as a guarded publication by the same run:

```yaml
safeActions:
  github.pr.approve:
    max: 1
    allowedAuthors: ["dependabot[bot]"]
```

Its request input is fixed:

```json
{ "version": 1, "decision": "approve" }
```

`github.pr.merge` supports `merge`, `squash`, and `rebase` methods. `immediate` mode requires all observed check runs and commit statuses to be successful, neutral, or skipped and requires at least `minimumChecks`. `auto` mode merges immediately when those checks pass; otherwise it enables GitHub auto-merge and lets configured branch protection finish the merge. GitHub auto-merge and appropriate branch protection must be enabled for that repository.

Its request input is also fixed:

```json
{ "version": 1, "decision": "merge" }
```

Before approval, merge, or auto-merge enablement, the GitHub extension re-fetches the PR and requires its repository, number, allowlisted author, open state, non-draft state, head repository, branch, and head SHA to match the activated snapshot or the same run's confirmed guarded publication chain. Merge additionally requires GitHub to report the PR as mergeable. The REST merge request includes the exact reviewed SHA. Approval, merge, and auto-merge responses are reconciled against live GitHub state when a response is uncertain or execution resumes after a daemon interruption.

This supports a complete caretaker lifecycle in one run: activate at `A`, push one or more guarded repairs, babysit CI on the final confirmed head, approve that head, and merge it. The publication receipt must belong to the same run, repository, PR, and branch, and every pushed head must continue the guarded chain. Mixer Automations never substitutes an arbitrary current workspace SHA or live PR SHA. External advancement, an unconfirmed push, or a changed head repository or branch fails closed.

Normal `gh pr merge` remains blocked by the publication guard. Merging is available only through the declared Safe Action, so ordinary prompts and workflows retain the default no-merge behavior.

For a deterministic, already-approved merge, add `mergeCheck: {}` to the `github.pr.merge` action policy. It accepts the same author, label, and quality-gate fields as `github.mergeCheck`, with defaults from the read-only checker. The stricter gate rechecks reviews, current-head checks and statuses, quality gates, repository requirements, and base currency at preparation and execution. Its base and head constraints are persisted in the prepared effect. Unsupported requirements fail closed. This policy requires immediate mode and `approve: false`; it is required for scripted merges and optional for existing agent workflows. The selected merge method must also satisfy applicable repository rules.

The REST merge endpoint enforces the expected head SHA, not a base SHA. Mixer Automations checks the base again immediately before merging, but only GitHub's repository protections can enforce base currency if the base advances between that final read and the merge. Configure strict required checks when this must be enforced server-side.

`mixer-automations automations inspect <run> --json` exposes the requests, prepared plan, and effect receipts. Request acceptance is not merge completion.

## Dependabot example

This webhook workflow runs when a successful check completes on a Dependabot PR. If every observed check has passed, `auto` mode merges immediately. If at least one check exists but others remain pending, it enables GitHub auto-merge so branch protection finishes the operation later.

```md
---
name: Review and merge Dependabot updates
repository: owner/repo
agent: codex
thinking: high
on:
  github.check:
    events: [completed]
    where:
      all:
        - pull-request: true
        - pull-request-author: dependabot[bot]
        - check-conclusion: success
        - draft: false
safeActions:
  github.pr.merge:
    max: 1
    allowedAuthors: ["dependabot[bot]"]
    method: squash
    mode: auto
    approve: true
    minimumChecks: 1
---

Review the exact dependency update and current head. Inspect the diff, dependency
metadata, release notes, compatibility risk, and available CI evidence. Request
github.pr.merge only when the update is appropriate. Otherwise leave it open and
explain the concrete blocker. Never invoke gh pr merge directly.
```

`github.check` requires webhook delivery. The configured GitHub identity must be allowed to approve, and auto mode requires repository auto-merge plus branch protection that names the CI checks which must pass. Repeated successful check events are safe: the activated or confirmed same-run head is revalidated and action receipts plus live GitHub state deduplicate approval and merge operations.

## Other GitHub publication

Normal checkout work still uses the transparent GitHub publication capability. New work may claim one new branch. Open same-repository PRs authored by the configured account may update their exact observed head. A workflow may also explicitly allow exact human or bot authors with `github.pullRequests.branchUpdates.allowedAuthors`; those runs may only fast-forward the observed branch and cannot edit or close the PR. Wildcards are not supported. Other PRs are commitless and review-only. Direct base pushes, unrelated branches, base changes, and arbitrary mutating `gh api` requests remain rejected.
