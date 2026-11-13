# Operating Mixer Automations

For scripted YAML, run `mixer-automations automations validate`, then `mixer-automations automations files`. Start the daemon before workflows invoking children or read-only extension queries. Inspect steps using `mixer-automations automations inspect <run> --json` and `mixer-automations automations logs <run> --step <id>`. Interrupted scripts require explicit replay. Parent completion means accepted handoffs, not completed children. Read `mixer-automations docs scripted-workflows` and `mixer-automations docs workflow-handoffs`.

```bash
mixer-automations init
gh auth login
mixer-automations github status
mixer-automations github gc --dry-run
mixer-automations automations create maintainer --repository owner/repo --agent claude --model claude-opus-4-6 --thinking high
mixer-automations automations validate
mixer-automations start --foreground
```

Use a GitHub account and token with exactly the repository access you want the automation to have. The GitHub extension uses the token to poll or receive events. Agent processes use the user's normal home-directory `gh` and Git authentication but do not automatically inherit integration-secret environment variables.

By default the GitHub extension obtains its token from `gh auth token`. To override it, set `extensions.github.token` to a literal token or an environment reference such as `${GITHUB_TOKEN}`. Mixer Automations does not load `$MIXER_AUTOMATIONS_HOME/.env`; a shell or service manager must provide referenced variables when it starts Mixer Automations.

The account returned by `gh api user` must match the configured PAT account. Mixer Automations checks this before every guarded agent run and fails closed on a mismatch. This prevents the polling identity and publishing identity from silently diverging.

Each event is deduplicated by its stable upstream ID, and each workflow/event pair has one durable run route. Event acceptance and matching run creation are committed together with a configured queue bound. Runs are scheduled directly from SQLite and visible through `mixer-automations automations list`, `inspect`, and `logs`.

`mixer-automations automations list` shows active work and the previous 24 hours by default, ordered so current runs appear at the bottom. Use `mixer-automations automations list --all` for all retained history or `mixer-automations automations list --since 6h` for a different rolling window. Terminal run metadata and its `<run-id>.log` share the single `history.retention` lifetime; the daemon prunes them at startup and hourly.

On graceful stop or restart, Mixer Automations stops event ingestion and waits up to `runtime.shutdownTimeout` for accepted work to finish. Pre-agent interruptions recover without consuming an attempt. Claims use generation-fenced leases, and lease loss aborts stale execution. Retry delay, cancellation, deadline, outcome, and terminal lifecycle delivery are durable.

Use `mixer-automations automations cancel <run> --reason "..."` to stop one queued or active run. Use `mixer-automations status` to inspect persisted event-source health.

Use `mixer-automations automations rerun <run-id>` when a terminal run needs to inspect its triggering case again. Replay is submitted to the running daemon, uses a new durable run, performs live activation, and preserves lineage for publication deduplication. It never resets or mutates the source run.

Local GitHub continuity and publication metadata is collected conservatively at daemon startup and hourly. `mixer-automations github gc --dry-run` lists eligible records; `mixer-automations github gc` applies the same plan after revalidating every target. Uncertain remote-write receipts are protected from age-based deletion.

A terminal workflow failure is always retained in the local run record and log. When the workflow has a GitHub repository, the GitHub extension also attempts to open a sanitized failure issue in that exact repository unless global reporting is disabled with `extensions.github.failureReports.enabled: false`. Ensure the PAT has Issues write permission if you want this visible GitHub record. A failure to publish the report is logged locally and does not recursively create another report.

`mixer-automations automations inspect <run>` includes the effective, attested checkout or scratch directory rather than only the configured workspace provider. A run fails before the harness starts if workspace path, provenance, repository, revision, or initial cleanliness does not match its activation.

The daemon must remain running. Use systemd, launchd, or another ordinary process supervisor on an always-on machine. A signed GitHub webhook is preferred for timely delivery; polling works without a public endpoint.

Autonomous mode grants the selected harness the same authority as launching it manually in unattended mode. Use a dedicated OS account, machine, VM, or container when stronger isolation is required.
