# Workflow authoring reference

This is the complete reference for creating Mixer Automations workflows. It documents the schema, runtime behavior, examples, and validation process without requiring inspection of Mixer Automations source code.

For a GitHub maintainer workflow, read this topic together with:

```bash
mixer-automations docs github
mixer-automations docs agents
mixer-automations docs maintainer
```

## Authoring contract

Mixer Automations connects triggers to Markdown agent workflows or YAML scripted workflows. One matching event creates one run in one disposable workspace. Repository workflows receive a checkout; repository-less workflows receive an isolated scratch directory. Markdown selects a reasoning harness. YAML lists shell steps. Read `mixer-automations docs scripted-workflows` for the complete schema and `mixer-automations docs workflow-handoffs` for child-run submission.

Mixer Automations workflows are global user configuration. They are discovered recursively only below:

```text
$MIXER_AUTOMATIONS_HOME/automations
```

`MIXER_AUTOMATIONS_HOME` defaults to `~/.roboplane`. Never create Mixer Automations workflow files inside a managed repository. Subdirectories below the global workflow directory are allowed and are useful for grouping repositories:

```text
~/.roboplane/automations/owner--repo/issue-intake.md
```

Agent workflows are UTF-8 Markdown files ending in `.md`. Frontmatter selects repository, workspace, harness, model, thinking, triggers, and optional Safe Actions. The body is the prompt. Scripted workflows end in `.yaml` or `.yml` and contain one YAML mapping with `steps`. Nested paths work equally for every format. Extensionless identifiers must resolve uniquely.

```md
---
name: Handle new issues
repository: owner/repo
agent: codex
model: gpt-5.3-codex
thinking: high
on:
  github.issue:
    events: [opened, reopened]
    where:
      labels:
        none: [roboplane-ignore]
---

Investigate the triggering issue as a repository maintainer. Do not ask for input.
```

## Complete top-level frontmatter schema

This table describes Markdown agent workflows. For YAML steps, use `mixer-automations docs scripted-workflows`. Agent fields are not supported in YAML; `safeActions` is a top-level policy mapping in both formats, not a step field.

Nine top-level keys are owned by core. Enabled extensions may register additional namespaced fields with `api.workflows.registerField`. Unregistered keys make the workflow invalid.

| Key | Required | Type | Meaning |
| --- | --- | --- | --- |
| `name` | No | Non-empty string | Display name. Defaults to the workflow file path without `.md`. |
| `disabled` | No | Boolean | Defaults to `false`. When `true`, excludes the workflow from active discovery without deleting or renaming its file. |
| `repository` | No | `owner/repo` string or non-empty list | Repositories managed by this workflow. Omit it for API, ticket, reporting, and other repository-less automation. Entries must be unique. |
| `workspace` | No | Registered workspace name | Explicit provider override. Defaults to `worktree` when `repository` exists and `scratch` otherwise. |
| `agent` | No | Non-empty string | Registered harness name. Defaults to `codex`. Bundled values are `codex`, `claude`, `opencode`, `pi`, and `copilot`. |
| `model` | No | Non-empty string | Model identifier passed directly to the selected harness. Omit it to use that harness's configured default. |
| `thinking` | No | Non-empty string | Harness-specific thinking, reasoning-effort, or model-variant value. Omit it to use that harness's configured default. |
| `on` | Yes | Mapping | Event types and extension-owned trigger configuration. Use `{}` for a manual/handoff-only workflow with no subscriptions. |
| `safeActions` | No | Mapping | Explicit extension-owned actions and policies available to this workflow. Omission means no Safe Actions. |

To pause a workflow, add `disabled: true` to its existing frontmatter. Disabled workflows have no event subscriptions and cannot receive new event-triggered or manual runs. The daemon reloads file changes automatically. Set `disabled: false` or remove the field to re-enable the workflow. Use an unquoted YAML boolean; strings such as `"true"` and `"false"` are invalid.

Disabling does not cancel existing queued or running jobs. Historical snapshot replay remains available, but replay with the current workflow does not. Disabled files still undergo core and registered extension-owned frontmatter parsing. Runtime checks for registered agents, workspaces, event sources, trigger configuration, and Safe Actions are skipped until the workflow is enabled.

These are not supported Markdown frontmatter keys: `provider`, `roles`, `planner`, `implementer`, `reviewer`, `operator`, `execution`, `timeout`, `permissions`, `safe-actions`, `verification`, `steps`, `jobs`, `maxBatch`, or repository-local configuration. `steps`, `env`, and `defaults` belong only in `.yaml` or `.yml`. `safeActions` is camel-cased and policy-based in both workflow formats; the older spelling remains invalid. Mixer Automations YAML resembles GitHub Actions structurally but is not a GitHub Actions interpreter.

The runtime uses the built-in `host` execution path. It resolves an omitted workspace to `worktree` for repository workflows and `scratch` for repository-less workflows. An explicit workspace must name a registered provider; `workspace: worktree` requires `repository`. Normal branch publication authority is derived at runtime. A Safe Action is available only when its exact extension-owned policy is declared and validates.

A workflow can target multiple repositories without duplicating its prompt and trigger configuration:

```yaml
repository:
  - owner/service-one
  - owner/service-two
```

Repository events create a run only when their repository is in the list. Each run remains bound to exactly one repository and receives its own checkout and action authority. A schedule creates one run per listed repository. Manual execution of a multi-repository workflow requires `--repository owner/repo`; the value must be listed in the workflow. Replays retain the source run's repository and current-workflow replay fails if that repository is no longer configured.

### Repository-less workflows

Omit both `repository` and `workspace` for the normal API-only form. Mixer Automations creates a fresh scratch directory for the run and removes it after completion, failure, cancellation, or interruption:

```md
---
agent: codex
on:
  jira.issue:
    cron: "0 9 * * 1-5"
    jql: 'project = PLATFORM AND status = "Ready for Triage" AND labels = automation'
---

Read the triggering Jira issue and report its unresolved questions without modifying Jira.
```

The scratch directory is available as the harness working directory for temporary files. Files there are not durable output. Publish results through extension-owned Safe Actions or another explicit destination. Set `extensions.scratch.cleanup` to `false` only when intentionally retaining scratch directories for diagnosis.

The bundled `jira` extension requires its own Jira Data Center base URL and personal access token. It supports scheduled JQL discovery, not Jira write actions. See `mixer-automations docs jira` for credentials, fields, per-ticket execution, and delivery deduplication.

## Safe Actions

Extension-owned frontmatter is also validated strictly. To let a workflow repair an exact same-repository PR branch owned by a bot or another named account, declare the GitHub branch-update policy separately from merge authority:

```yaml
github.pullRequests:
  branchUpdates:
    allowedAuthors: ["dependabot[bot]"]
```

This policy permits only guarded fast-forward pushes to the activated PR branch. It does not permit PR edits, closure, direct merge, forks, wildcards, or another author's branch. `safeActions` remains independently opt-in.

`safeActions` is opt-in. Each key must name a registered action, and every policy requires a positive `max`. The owning extension validates all remaining fields. Unknown actions, misspelled policy fields, and invalid values make the workflow invalid.

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

The harness receives only the declared action catalog. It requests an action through its final `MIXER_AUTOMATIONS_RESULT`; the request does not execute until after the harness exits. Mixer Automations then binds it to the activated event, revalidates live state and policy, enforces `max`, and persists the result. A request cannot supply a repository, PR number, author, head revision, merge method, or any other policy-owned authority.

At most one action proposal is accepted per run. For an approve-then-merge flow, use `github.pr.merge` with `approve: true`. A run that is authorized to update the PR branch may push one or more guarded fast-forward repairs, babysit CI for the latest confirmed head, and request that merge without starting a second run. See `mixer-automations docs safe-actions` for the request envelope and complete GitHub policies.

## Prompt body

Everything after the closing frontmatter delimiter is sent to the harness, followed by trusted run context and the normalized triggering event. Write the body as the same instruction you would type manually into that harness.

A reliable autonomous prompt should state:

- the exact responsibility and scope of this run;
- what GitHub conversation, code, tests, documentation, and repository instructions to inspect;
- the allowed complete outcomes, including when to do nothing;
- how to verify claims and code changes;
- what GitHub follow-up is required after a change;
- what must never happen, especially merging without an explicit Safe Action, broad rewrites, invented evidence, or interactive questions;
- a bound such as one issue, one PR, one finding, or a small number of candidates.

Do not put credentials, local absolute project paths, or integration secrets in the prompt. The harness starts in a fresh checkout or scratch directory, never a permanent local project directory.

## Trigger composition

Keys below `on` are event type names. Multiple event types in one workflow are OR alternatives: any matching trigger creates a run. Conditions inside one trigger determine whether that event type matches.

```yaml
on:
  github.issue.comment:
    events: [created]
    where:
      pull-request: false
  schedule:
    cron: "17 7 * * 1"
```

One upstream event may match multiple workflow files. Mixer Automations creates an independent run for every matching workflow. Runs concerning the same GitHub issue or PR are serialized; different cases may run concurrently up to the global runtime concurrency.

Manual execution does not require a `manual` trigger. Any valid workflow can be invoked with:

```bash
mixer-automations automations run path/to/workflow --input '{"reason":"test the prompt"}'
```

The optional JSON becomes manual event data appended to the prompt. It does not bypass workspace, publication, or action policy.

For a multi-repository workflow, select one configured repository:

```bash
mixer-automations automations run path/to/workflow --repository owner/service-one --input '{"reason":"test the prompt"}'
```

## Schedule trigger

The schedule schema is exact and strict:

```yaml
on:
  schedule:
    cron: "0 3 * * 1"
```

`cron` is required and must be a non-empty cron expression accepted by `cron-parser`. Standard five-field expressions, optional seconds as a sixth field, aliases such as `@daily`, lists, ranges, steps, and supported special values such as `L` are accepted. Evaluation uses the daemon host's local timezone because Mixer Automations does not currently expose a per-workflow timezone field.

Examples:

| Expression | Meaning in the daemon timezone |
| --- | --- |
| `0 */6 * * *` | Every six hours at minute zero. |
| `17 7 * * *` | Every day at 07:17. |
| `29 4 * * 1` | Every Monday at 04:29. |
| `0 0 1 * *` | First day of every month at midnight. |
| `*/30 * * * * *` | Every thirty seconds; use cautiously. |

After downtime, the scheduler emits at most one catch-up run per workflow and calculates the next occurrence from the current time. It does not replay every missed interval.

Only `cron` is allowed under `schedule`. Keys such as `timezone`, `prompt`, `enabled`, or `maxRuns` are invalid.

### Scheduled GitHub pull requests

Use `github.pr.schedule` when a recurring job must act on individual PRs rather than the repository. This trigger belongs to the GitHub extension and requires a repository, a cron expression, and a GitHub `where` condition:

```yaml
repository: owner/service
on:
  github.pr.schedule:
    cron: "0 * * * *"
    where:
      all:
        - pull-request-author: me
        - state: open
        - draft: false
        - fork: false
        - labels:
            all: [auto-pr]
            none: [roboplane-ignore]
```

Each occurrence lists open PRs, paginating up to 100 pages (10,000 PRs), and emits a separate event for every match. An incomplete scan fails rather than silently skipping older PRs. Each run is bound to one PR and refreshes its live head and filter eligibility during activation. The `me` matcher refers to the configured GitHub identity. A duplicate event for the same PR and occurrence does not create another run. If GitHub or run admission fails, the scan retries the same occurrence rather than silently dropping remaining PRs. The daemon's local timezone controls the cron expression. This trigger does not grant branch writes or merges; the normal publication policy and Safe Actions remain required. Recheck eligibility before writing because labels, reviews, and heads may change while a run waits in the queue.

## GitHub event types

Mixer Automations registers exactly these workflow event types:

| Event type | Object represented | Polling | Webhook |
| --- | --- | --- | --- |
| `github.issue` | Issue lifecycle event | Yes | Yes |
| `github.pull-request` | Pull-request lifecycle event | Yes | Yes |
| `github.issue.comment` | Conversation comment on an issue or PR | Yes | Yes |
| `github.pr.review` | Submitted or changed PR review | Yes, with polling action names | Yes, with webhook action names |
| `github.pr.comment` | Inline diff review comment or reply | Yes | Yes |
| `github.check` | Check run associated with a PR | No | Yes |

Polling is the default when no webhook is configured. GitHub's repository Events API is not a real-time API and offers a smaller action set than webhooks. A syntactically valid action will never run if the selected ingestion mode does not deliver it.

### Actions available through polling

The repository Events API currently exposes the following actions that Mixer Automations normalizes:

| Mixer Automations event | Polling `events` values |
| --- | --- |
| `github.issue` | `opened`, `closed`, `reopened`, `assigned`, `unassigned`, `labeled`, `unlabeled` |
| `github.pull-request` | `opened`, `closed`, `merged`, `reopened`, `assigned`, `unassigned`, `labeled`, `unlabeled` |
| `github.issue.comment` | `created` |
| `github.pr.review` | `created`, `updated`, `dismissed` |
| `github.pr.comment` | `created` |
| `github.check` | Not delivered by polling |

Do not assume polling will deliver `synchronize`, `ready_for_review`, `review_requested`, edited comments, submitted webhook reviews, or check runs. GitHub may evolve its upstream API; use `mixer-automations logs` to inspect observed events when introducing an unfamiliar action.

### Actions available through supported webhooks

Mixer Automations normalizes these GitHub webhook names. Submitted reviews use the shared `created` action. Other actions retain their delivered names:

| GitHub webhook | Mixer Automations event | Common `events` values |
| --- | --- | --- |
| `issues` | `github.issue` | `opened`, `edited`, `deleted`, `transferred`, `pinned`, `unpinned`, `closed`, `reopened`, `assigned`, `unassigned`, `labeled`, `unlabeled`, `locked`, `unlocked`, `milestoned`, `demilestoned`, `typed`, `untyped` |
| `pull_request` | `github.pull-request` | `opened`, `edited`, `closed`, `reopened`, `synchronize`, `converted_to_draft`, `ready_for_review`, `review_requested`, `review_request_removed`, `assigned`, `unassigned`, `labeled`, `unlabeled`, `locked`, `unlocked`, `milestoned`, `demilestoned`, `auto_merge_enabled`, `auto_merge_disabled`, `enqueued`, `dequeued` |
| `issue_comment` | `github.issue.comment` | `created`, `edited`, `deleted` |
| `pull_request_review` | `github.pr.review` | `created`, `edited`, `dismissed` |
| `pull_request_review_comment` | `github.pr.comment` | `created`, `edited`, `deleted` |
| `check_run` | `github.check` | `created`, `rerequested`, `completed`, `requested_action` |

The lists above describe useful GitHub actions, not a Mixer Automations enum. Mixer Automations accepts a non-empty array of action strings in `events` and compares each string exactly and case-sensitively with the normalized action. `mixer-automations github triggers --json` reports actions not covered by the selected transport. An empty action string will not match a normal GitHub delivery.

## GitHub trigger schema

A GitHub event type accepts either an empty trigger or this strict object:

```yaml
events: [action, action]
types: [action, action]
names: [label, label]
where: <condition>
reconcile: true
```

- `events` is the preferred non-empty list of allowed action strings.
- `types` is a compatibility alias for `events`. Never specify both.
- `names` is currently a case-insensitive shorthand that matches any current label. It does not match check-run names. Prefer `where.labels` because its meaning is explicit.
- `where` is one condition from the grammar below.
- `reconcile` is an optional boolean, defaulting to false. Enable it to retain relevant events whose live issue or PR conditions do not yet match. Mixer Automations reevaluates pending routes after resource changes and every 30 seconds, for up to seven days from the original event time. See [deferred GitHub triggers](github.md#deferred-triggers).
- Omitting `events` accepts every action delivered for that event type.
- An empty trigger can be written as `{}` or as a blank YAML value. Prefer `{}` for clarity.

To match a check-run name, use `title`, because normalized `github.check` data places the check name in `title`:

```yaml
on:
  github.check:
    events: [completed]
    where:
      all:
        - title: CI
        - check-conclusion: [failure, timed_out]
```

## Condition grammar

A `where` value is exactly one of:

```yaml
where:
  all: [<condition>, <condition>]
```

```yaml
where:
  any: [<condition>, <condition>]
```

```yaml
where:
  not: <condition>
```

```yaml
where:
  <predicate>: <matcher>
  <predicate>: <matcher>
```

`all` requires every child condition. `any` requires at least one child. `not` negates one child. A predicate object containing multiple predicates also requires all of them. Boolean groups may be nested to any practical depth. Empty condition objects and empty `all` or `any` arrays are invalid. Unknown condition keys are invalid.

These two forms are equivalent:

```yaml
where:
  draft: false
  base-branch: main
```

```yaml
where:
  all:
    - draft: false
    - base-branch: main
```

## String and identity matchers

The following predicates use a string matcher:

`author`, `actor`, `pull-request-author`, `reply-to`, `reviewer`, `mentioned`, `title`, `body`, `state`, `author-association`, `head-branch`, `base-branch`, `head-repository`, `base-repository`, `review-state`, and `check-conclusion`.

Compact forms are case-insensitive:

```yaml
author: octocat
review-state: [changes_requested, commented]
```

A string means exact equality. An array means exact equality with any listed value.

Advanced form requires exactly one operation plus optional `case-sensitive`:

```yaml
title:
  starts-with: "bug:"
  case-sensitive: false
```

| Operation | Value | Semantics |
| --- | --- | --- |
| `equals` | string | Exact equality. |
| `not-equals` | string | Anything except exact equality. A missing value does not match. |
| `one-of` | non-empty string array | Equal to at least one candidate. |
| `not-one-of` | non-empty string array | Equal to none of the candidates. A missing value does not match. |
| `starts-with` | string | Prefix match. |
| `ends-with` | string | Suffix match. |
| `contains` | string | Substring match. |
| `matches` | RE2 pattern, 1-512 characters | RE2 regular-expression match. |
| `not-matches` | RE2 pattern, 1-512 characters | Negated RE2 match. A missing value does not match. |
| `exists` | boolean | Whether the normalized field exists, regardless of its contents. |
| `case-sensitive` | boolean | Optional modifier for the selected operation; defaults to `false`. |

JavaScript-only regular-expression features unsupported by RE2, such as lookbehind and backreferences, are invalid.

`me` has special meaning only in compact identity matchers for `author`, `actor`, `pull-request-author`, `reply-to`, `reviewer`, and `mentioned`. It resolves dynamically to the account authenticated by the configured PAT. Do not use `me` inside an advanced object such as `equals: me`; there it is treated as the literal word `me`.

Identity details:

- `author` is the author of the triggering issue, comment, inline comment, or review. For a PR lifecycle event it is the PR author.
- `actor` is the GitHub account that caused the event.
- `pull-request-author` is the account that opened the PR, including for PR comments and reviews.
- `reply-to` is the author of the parent inline review comment and exists only for replies to `github.pr.comment`.
- `reviewer` tests each currently requested individual reviewer and requested `organization/team-slug`.
- `mentioned` extracts explicit `@user` and `@organization/team-slug` mentions from the triggering body.
- `event-label` is the specific label added or removed by a `labeled` or `unlabeled` issue or pull-request lifecycle event. Use it when the workflow must react to one label rather than any event whose current label set happens to contain that label.
- Arrays for `reviewer` and `mentioned` mean any matching identity, not all identities.
- Team requests do not imply that every team member matches `reviewer: me`.

## Label matcher

`labels` accepts a strict object containing one or more of `any`, `all`, and `none`. Every value is a non-empty list. Label comparisons are case-insensitive.

```yaml
labels:
  any: [bug, regression]
  all: [confirmed, priority-high]
  none: [roboplane-ignore, security-private]
```

All supplied clauses must pass:

- `any`: at least one listed label exists;
- `all`: every listed label exists;
- `none`: no listed label exists.

Use `none` as a manual opt-out in every relevant trigger:

```yaml
where:
  all:
    - labels:
        none: [roboplane-ignore]
    - pull-request-author: me
```

This prevents future matching events whose normalized object has the label. A queued run is re-matched after activation and becomes a no-op if the label was added. It does not terminate an already running harness; use `mixer-automations automations cancel <run>` for that run or stop the daemon for a global halt.

## Number matcher

`number` and `changed-files` accept either an exact number or an object containing one or more bounds:

```yaml
number: 42
changed-files:
  gte: 1
  lte: 20
```

Supported keys are `equals`, `gt`, `gte`, `lt`, and `lte`. All supplied bounds must pass. A missing event value does not match.

## Boolean and relation matchers

| Predicate | Matcher | Meaning |
| --- | --- | --- |
| `draft` | boolean | Current PR draft state. |
| `merged` | boolean | Current PR merged state. |
| `fork` | boolean | Whether PR head and base repositories differ. |
| `pull-request` | boolean | Whether the event belongs to a PR. Use this to distinguish PR conversation comments from issue comments. |
| `branch-relation` | `same` or `different` | Whether normalized head and base branch names are equal. |

If a required boolean or branch value is absent from that event type, the predicate does not match.

## Predicate availability

Not every normalized field exists on every event. A predicate requiring a missing field fails unless it is an `exists: false` string matcher.

| Predicate | Normalized value and useful event types |
| --- | --- |
| `labels` | Current labels on issues and PRs; useful for issue, PR, comment, review, and inline-comment events when PR/issue data is available. |
| `author` | Triggering object author; available on issues, PRs, comments, reviews, and inline comments. |
| `actor` | Account that caused the event. |
| `pull-request-author` | PR author; PR lifecycle, PR conversation comments, reviews, inline comments, and associated check runs after enrichment. |
| `reply-to` | Parent inline-comment author; only inline review-comment replies. |
| `reviewer` | Requested users and teams; PR-related events after live enrichment. |
| `mentioned` | Mentions in the triggering `body`; comments, review bodies, issue bodies, or PR bodies depending on event. |
| `title` | Issue/PR title; check-run name for `github.check`. |
| `body` | Triggering issue/PR/comment/review body, depending on event type. |
| `state` | Issue/PR open state, review/check status when normalized by that event. |
| `author-association` | GitHub author association for the triggering object. |
| `head-branch`, `base-branch` | PR head/base branch. |
| `head-repository`, `base-repository` | Full `owner/repo` PR head/base repository. |
| `review-state` | Review state such as `approved`, `changes_requested`, or `commented`. |
| `check-conclusion` | Check conclusion such as `success`, `failure`, `neutral`, `cancelled`, `skipped`, `timed_out`, or `action_required`. |
| `event-label` | Specific label that caused a `labeled` or `unlabeled` issue or PR lifecycle event. |
| `draft`, `merged`, `fork` | PR facts. |
| `number` | Issue or PR number. |
| `changed-files` | PR changed-file count when GitHub supplies or Mixer Automations refreshes it. |
| `pull-request` | Distinguishes PR-related objects from plain issues. |

## Common recipes

### New and reopened issues, excluding manual work

```yaml
on:
  github.issue:
    events: [opened, reopened]
    where:
      labels:
        none: [roboplane-ignore]
```

### Issue comments only, not PR conversation comments

```yaml
on:
  github.issue.comment:
    events: [created]
    where:
      all:
        - pull-request: false
        - labels:
            none: [roboplane-ignore]
```

### Conversation comments on PRs authored by the PAT account

```yaml
on:
  github.issue.comment:
    events: [created]
    where:
      all:
        - pull-request: true
        - pull-request-author: me
        - not:
            author: me
        - labels:
            none: [roboplane-ignore]
```

### Inline comments on PRs authored by the PAT account

```yaml
on:
  github.pr.comment:
    events: [created]
    where:
      all:
        - pull-request-author: me
        - not:
            author: me
        - labels:
            none: [roboplane-ignore]
```

### Review requested from the PAT or a team

This recipe requires webhook delivery if using `review_requested`, because polling does not expose that action.

```yaml
on:
  github.pull-request:
    events: [review_requested]
    where:
      all:
        - reviewer: [me, acme/platform]
        - not:
            pull-request-author: me
        - labels:
            none: [roboplane-ignore]
```

### Reply to an inline finding authored by the PAT

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
        - labels:
            none: [roboplane-ignore]
```

### Small non-draft PRs targeting main

```yaml
where:
  all:
    - draft: false
    - base-branch: main
    - changed-files:
        lte: 20
    - labels:
        none: [roboplane-ignore]
```

### Failed check with an exact check name

This requires a webhook because `github.check` is not polled.

```yaml
on:
  github.check:
    events: [completed]
    where:
      all:
        - title: CI
        - check-conclusion: [failure, timed_out, action_required]
        - pull-request-author: me
```

### Text and regular-expression matching

```yaml
where:
  any:
    - title:
        starts-with: "bug:"
    - body:
        matches: "timeout|timed out|deadline exceeded"
```

## Matching and activation lifecycle

Mixer Automations applies repository equality and the trigger matcher when an event is received. A matching event creates a persisted run. Immediately before the harness starts, GitHub activation refreshes authoritative PR or issue facts, the exact checkout revision, and triggering comment identity. The refreshed activation snapshot controls workspace and publication authority.

The workflow matcher is run a second time after activation against the persisted workflow snapshot. Therefore:

- future events honor current labels and filters;
- a label added before a later comment prevents that later comment from matching;
- adding an opt-out label before activation turns a queued run into a no-op;
- changing a workflow file does not rewrite the snapshot already stored for a queued run;
- `mixer-automations automations cancel <run>` halts one queued or active run without stopping unrelated automation.

GitHub and the checkout remain authoritative. Event bodies, issue text, comments, and repository content are untrusted context for the agent.

## Publication and Safe Action authority

The workflow does not declare GitHub write permissions. Before each guarded run Mixer Automations compares the configured PAT identity with `gh api user` and derives one live capability:

- new issue, scheduled, and manual work may claim one new branch and open a PR;
- an open same-repository PR authored by the PAT may update only its exact observed head branch;
- an exact human or bot author named by `github.pullRequests.branchUpdates.allowedAuthors` may receive guarded fast-forward updates on an open same-repository PR;
- other contributor, fork, closed, and merged PRs are review-only and cannot commit or push;
- base-branch pushes, unrelated branches, PR base changes, and direct `gh pr merge` commands are denied.

Approval and merge are exceptional extension-owned Safe Actions. They remain unavailable by default and become eligible only through a valid `safeActions` policy. The GitHub extension binds them to the exact activated PR, allowlisted author, and either the activated head or an exact successor confirmed through the same run's guarded publication chain. It revalidates live GitHub state before execution.

Adding a prompt sentence cannot expand this capability. See `mixer-automations docs github`, `safe-actions`, and `workspaces`.

## Agent, model, and thinking selection

Choose the harness the user has installed and authenticated:

```yaml
agent: opencode
model: <exact-model-id-accepted-by-opencode>
thinking: <variant-supported-by-that-model>
```

Mixer Automations passes `model` and `thinking` directly to the adapter; it does not validate vendor model catalogs or normalize thinking levels across harnesses. Codex maps `thinking` to `model_reasoning_effort`, Claude and Copilot to their effort flags, OpenCode to a model variant, and Pi to its thinking flag. A syntactically valid workflow can still fail at runtime if the harness or selected model rejects either value, lacks credentials, or is not installed. Run `mixer-automations extensions` to see registered providers and test the exact harness/model/thinking combination manually when introducing it.

The harness runs unattended with stdin closed. Prompts must not require confirmation, clarification, login, interactive selection, or terminal input.

## Authoring procedure

When asked to create a workflow, follow this sequence:

1. Run `mixer-automations docs workflow-authoring` and the relevant linked topics.
2. Inspect `mixer-automations automations files` and the existing files below `$MIXER_AUTOMATIONS_HOME/automations` to avoid overlapping triggers.
3. Confirm whether the installation uses polling or webhooks before selecting event actions.
4. Choose exactly one primary responsibility for each workflow.
5. Add `labels.none: [roboplane-ignore]` to every issue/PR trigger when the user wants a manual opt-out.
6. Exclude self-authored comments when replies could cause feedback loops.
7. Use `pull-request: true` or `false` for `github.issue.comment` whenever issue versus PR scope matters.
8. Select an installed `agent`, an exact model identifier, and, when needed, a thinking value accepted by that harness and model.
9. Write a bounded, autonomous prompt with complete outcome and verification requirements.
10. Save only under the global workflow home, never in a repository.
11. Run `mixer-automations automations validate` and fix every error.
12. Run `mixer-automations automations files` and confirm the resolved workspace, optional repository, triggers, agent, model, thinking mode, and Safe Actions.
13. Use `mixer-automations automations run <workflow> --input ...` for a controlled prompt test when appropriate.
14. Use `mixer-automations extensions reload <name>` after changing extension code; normal workflow file changes are watched and reloaded automatically.

## Validation and troubleshooting

```bash
mixer-automations automations validate
mixer-automations automations files
mixer-automations status
mixer-automations logs
```

`mixer-automations automations validate` checks core and registered extension-owned frontmatter, repository syntax, registered agents, registered trigger sources, schedule configuration, GitHub matcher structure, registered Safe Actions, and their extension-owned policies. It cannot prove that GitHub polling will deliver an action, that a model or thinking value is supported, that a prompt is useful, or that GitHub permissions and branch protection allow the intended operation.

If a workflow validates but does not run, check in this order:

1. the daemon is running;
2. the workflow appears in `mixer-automations automations files`;
3. the GitHub `owner/repo` exactly matches `repository` or one entry in its list;
4. the event type is supported by the active polling/webhook mode;
5. the delivered action matches `events` exactly;
6. every `all` predicate and every predicate in the same object passes;
7. no `not` or `labels.none` condition excludes it;
8. the event is not a suppressed self-generated Mixer Automations mutation;
9. local logs do not show polling lag, cursor loss, PAT/API failure, or workflow validation errors.

If a workflow runs too often, narrow `events`, add repository-specific label and identity conditions, split issue and PR comments using `pull-request`, exclude `author: me`, and give scheduled workflows non-overlapping responsibilities.

## Example implementation brief

When delegating workflow creation, provide requirements equivalent to the following:

```text
Read `mixer-automations docs workflow-authoring`, `mixer-automations docs github`,
`mixer-automations docs agents`, and `mixer-automations docs maintainer`. Inspect the existing
global workflows with `mixer-automations automations files`. Create or edit only files below
$MIXER_AUTOMATIONS_HOME/automations; never add Mixer Automations workflow files to the repository.
Use only documented frontmatter and triggers, account for whether this installation
uses polling or webhooks, include the roboplane-ignore label opt-out where applicable,
then run `mixer-automations automations validate` and `mixer-automations automations files`. Do not leave an invalid workflow.
```
