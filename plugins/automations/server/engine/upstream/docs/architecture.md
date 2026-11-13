# Architecture

Mixer Automations runs event-driven agent or scripted workflows:

```text
GitHub polling/webhook, Jira polling, or schedule
              ↓
       workflow matching
              ↓
 disposable worktree or scratch directory
              ↓
  checkout attestation
              ↓
   agent process or sequential shell steps
              ↓
 guarded git/GitHub publication
              ↓
 serialized Safe Action validation
```

Core owns global workflow discovery, event routing and deduplication, the durable run queue, fenced leases, retries, deadlines, cancellation, terminal lifecycle delivery, Safe Action policy enforcement and persistence, logging, SQLite state, extension registration, and process lifecycle.

The bundled Jira extension owns scheduled JQL discovery, per-version delivery receipts, live issue activation, and per-issue resource keys. Each issue starts an independent run. Jira credentials and REST behavior remain outside core; see `mixer-automations docs jira`.

Markdown harnesses submit Safe Action proposals through their result envelope. Scripted steps submit them through the scoped `mixer-automations actions request` command. Both paths use the same action gate, persisted plans, effect receipts, and extension handlers. A scripted request is admitted under the active step's fenced lease, deduplicated across retries, and applied only after successful execution and session cleanup. Core owns this request lifecycle; the extension owns the external operation and its live-state checks.

Extensions own event sources, workspaces, agent CLI adapters, and integration-specific Safe Actions. GitHub and Jira are bundled event integrations. The selected agent process owns repository inspection, file edits, tests, and normal `git` and `gh` usage. Mixer Automations verifies the effective checkout before launching the harness and gives each run one GitHub branch capability: claim one new branch, update one exact same-repository PR head owned by the PAT account or explicitly allowlisted in workflow frontmatter, or operate review-only. Guarded PR pushes record a same-run publication chain. Explicit GitHub approval and merge actions remain extension-local and are independently bound to workflow policy, activated PR identity, the activated or latest confirmed same-run head, and refreshed live state.

The bundled `webhooks` extension owns the single optional webhook listener. Provider extensions register source-bound input handlers through the public SDK instead of creating their own HTTP servers. Endpoint definitions select handlers under `$MIXER_AUTOMATIONS_HOME/webhooks`. Without enabled HTTP endpoints, no listener starts. GitHub polling, schedules, and manual runs remain independent. `packages/cli/src/webhook-ownership.test.ts` checks that first-party provider code does not create HTTP servers.

The GitHub extension also owns per-issue and per-pull-request continuity. It injects a global `memory.md` into related runs, serializes work on the same case, and garbage-collects the note 24 hours after closure. It reports terminal workflow failures as sanitized issues in the run's effective repository. Core exposes the terminal lifecycle but remains unaware of GitHub case and issue semantics.

There is deliberately no planner/reviewer pipeline, DAG, publishing layer, or GitHub abstraction in core. Managed runs require a small versioned outcome envelope, but the selected harness still owns repository inspection, reasoning, edits, and tests.

SQLite is the scheduler. Workers claim eligible runs with a generation-fenced lease; stale generations cannot update or finalize a reclaimed run. Retry eligibility, cancellation requests, deadlines, outcomes, and terminal lifecycle deliveries survive daemon restarts.

All workflow configuration remains global under `$MIXER_AUTOMATIONS_HOME`; repository files cannot create or modify Mixer Automations workflows. Core discovers `.md`, `.yaml`, and `.yml`, owns fenced step history and child admission, and dispatches executors. The steps extension owns shell semantics through `api.workflows.registerRunner`. Detached handoffs share the daemon queue but have independent workspaces and outcomes. Read-only extension queries keep integration credentials in the daemon.

## Trust boundary

The host harness is trusted with the user's normal account authority. It inherits the home directory and ordinary execution variables, but integration-secret variables are not forwarded automatically. It may access the filesystem and network. Directory flags, attestation, and publication guards prevent ordinary automation mistakes; they are not a security sandbox and a malicious harness could deliberately bypass them. Use an externally sandboxed machine if you do not trust the harness or repository content.
