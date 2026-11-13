# Mixer Automations

Mixer Automations automatically runs agent prompts when extension events or schedules fire.

```text
extension event -> global Markdown agent or YAML scripted workflow -> supervised execution
```

It is a personal, local daemon. Repository workflows run the agent in an attested disposable checkout; repository-less workflows run it in an isolated scratch directory. The harness uses its normal configuration and authentication. GitHub workflows additionally receive a deterministic branch capability.

## Setup

Requires Node.js 24+ and pnpm.

```bash
pnpm install
pnpm build
pnpm --filter @roboplane/cli link --global
mixer-automations init
```

Authenticate GitHub and each agent CLI using their normal login commands:

```bash
gh auth login
claude
codex
```

Mixer Automations uses `gh auth token` by default. To select a token explicitly, export it in the environment that starts Mixer Automations and reference it from `config.json`:

```bash
export GITHUB_TOKEN=github_pat_...
```

```json
{
  "runtime": {
    "concurrency": 1
  },
  "history": {
    "retention": "7d"
  },
  "extensions": {
    "github": { "token": "${GITHUB_TOKEN}" }
  }
}
```

The token may also be written literally as `extensions.github.token`. Mixer Automations does not load a private `.env` file. Services such as launchd or systemd must receive variables through their own environment configuration. See `mixer-automations docs configuration` for the complete schema and authentication behavior.

## Installation layout

`MIXER_AUTOMATIONS_HOME` identifies the outer working directory and defaults to `~/.roboplane`. Workflows remain directly under that directory. Settings and private working files live in its nested `.roboplane/`:

```text
~/.roboplane/
├── automations/
├── evaluations/
├── extensions/
├── webhooks/
└── .roboplane/
    ├── config.json
    ├── cases/
    ├── logs/
    ├── state/
    └── workspaces/
```

## Workflow

The bundled `webhooks` extension supports optional HTTP endpoints under `webhooks/` and serverless local submission through `mixer-automations events emit`. No enabled HTTP endpoints means no listener. Schedules, GitHub polling, and manual runs remain independent. Read `mixer-automations docs webhooks` for endpoint configuration, payload filters, custom handlers, and CLI diagnostics. MCP configuration remains in the selected harness.

The bundled `jira` extension queries Jira Data Center through REST v2 on a cron schedule and emits one `jira.issue` event per matching ticket version. Each ticket runs in its own agent session. Configure a Jira personal access token and a JQL subscription as described in `mixer-automations docs jira`. Discovery does not require MCP, and unchanged versions are skipped across scans and restarts. Jira write actions and semantic refinement state are not included.

Workflows exist only under `~/.roboplane/automations`:

Mixer Automations discovers nested `.md`, `.yaml`, and `.yml` files. Markdown invokes an agent; YAML lists sequential `run` steps under a name and triggers. Start the daemon with `mixer-automations start`, then submit with `mixer-automations automations run <name>`. Submission is detached by default; add `--wait` when you need the final outcome. Scripted handoffs cannot wait for children. Read `mixer-automations docs scripted-workflows` and `mixer-automations docs workflow-handoffs` for syntax, validation, and lifecycle details.

Both formats can declare `safeActions`. YAML requests a declared action with `mixer-automations actions request <name> --input-json JSON --request-key key` from an active step. Mixer Automations applies the proposal after successful workflow execution and session cleanup, without calling a model. The command requires the daemon; acceptance does not mean the action completed. Inspect the final result with `mixer-automations automations inspect <run-id> --json`. See `examples/scripted/05-merge-or-investigate.yaml` for a Dependabot merge-or-investigate workflow.

Run `mixer-automations docs workflow-authoring` for the complete schema, trigger matrix, matcher reference, examples, and validation checklist.

For report-only feedback on an automation, define criteria in `evaluations/<name>/evaluation.yaml`. The bundled evaluations extension reviews a batch after `afterRuns` new runs and writes a report under that evaluation's `reports/` directory. It never applies suggestions. Read `mixer-automations docs evaluations` for setup, retained evidence, and model selection.

```md
---
repository: owner/repo
agent: claude
model: claude-opus-4-6
thinking: high
on:
  github.issue:
    events: [opened]
---

Handle the triggering issue as a repository maintainer. Investigate it using
git and gh. If a focused fix is justified, implement it, test it, commit it,
push a branch, and open a pull request. Otherwise reply appropriately.
```

Mixer Automations appends the triggering event and payload to the Markdown prompt, creates and attests a disposable workspace, and launches the selected CLI in unattended mode with an explicit project directory where the CLI supports one. Repository harnesses may edit files and use normal `git` and `gh` commands; API-only workflows publish effects through their extension-owned actions.

`repository` also accepts a non-empty list when the same workflow should run across multiple repositories. Events select the matching repository, schedules run once per listed repository, and manual runs require `mixer-automations automations run <workflow> --repository owner/repo`. Each run remains bound to one repository.

New work may claim one previously nonexistent branch using any naming convention. An open same-repository PR authored by the PAT account may update only its exact observed head using a remote lease. Contributor and fork PRs are commitless and review-only. Direct base pushes, unrelated branches, base changes, mutating `gh api` calls, and direct `gh pr merge` commands are rejected. A workflow can explicitly authorize the extension-owned `github.pr.approve` or `github.pr.merge` Safe Action; merge policies bind the exact activated PR, an author allowlist, the reviewed head, check requirements, method, and immediate or GitHub auto-merge mode. See `mixer-automations docs safe-actions`.

Related runs for one issue or pull request share a global `memory.md` under `~/.roboplane/.roboplane/cases`. Mixer Automations serializes those runs, keeps code checkouts disposable, and removes the case memory automatically 24 hours after GitHub reports the case closed.

If a workflow ultimately fails, Mixer Automations retains the complete local log and automatically attempts to open a sanitized failure issue in that run's repository. The PAT needs Issues write permission. Failure reports are marked so they cannot recursively trigger normal issue workflows.

```bash
mixer-automations github status
mixer-automations automations validate
mixer-automations automations files
mixer-automations start --foreground
```

Generate starter workflows with:

```bash
mixer-automations automations create maintainer --repository owner/repo --agent claude --model claude-opus-4-6 --thinking high
```

For the complete production-style pack, including issue ownership, PR review, review feedback, stale-issue follow-up, CI repair, proactive maintenance, dependency review, and merge readiness, run:

```bash
mixer-automations docs maintainer-examples
mixer-automations docs example-maintainer-01-issue-intake
```

The installed examples contain complete frontmatter and prompts that can be adapted to repository-specific maintenance policies.

Bundled harnesses are `claude`, `codex`, `opencode`, `pi`, and `copilot`. Harness extensions remain replaceable through the public SDK.

## Personal extensions

The extension authoring reference is available through `mixer-automations --help`, `mixer-automations docs --path`, and `mixer-automations docs extension-authoring`. Create an enabled event-source or workflow-field extension under `$MIXER_AUTOMATIONS_HOME/extensions` with:

```bash
mixer-automations extensions create my-source --template event-source
mixer-automations extensions validate my-source
mixer-automations extensions reload my-source
```

Extensions can be enabled and disabled through `config.json` with `mixer-automations extensions enable|disable <name>`. They register triggers, namespaced workflow frontmatter, hooks, commands, agents, workspaces, execution providers, and Safe Actions through `@mixer/automations-sdk`.

Workflows that omit `repository` automatically run in a disposable scratch directory. This supports pure Jira, Linear, Trello, reporting, and API automation without a dummy Git repository:

```yaml
---
agent: codex
on:
  jira.issue:
    project: PLATFORM
    columns: [Ready for Triage]
---

Triage the triggering issue and publish the result through a permitted Jira Safe Action.
```

Run `mixer-automations docs workspaces` for cleanup and provider-selection behavior.

## Trust model

Mixer Automations intentionally gives the autonomous harness the same account and filesystem authority it has when launched manually. It uses the user's home-directory CLI credentials and a safe execution environment, while integration-secret variables are not forwarded automatically. The harness can still use `git`, `gh`, the network, and other installed tools. Workspace attestation and publication guards prevent ordinary automation mistakes, not deliberate bypass by a hostile host process. Use a dedicated machine/account or external sandbox if that trust model is too broad. Event deduplication prevents the same upstream event ID from starting twice; `maxAttempts` defaults to one because retrying an agent that already performed GitHub writes may duplicate work.
