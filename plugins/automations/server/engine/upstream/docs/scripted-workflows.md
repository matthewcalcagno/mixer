# Scripted workflows

Use `.yaml` or `.yml` when the commands and their order are known. Use `.md` when an agent should investigate or decide what to do. Both formats use the same router, durable queue, repository selection, attested workspace, and run history. Scripted execution does not call a model or parse agent output. Printing `MIXER_AUTOMATIONS_RESULT` cannot authorize a Safe Action.

## Location and identity

Files are discovered recursively below `$MIXER_AUTOMATIONS_HOME/automations`, exactly like Markdown workflows. The default home is `~/.roboplane`. Repository-local workflows are not discovered.

```text
~/.roboplane/automations/shared/check-health.yml
~/.roboplane/automations/services/customer/check-pr.yaml
~/.roboplane/automations/shared/investigate.md
```

The relative filename, including extension, is the workflow ID. Commands accept an extensionless path only when it identifies one workflow. If `check.md` and `check.yaml` both exist, use the exact filename. Display names are not CLI identifiers. The bundled `steps` extension must be enabled. No agent provider or model credentials are required.

## Complete example

```yaml
name: Check a repository
repository: owner/repo
on:
  github.pull-request:
    events: [opened, synchronize]
    where:
      labels:
        none: [roboplane-ignore]
env:
  CI: "true"
defaults:
  run:
    shell: bash
    timeout: 5m
steps:
  - id: install
    name: Install dependencies
    run: npm ci
  - id: test
    name: Run tests
    timeout: 10m
    run: npm test
  - id: diagnose
    name: Collect diagnostics
    if: failure
    run: git status --short
```

## Top-level schema

| Field | Type and default | Meaning |
| --- | --- | --- |
| `name` | Optional non-empty string | Defaults to the relative filename without its extension. |
| `disabled` | Boolean, `false` | Excludes the file from active discovery. Admitted runs retain their snapshots. |
| `repository` | Optional `owner/repo` string or unique non-empty list | Every run selects exactly one repository. |
| `workspace` | Optional registered provider | Defaults to `worktree` with a repository, otherwise `scratch`. |
| `on` | Required mapping | Same triggers and filters as Markdown. `{}` makes the workflow manual/handoff-only. |
| `env` | String-to-string mapping, `{}` | Environment shared by steps. Quote numeric and boolean values. |
| `defaults` | Optional mapping containing `run` | Shared command settings. |
| `steps` | Required list of 1 through 1,000 steps | Sequential execution. |
| `safeActions` | Action-name to policy mapping, `{}` | Permitted action proposals, validated by their extensions. |
| Namespaced extension fields | Extension-validated values | For example, `github.mergeCheck` or `github.pullRequests`. |

`defaults.run` accepts `shell`, `working-directory`, `timeout`, and `no-output-timeout`. Its shell defaults to `bash` and directory to `.`. Omitted timeouts use the remaining run deadline and configured runtime no-output timeout.

YAML rejects `agent`, `model`, and `thinking`. Invoke a Markdown workflow for agent work. Both formats support `safeActions`; Markdown rejects `steps`, `env`, and `defaults`.

## Step schema

| Field | Type and default | Meaning |
| --- | --- | --- |
| `id` | Optional `[A-Za-z_][A-Za-z0-9_-]*` identifier, at most 64 characters | Unique. Defaults to `step_1`, `step_2`, and so on. Explicit IDs cannot collide with generated IDs. |
| `name` | Optional non-empty string | Defaults to the ID. |
| `run` | Required non-empty string | One command or a multiline script. |
| `shell` | `bash` or `sh` | Overrides the default shell. |
| `working-directory` | Workspace-relative path | Overrides the default directory. Traversal and symlink escapes are rejected. |
| `env` | String-to-string mapping, `{}` | Overrides workflow environment. |
| `timeout` | Positive duration | Overrides the default step elapsed-time budget. |
| `no-output-timeout` | Positive duration | Overrides the maximum silent interval. |
| `if` | `success`, `failure`, or `always`; default `success` | Selects the step from preceding effective outcomes. |
| `continue-on-error` | Boolean, `false` | Records failure but permits normal progression. |
| `retry` | Optional `{maxAttempts, delay}` | `maxAttempts` is 1 through 10; delay defaults to `1s`. |

Durations are positive integers followed by `ms`, `s`, `m`, or `h`. Zero and values larger than the process timer limit are invalid.

```yaml
name: Check the runtime
on:
  schedule:
    cron: "0 * * * *"
steps:
  - id: check
    timeout: 30s
    retry:
      maxAttempts: 3
      delay: 2s
    run: node --version
```

## Execution rules

Each step starts a fresh noninteractive, non-login shell with closed stdin. `bash` uses `-e -o pipefail`; `sh` uses `-e`, without Bash pipeline semantics. Shells must already be installed. Mixer Automations never substitutes another shell silently. Scripted host execution is intended for POSIX systems with Bash or sh.

All steps share one workspace, so files persist. Shell variables, exports, and `cd` do not persist. Use `env`, `working-directory`, and files explicitly. There is no output-expression system. The workflow's own directory is not copied into its workspace; referenced scripts must exist in the repository checkout or be created by an earlier step.

An untolerated failure skips later `success` steps. `failure` and `always` steps may execute, but their success never erases the original failure. Tolerated failures remain visible but do not select later `failure` steps.

`always` does not run after cancellation, run deadline expiry, daemon interruption, or lease loss. These stop user execution. Core still performs bounded workspace and execution cleanup.

The absolute run deadline bounds every step and retry. All attempts and retry delays share the step's elapsed-time budget. Cancelled or interrupted commands are never automatically retried.

Global `runtime.maxAttempts` does not restart scripted execution after commands may have produced effects. Only explicit step `retry` retries commands. Make those commands idempotent. Interrupted scripts require explicit replay; Mixer Automations cannot determine whether an external side effect occurred before interruption.

## Context and credentials

| Variable | Value |
| --- | --- |
| `MIXER_AUTOMATIONS_HOME` | Effective configuration home. |
| `MIXER_AUTOMATIONS_RUN_ID` | Current run ID. |
| `MIXER_AUTOMATIONS_WORKFLOW_ID` | Relative workflow filename. |
| `MIXER_AUTOMATIONS_REPOSITORY` | Selected repository, or an empty string. |
| `MIXER_AUTOMATIONS_WORKSPACE` | Absolute workspace directory. |
| `MIXER_AUTOMATIONS_EVENT_FILE` | Private version-1 JSON context file. |
| `MIXER_AUTOMATIONS_STEP_ID` | Current step ID. |
| `MIXER_AUTOMATIONS_ATTEMPT` | Current attempt, starting at one. |
| `MIXER_AUTOMATIONS_STEP_DEADLINE` | Absolute ISO deadline for all attempts of this step. |

The event file contains `version`, `runId`, optional `repository`, `workflow.extensions`, and activated `event`. Inherited child input is separate `event.input`. Treat external event fields as untrusted data; never concatenate issue titles or comment bodies into shell commands.

Environment precedence is filtered host values, explicit `extensions.steps.env`, workflow `env`, step `env`, then trusted context. `MIXER_AUTOMATIONS_*`, `PWD`, `PATH`, `GIT_*`, and shell-startup controls are reserved. The host provider applies publication-guard environment last.

Integration tokens are not automatically forwarded. Registered read-only extension queries execute in the daemon with scoped parent context. A step can invoke `mixer-automations github pr can-merge --event-file "$MIXER_AUTOMATIONS_EVENT_FILE"` without receiving a GitHub token. Other extension commands require an explicit read-only `query` handler. This does not make all extension commands remotely callable.

For commands requiring credentials that cannot use a registered daemon query, explicitly opt in through `config.json` rather than embedding secrets in YAML:

```json
{
  "extensions": {
    "steps": {
      "env": { "SERVICE_TOKEN": "${SERVICE_TOKEN}" }
    }
  }
}
```

Core resolves this configuration placeholder from the daemon environment. This is an explicit credential grant to every scripted workflow, not automatic inheritance. Prefer scoped read-only queries when available. Never override publication identity or print credentials.

The current CLI is available as `roboplane` in CLI-created scripted runs even if it is not globally installed. Its wrapper retains guarded git and gh commands. Embedded runtimes must provide `RuntimeOptions.cli` for this convenience.

Host execution is not sandboxed. Workflow authors and installed extensions are trusted. Scripts can access the user's filesystem and network. Directory checks and publication guards prevent ordinary mistakes, not malicious bypasses. Do not print credentials; logs are retained and no universal secret-redaction guarantee is claimed.

## Scripted Safe Actions

Declare the action policy at the top level, then request the action from an active step with `mixer-automations actions request`. The daemon must be running. The command records a proposal, not a completed mutation. Printing `MIXER_AUTOMATIONS_RESULT` does not request an action.

```yaml
name: Merge an eligible Dependabot PR
repository: owner/repo
on:
  github.pr.schedule:
    cron: "0 * * * *"
    where:
      all:
        - pull-request-author: dependabot[bot]
        - base-branch: develop
        - state: open
        - draft: false
        - fork: false
        - labels:
            none: [roboplane-ignore]
safeActions:
  github.pr.merge:
    max: 1
    allowedAuthors: ["dependabot[bot]"]
    method: squash
    mode: immediate
    approve: false
    minimumChecks: 1
    mergeCheck: {}
steps:
  - id: eligibility
    run: |
      mixer-automations github pr can-merge --event-file "$MIXER_AUTOMATIONS_EVENT_FILE" --output report.json
  - id: merge
    run: |
      decision=$(node -p 'require("./report.json").decision')
      if [ "$decision" = eligible ]; then
        mixer-automations actions request github.pr.merge \
          --input-json '{"version":1,"decision":"merge"}' \
          --request-key merge-ready
      fi
```

For repair handoffs on an ineligible or unknown result, see `examples/scripted/05-merge-or-investigate.yaml` and `mixer-automations docs workflow-handoffs`.

`--input-json` supplies JSON action input, limited to 48 KiB. `--request-key` is required and deduplicates requests by run, step, and key, including across step retries. Repeating identical input returns the same proposal; changed input for an existing key is rejected and audited. At most one action proposal is accepted per run. Undeclared actions and invalid inputs are also rejected and audited. Step tokens cannot authorize requests after the step ends, the lease expires, or the run is cancelled.

Mixer Automations applies the proposal after execution succeeds and the execution session closes. The requesting step attempt must succeed; a tolerated failure does not authorize its proposal. A retry must request the action again to confirm it in the successful attempt. Failed, cancelled, interrupted, or expired runs discard unplanned proposals. Dry-run stages the action without executing it. Prepared plans and effects are persisted together and use the existing restart reconciler rather than restarting the shell script.

Scripted GitHub merges require an explicit `mergeCheck` action policy. This gate supports only `mode: immediate` and `approve: false`; approval must already exist for the current head. The extension rechecks eligibility at preparation and execution, binds the base and head SHAs, verifies the branch is current with its base, and refuses unknown or unsupported repository requirements. The observed report alone never authorizes a merge. Direct `gh pr merge` remains blocked.

Inspect the final result with `mixer-automations automations inspect <run-id> --json`. `actions` distinguishes proposed, staged, rejected, failed, and executed requests; `plan` and `effects` expose execution and reconciliation records. A successful request command means only that the proposal was recorded.

## Multiple repositories

Repository events select their own repository, schedules create separate repository-bound runs, and manual multi-repository invocation requires `--repository`. A child invocation never means "run for every configured repository". Read `mixer-automations docs workflow-handoffs` before handing off repository work.

## Validate, run, and inspect

```bash
mixer-automations automations validate
mixer-automations automations validate shared/check-health.yml --json
mixer-automations automations files
mixer-automations automations run shared/check-health.yml
mixer-automations automations run shared/check-health.yml --json
mixer-automations automations inspect <run-id>
mixer-automations automations inspect <run-id> --json
mixer-automations automations logs <run-id> --step <step-id>
mixer-automations automations rerun <run-id> --wait
```

`automations run` requires the daemon and returns after durable admission by default. Add `--wait` outside a scripted step to wait for that run, not its detached children. There is no standalone fallback. Scripted handoffs reject `--wait` so a parent cannot block a child while holding a concurrency slot or case lock.

History records step attempts, timestamps, status, exit codes, reasons, and tolerated failures. Logs carry step IDs and attempts. Stdout streams without an in-memory accumulated copy. Missing commands, invalid runtime directories, timeouts, and nonzero exits fail the step.

Successful scripts have a completed execution status. Their task outcome is `unknown` unless Mixer Automations observes an authoritative workspace change or accepted child handoff, which records `acted`. A successful exit alone cannot prove that a script did or did not mutate an external service. The CLI still treats completed scripts with unknown effects as successful execution.

Snapshot replay preserves configuration, not external services, repository script contents, or package versions. Replays create new runs and fresh workspaces. Current-workflow replay revalidates the current file.

## Validation and unsupported syntax

The parser accepts one YAML 1.2 mapping document of at most 1 MiB. It rejects YAML 1.1 directives, duplicate keys, custom tags, unknown fields, unsupported merge keys, circular aliases, non-finite numbers, and excessive alias expansion. Step errors report field paths and source positions where available. Disabled files still undergo syntax and step-schema checks.

This is not a GitHub Actions interpreter. `jobs`, `uses`, `needs`, matrices, inline agents, and `${{ ... }}` script expressions are unsupported. Use ordinary commands, environment variables, and files. Agent output is never interpreted as a return value to the parent.
