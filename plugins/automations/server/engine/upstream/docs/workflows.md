# Workflows

For the complete schema, matcher grammar, event/action matrix, examples, lifecycle caveats, and authoring checklist, run `mixer-automations docs workflow-authoring`. This page is the compact overview.

Mixer Automations reads `.md`, `.yaml`, and `.yml` recursively from `$MIXER_AUTOMATIONS_HOME/automations`. Repository-local workflow files are never discovered. Markdown invokes an agent; YAML executes ordered shell steps. Run `mixer-automations docs scripted-workflows` for the schema and `mixer-automations docs workflow-handoffs` for CLI-based handoffs.

```md
---
name: handle-new-issues
repository: owner/repo
agent: claude
model: claude-opus-4-6
thinking: high
on:
  github.issue:
    events: [opened]
---

Handle the triggering issue. Use git and gh normally and complete the work autonomously.
```

Frontmatter has nine core concepts:

- `name` is optional and defaults to the file name.
- `disabled` is an optional boolean that defaults to `false`. Set it to `true` to exclude the workflow from active discovery without deleting or renaming its file.
- `repository` is optional. It accepts one `owner/repo` string or a non-empty list of unique `owner/repo` strings.
- `workspace` is optional. It defaults to `worktree` with a repository and `scratch` without one.
- `agent` selects a registered harness and defaults to `codex`.
- `model` is optional and is passed directly to that harness.
- `thinking` is an optional harness-specific thinking, reasoning-effort, or model-variant value.
- `on` contains extension-owned triggers; `{}` makes the workflow manual/handoff-only, without event subscriptions.
- `safeActions` optionally declares exact extension-owned actions and their policies. Omission permits none.

Extensions may register additional namespaced top-level fields with `api.workflows.registerField`; their validated values are available in `workflow.extensions`. Unknown fields are rejected. Markdown has no roles, verification declarations, or structured agent handoffs. YAML adds `env`, `defaults`, and `steps` instead of agent fields. Safe Action policies in both workflow formats are validated by their extension; see `mixer-automations docs safe-actions`.

Disabled workflows have no event subscriptions and cannot receive new event-triggered or manual runs. The daemon reloads workflow file changes automatically. Set `disabled: false` or remove the field to re-enable a workflow. Existing queued and running jobs are unchanged. Historical snapshot replay remains available, but replay with the current workflow does not. Disabled files still undergo frontmatter parsing, but runtime provider and trigger validation is skipped.

For Markdown, Mixer Automations appends event type, repository, actor, timestamp, JSON payload, and declared Safe Action schemas to the prompt. It invokes the selected CLI once in a disposable workspace. Action requests are validated after the CLI exits. YAML instead executes its steps in order and supplies activated event data through a context file; it never parses agent reports.

YAML requests declared Safe Actions with `mixer-automations actions request` from an active step. The daemon records a deduplicated proposal and applies it only after successful workflow execution and session cleanup. This uses the same action gate and extension handlers as Markdown, without a model call. Read `mixer-automations docs scripted-workflows` for the request and recovery contract.

Manual runs use the same path:

```bash
mixer-automations automations run handle-new-issues --input '{"note":"test this prompt"}'
```

Repository events select their matching repository from a configured list, while schedules run once per listed repository. Manual runs of multi-repository workflows require `--repository owner/repo`. Every resulting run still operates on exactly one repository.
