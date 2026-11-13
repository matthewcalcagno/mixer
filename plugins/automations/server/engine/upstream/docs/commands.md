# Commands

```text
roboplane
mixer-automations init
mixer-automations automations create <kind> --repository owner/repo [--agent name] [--model model] [--thinking mode] [--name name] [--force]
mixer-automations automations validate [workflow] [--json]
mixer-automations automations files
mixer-automations start [--foreground]
mixer-automations stop [--wait]
mixer-automations restart
mixer-automations status
mixer-automations automations run <name> [-r owner/repo | --repo owner/repo | --repository owner/repo] [--input JSON | --input-file path|- | --arg key=value] [--wait] [--json] [--inherit-event] [--handoff-key key]
mixer-automations actions request <name> --input-json JSON --request-key key [--json]
mixer-automations automations rerun <run> [--current] [--wait] [--json]
mixer-automations events reroute <event> [--wait] [--json]
mixer-automations events explain <event> [--json]
mixer-automations events emit <endpoint> --id <delivery-id> [--input JSON | --input-file path|- | --arg key=value]
mixer-automations webhooks list
mixer-automations webhooks deliveries
mixer-automations webhooks reload
mixer-automations automations list [--all | --since duration] [--limit count]
mixer-automations automations inspect <run> [--json]
mixer-automations automations logs <run> [--follow] [--step id]
mixer-automations automations show <name> [--json]
mixer-automations logs [--follow]
mixer-automations extensions list
mixer-automations extensions create <name> [--template event-source|workflow-field]
mixer-automations extensions validate <name>
mixer-automations extensions inspect <name>
mixer-automations extensions enable <name>
mixer-automations extensions disable <name>
mixer-automations extensions reload <name>
mixer-automations docs [topic]
mixer-automations docs --path
mixer-automations docs --search <text>
mixer-automations docs configuration
mixer-automations docs workflow-authoring
mixer-automations docs scripted-workflows
mixer-automations docs workflow-handoffs
mixer-automations docs webhooks
mixer-automations docs maintainer-examples
mixer-automations docs example-maintainer-01-issue-intake
mixer-automations github status
mixer-automations github triggers [--json]
mixer-automations github gc --dry-run
mixer-automations github gc
mixer-automations github pr can-merge --event-file path [--output path] [--json]
mixer-automations github pr can-merge --repository owner/repo --number N [--output path] [--json]
```

`mixer-automations init` creates the global configuration and directories. It writes an explicit `runtime.concurrency` of `1` and does not create or load a private `.env` file; `mixer-automations docs configuration` describes credential options and the full schema. `mixer-automations automations create maintainer` creates a compact starter set for issue triage, PR review, PR feedback, weekly maintenance, and scheduled maintenance checks. The comprehensive GitHub maintainer example pack is documented by `mixer-automations docs maintainer` and lives in `examples/maintainer`. All active workflows are written below `$MIXER_AUTOMATIONS_HOME/automations`.

Settings and private working files live under `$MIXER_AUTOMATIONS_HOME/.roboplane`. `MIXER_AUTOMATIONS_HOME` identifies the outer working directory; workflows remain directly under it.

`roboplane` with no arguments and `mixer-automations status` print the same read-only overview. It shows daemon status, attention counts, separate automation and evaluation execution tables, and last recorded event-source health. Terminal runs use the previous 24 hours based on their last update; queued and active runs are included regardless of age. Each table shows at most five runs, ordered by last update with the newest first, regardless of status or outcome. Totals include every matching retained run. Workflow names omit unnecessary directory prefixes; names shared by different workflows retain enough of their path to distinguish them. The result column shows task outcomes such as `Blocked` and `No-op` instead of `completed (blocked)`. Evaluation executions are identified by their event source and are not counted again as automations. Reports and pending evaluation evidence remain available through `mixer-automations evaluations status`.

Source warnings with the same provider, status, and reason appear as one group with a source count. Interactive terminals use colored headings and results; redirected output stays plain. `NO_COLOR` disables colors. Terminals narrower than 80 columns show each run on two lines instead of a table.

The overview does not initialize the home, load extensions, recover runs, or start work. An empty home shows setup guidance. Both commands preserve the daemon-status exit convention: `0` when the recorded daemon PID is alive, `1` when it is stopped. Recent run failures do not change the exit code. `mixer-automations --help` still prints command help.

`mixer-automations docs workflow-authoring` is the complete workflow reference. It contains the strict frontmatter schema, every GitHub matcher, polling and webhook action coverage, schedule syntax, examples, lifecycle limitations, and validation procedure. `mixer-automations docs maintainer-examples` explains the repository-maintainer example pack, and every workflow is installed as an individual `example-maintainer-*` documentation topic.

`mixer-automations automations validate` checks Markdown frontmatter or YAML syntax and steps, repositories, providers, triggers, and policies without executing commands. A workflow path validates one file, including disabled files. `--json` emits `ok`, workflow IDs, diagnostics, and extension errors. `mixer-automations automations files` prints repository, workspace, triggers, execution type, and agent settings or step names.

`events emit` submits input to a configured endpoint through the running daemon without HTTP. One input form is required. `webhooks list`, `deliveries`, and `reload` inspect or reload the optional endpoint host through the daemon. All return JSON. Read `mixer-automations docs webhooks` for authentication and deduplication rules.

Repository-less workflows automatically use the built-in disposable `scratch` workspace. `mixer-automations automations files` prints the resolved workspace for every workflow. See `mixer-automations docs workspaces`.

`mixer-automations automations list` always shows queued and active runs plus up to 50 terminal runs updated during the previous 24 hours. It selects the newest terminal runs in that window, prints them from oldest to newest, and places active runs last, leaving current work next to the terminal prompt. `--since 6h` replaces the 24-hour window, `--all` shows all retained history, and `--limit 100` changes the terminal-history limit without hiding active runs. `--all` and `--since` cannot be combined. Durations accept `ms`, `s`, `m`, `h`, `d`, or `w`. Configure the lifetime of run records and their per-run logs with `history.retention`; see `mixer-automations docs configuration`.

```bash
mixer-automations automations list --all
mixer-automations automations list --since 6h
mixer-automations automations list --limit 100
```

`mixer-automations automations run` uses the workflow's agent or steps executor. `--input` becomes manual event data. `--input-file` reads JSON immediately and is mutually exclusive with `--input`. Multi-repository workflows require `--repository owner/repo`; one command creates at most one repository-bound run. Exact `.md`, `.yaml`, and `.yml` paths work; extensionless paths must be unique.

`automations run` and `automations rerun` require the running daemon and return after durable admission by default. They print a short queued confirmation and the new run ID, so the terminal remains available. Add `--wait` to wait for the final outcome. `--json` prints one submission response by default, or one terminal result with `--wait`. There is no standalone execution fallback and no `--detach` flag.

If the daemon is stopped, submission fails with: `Mixer Automations is not running. Start it with \`mixer-automations start\`.`

Repository selection accepts `--repository`, `--repo`, and `-r`. Input forms are mutually exclusive: `--input` accepts JSON text, `--input-file` reads JSON from a file or stdin with `-`, and repeated `--arg key=value` creates string fields. Inputs are limited to 48 KiB. Duplicate argument names are rejected. Values containing `=` or an empty value are allowed.

```bash
mixer-automations automations run issue-triage -r inditex/web-zarafront --arg issue=123
mixer-automations automations run issue-triage --input '{"issue":123}' --wait
cat payload.json | mixer-automations automations run issue-triage --input-file -
```

`automations list` shows executions. `automations files` shows enabled, disabled, and invalid definitions under `automations/`. `automations show <name>` prints one definition and its resolved settings. Names can omit their extension and include nested paths; ambiguous names require the exact filename.

Root `logs` prints daemon logs and exits. `automations logs <run>` prints one run's logs and exits. Only `--follow` keeps either log command attached. `start` and `restart` launch the daemon in the background by default; `start --foreground` is the explicit foreground mode. `stop` returns after requesting shutdown; `stop --wait` waits for it to finish. `restart` returns after requesting a background restart, while the new process waits for the old daemon to finish shutdown. Check readiness with `status`.

Inside scripted steps, `automations run` is detached by default and rejects `--wait`. `--inherit-event` preserves the target through independent live child activation; JSON input never transfers permissions. `--handoff-key` deduplicates child admission within a step. Read `mixer-automations docs workflow-handoffs` for the full contract.

`mixer-automations actions request` requires an active scripted step and the running daemon. It records a declared Safe Action proposal, not a completed effect. Identical requests with the same run, step, and key return the same proposal across retries. The action executes only after successful workflow execution and session cleanup. Read `mixer-automations docs scripted-workflows` for authorization and failure behavior.

`inspect --json` emits `run`, `steps`, optional `parentRunId`, `childRunIds`, `actions`, optional `plan`, and `effects`. Human inspection includes step attempts, tolerated failures, and Safe Action statuses. Inspect the final action status rather than treating proposal acceptance as completion. `logs --step id` filters structured records and supports `--follow`.

## Rerun an automation

Use replay when a persisted run reached a terminal status but should process its original case again. Common examples are an interrupted run that was not automatically retried, a completed run whose required external response could not be published, or a run that should be repeated after improving its workflow prompt.

```bash
mixer-automations automations rerun <run-id>
```

Replay does not reset, edit, or resume the source row. It creates a new audited event and run linked to the source run. The original run remains available through `mixer-automations automations inspect`, and the new run receives its own ID, status, log, workspace, attempts, activation snapshot, and publication receipts.

The daemon must be running because replay is submitted through Mixer Automations's local control socket. This keeps replay creation and execution in the same process that owns the queue, concurrency limit, GitHub case locks, event sources, and extension state.

```text
Mixer Automations is not running. Start it with `mixer-automations start`.
```

### Options

| Option | Behavior |
| --- | --- |
| Default | Use the immutable workflow snapshot stored with the source run. This gives the most reproducible rerun. |
| `--current` | Use the currently installed workflow with the same workflow ID. Use this after intentionally correcting or improving the workflow. The current workflow must exist and validate successfully. |
| `--wait` | Wait for the new run to reach a terminal status. The command exits successfully only when the replay completes successfully. |
| `--json` | Print the replay request result as JSON for scripts instead of the human-readable summary. |

The default output identifies the new run. Detailed lineage remains available through inspection:

```text
Queued rerun of rp_8cf2b77c63da
Run: rp_123456789abc
```

Use the new run ID with ordinary inspection commands:

```bash
mixer-automations automations inspect rp_123456789abc
mixer-automations automations logs rp_123456789abc --follow
mixer-automations automations list
```

`mixer-automations automations inspect` includes a `Rerun` section with the immediate source run, root lineage, definition selection, and request timestamp.

### Eligibility and concurrency

Only terminal runs can be replayed:

- `completed`
- `failed`
- `cancelled`
- `interrupted`

Runs in `queued`, `preparing`, `waiting`, or `running` cannot be replayed. Wait for the existing run to finish rather than creating competing work. Only one replay in the same root lineage may be active at a time; this prevents concurrent replays from racing on the same issue, pull request, memory file, branch, or publication target.

Each replay receives a unique synthetic event ID, so it can create a new run without weakening normal upstream-event deduplication. The synthetic event records:

- the immediate source run ID;
- the root run ID shared by later replay generations;
- the source event ID.

Replay always targets exactly the source workflow. It does not rematch the event against every installed workflow and cannot unexpectedly start unrelated workflows.

### Live activation

Workflow selection may use a historical snapshot, but extension activation is always live. Immediately before execution, Mixer Automations asks the original event source to refresh authoritative state and checkout information.

For GitHub events this means Mixer Automations refreshes the current issue or pull request, verifies the original triggering comment or review when applicable, obtains the current exact revision, and creates a fresh disposable checkout. A replay therefore does not operate blindly on the source run's old checkout or cached activation data.

A replay can fail safely when the original target no longer exists, a triggering comment was deleted or changed incompatibly, the pull request is no longer writable, the current branch head violates publication protections, or the selected workflow is unavailable or invalid.

### Submitted review replay

For a submitted pull-request review, GitHub activation verifies the original review and fetches all inline comments belonging to it. This includes comments that the repository activity feed did not expose as individual events. Historical events that predate stored numeric review IDs recover the ID from their persisted GitHub review URL when possible.

Marker-bound replies are permitted only for the exact activated inline threads, independently of branch-write permission. Standalone inline-comment replays authorize their triggering thread too. If the triggering comment is a reply, activation verifies the thread root and uses its ID in the endpoint. Reply markers use the root replay lineage, so a later replay checks for and deduplicates replies already published by an earlier generation. Arbitrary mutating `gh api` calls remain blocked.

Example:

```bash
mixer-automations automations rerun rp_8cf2b77c63da --wait
```

This creates a new run for the same persisted review event, refreshes the pull request and review comments, and executes the selected workflow against the current pull-request head.

### Snapshot versus current workflow

Prefer the default snapshot when the workflow was correct and the failure was operational:

```bash
mixer-automations automations rerun rp_8cf2b77c63da --wait
```

Use the current workflow only when its changed instructions are intentionally part of the replay:

```bash
mixer-automations automations validate
mixer-automations automations rerun rp_8cf2b77c63da --current --wait
```

Changing the workflow does not change the original event or replay lineage. It only changes the workflow snapshot attached to the new run.

Persisted snapshots are not rewritten when the CLI changes. If a historical scripted snapshot contains removed command names, update its source definition and rerun with `--current`.

### Scripted usage

```bash
mixer-automations automations rerun rp_8cf2b77c63da --json
```

Example response:

```json
{
  "ok": true,
  "runId": "rp_123456789abc",
  "sourceRunId": "rp_8cf2b77c63da",
  "rootRunId": "rp_8cf2b77c63da",
  "workflowMode": "snapshot"
}
```

Without `--wait`, a successful command means the replay was durably created and queued, not that the workflow completed. Use `--wait`, `mixer-automations automations inspect`, or `mixer-automations automations list` when completion matters.

`mixer-automations automations list` shows execution `STATUS` and task `OUTCOME` separately. A process can finish with status `completed` while its task outcome is `blocked`. `-` means no outcome has been recorded. `automations run --wait`, `automations rerun --wait`, and `events reroute --wait` exit nonzero for explicit `blocked` or `failed` outcomes, even when execution completed. Detached success means admission only. Legacy completed runs without an outcome retain their previous successful exit behavior.

## Reroute an event

Use reroute when Mixer Automations persisted an upstream event but no workflow matched it, and corrected current workflow configuration should evaluate that same event again. A typical case is a pull-request review rejected by an incorrect label matcher that has since been fixed:

```bash
mixer-automations events reroute github:owner/repo:14412758481 --wait
```

Reroute differs from both manual run and replay:

- `run` creates a `manual` event and cannot grant capabilities derived from an original GitHub event.
- `automations rerun` requires an existing run and targets that run's workflow.
- `reroute` requires a persisted event, preserves its original type, source, actor, repository, and payload, and evaluates all current matching workflows.

The daemon must be running. Reroute creates a fresh event ID with provenance pointing to the source event, so ordinary upstream deduplication remains unchanged. The source event is never edited or deleted.

Only original upstream events that created no runs can be rerouted, and only one reroute may be accepted for a source event. If the event already created a run, use `mixer-automations automations rerun` instead. Replay and reroute events cannot themselves be rerouted. Concurrent or later attempts fail with `duplicate_reroute`. Matcher errors and queue-capacity rejection do not consume reroute eligibility, so the command can be tried again after correcting the transient problem. An accepted reroute with no matching workflows is still recorded and reports `Matched runs: none`.

For GitHub events, preserving the original event identity is security-relevant. Live activation refreshes the issue or pull request before execution, while the publication guard can still derive owned-PR or review-only capabilities from the original normalized GitHub data. Do not substitute `mixer-automations automations run --input` for this case.

Example output:

```text
Event rerouted: reroute_123456789abc
Source event: github:owner/repo:14412758481
Matched runs: rp_123456789abc
Workflows: current
```

`--wait` waits for every matched run and succeeds only when all of them complete. `--json` emits the control response for scripts. Without `--wait`, success means the rerouted event and its matched runs were durably admitted to the queue.

`mixer-automations automations inspect <run-id>` shows a `Reroute` section for matched runs, including the original source event ID and request timestamp.
