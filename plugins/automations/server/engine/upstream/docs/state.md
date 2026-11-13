# State

Mixer Automations stores local SQLite state below `$MIXER_AUTOMATIONS_HOME/.roboplane/state`:

- Stable event IDs for deduplication.
- Workflow and event snapshots for each run.
- Run status, attempts, leases, activation data, and errors.
- Durable retry eligibility, deadlines, cancellation requests, and structured outcomes.
- Generation-fenced ownership and terminal lifecycle outbox deliveries.
- Event-source health and the next startup retry time.
- Extension-owned cursors such as GitHub polling and scheduler positions.
- Replay requests, lineage, workflow selection, and synthetic replay events.
- Reroute requests linking one preserved source event to its synthetic rerouted event.
- Lease-fenced step attempts and durable parent/child admission keys.
- Scripted Safe Action request keys, input hashes, and the requesting step attempts.
- Action proposals, atomically persisted plans and effects, and execution receipts.

GitHub issue and pull-request continuity notes live separately as plain Markdown:

```text
$MIXER_AUTOMATIONS_HOME/.roboplane/cases/github/<owner>/<repo>/<issue-or-pr>/<number>/memory.md
```

The selected agent reads and rewrites the note on each related run. Same-case runs are serialized. Closed-case notes are retained for 24 hours, then garbage-collected only after live GitHub closure verification; a reopened case is retained again. There is no companion metadata file.

The GitHub extension also collects expired local suppression markers and confirmed, finalized publication receipts after seven days. Pending or uncertain publication receipts are retained until they can be reconciled. Use `mixer-automations github gc --dry-run` to inspect candidates without changing state, or `mixer-automations github gc` to apply the revalidated plan. This collector never mutates GitHub.

Run/event history, polling cursors for active workflows, failure-report idempotency records, and worktree mirror caches are not removed by GitHub garbage collection.

Core run-history retention is configured separately with `history.retention`, which defaults to seven days. At daemon startup and hourly, terminal runs older than that duration are removed together with their per-run logs and run-owned action, artifact, handoff, lifecycle, and replay details. Cleanup skips active work and any lifecycle or action state that is unfinished. Event rows and route tombstones remain after detailed history expires, preserving upstream event deduplication. The default `mixer-automations automations list` view shows only the previous 24 hours unless `--all` or `--since` is used.

Graceful shutdown stops event sources and drains accepted runs before closing the database. `runtime.shutdownTimeout` bounds that drain; after it expires, active work is interrupted.

An interruption during preparation or same-case waiting is always safe to recover and does not consume an agent attempt. An interruption after the agent starts is returned to the queue only while it remains below `runtime.maxAttempts`. The default is one, so a process interrupted after potentially performing GitHub writes is not automatically replayed.

Keep the state directory on persistent storage and do not delete it while the daemon is running.

Scripts are never automatically restarted after execution begins, even if agent retries are enabled. Abandoned execution is interrupted. Explicit step retries are separate and opt-in. Retention removes step history with its run and preserves records needed by active parent/child work. Admission links remain while either run is retained. A replay gets new admission keys because it has a new parent ID.

Scripted action requests are deduplicated by run, step, and request key. A retry with identical input returns the existing proposal; changed input is rejected and audited. Only a successful requesting attempt confirms a proposal for application. Recovery discards unplanned proposals from interrupted scripts. Prepared action plans are reconciled separately without restarting the script, subject to live-state checks, cancellation, and deadlines. Retention removes request keys with their run. Inspect `actions`, `plan`, and `effects` with `mixer-automations automations inspect <run> --json` to distinguish proposal acceptance from execution.
