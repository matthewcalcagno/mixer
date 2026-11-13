# Automations configuration

Mixer Automations ships RoboPlane's engine from `main`, pinned to
`804ad41a301e6674cc7f4e72093adaed8f58e293`. It runs inside the built-in plugin process;
you do not need a separate RoboPlane installation or daemon.

## Configuration and storage

Edit `$MIXER_HOME/automations/config.json` in the workflow sidebar. This is separate from
the Mixer daemon's `$MIXER_HOME/config.json`. Restart **Automations**, not the host daemon,
after changing engine configuration. Workflow edits are watched by the engine.

| Path relative to `$MIXER_HOME`   | Owner                                                                   |
| -------------------------------- | ----------------------------------------------------------------------- |
| `automations/`                   | Workflow files, configuration, and the Ask AI workspace                 |
| `.mixer-automations/state/`      | Engine SQLite history, leases, event routing, and Safe Action records   |
| `.mixer-automations/workspaces/` | Disposable run workspaces and the repository mirror cache               |
| `.mixer-automations/cases/`      | Engine-owned case memory                                                |
| `.mixer-automations/logs/`       | Full engine and per-run logs                                            |
| `.mixer-automations/extensions/` | Trusted local engine extensions                                         |
| `automation-state/runs/`         | Read-only history from the replaced native executor and history imports |

Old native scratch directories, scheduler checkpoints, and receipts are left untouched. They are
not coerced into engine state or deleted by the new retention policy.

The engine uses a short, owner-only control-socket directory when the host path would exceed
Unix socket limits. Scripted handoffs use that socket and the CLI bundled with Mixer.

Fresh installations create the generic starter below. Configure the Jira URL and provide the
referenced host environment variables before starting workflows. An empty scheduler or worktree
object uses the imported engine's enabled defaults. Existing configuration is never overwritten.
The settings icon beside Refresh opens `config.json` in a headerless Automations editor tab;
configuration stays hidden from the workflow tree. Use Save or the editor shortcut to save drafts.
Ask AI remains available when integration configuration is incomplete, so it can help edit the file.
An installation with native `automation-state` data pauses the new engine until you review
configuration and click **Start**. Safe Actions use the imported engine's policies and effect
reconciliation, not the native executor's former per-run confirmation UI. Legacy proposals
remain read-only and are never submitted by the imported engine.

## Engine settings

The configuration contract is the imported engine's contract, not the former native subset.
See the pinned [configuration reference](../plugins/automations/server/engine/upstream/docs/configuration.md),
[GitHub integration](../plugins/automations/server/engine/upstream/docs/github.md), and
[Jira integration](../plugins/automations/server/engine/upstream/docs/jira.md).
References there to `.roboplane/` describe the upstream layout; Mixer uses the paths above.

```json
{
  "runtime": { "mode": "managed" },
  "history": { "retention": "1d" },
  "extensions": {
    "jira": { "baseUrl": "https://jira.example.com", "token": "${JIRA_TOKEN}" },
    "scheduler": {},
    "worktree": {},
    "opencode": { "env": { "GITHUB_TOKEN": "${GITHUB_TOKEN}", "JIRA_TOKEN": "${JIRA_TOKEN}" } },
    "github": {
      "token": "${GITHUB_TOKEN}",
      "pollInterval": "5m",
      "publishGuard": { "enabled": true, "maxChangedFiles": null },
      "failureReports": { "enabled": false }
    }
  }
}
```

Environment references are saved as literal references, never replaced with secrets in the file.
Draft saves validate the engine schema without resolving integration variables. Missing values
still block engine startup, including references in disabled extension objects. Remove unused references or supply
their variables in the host daemon's environment. Do not copy tokens into Git. Literal values
are plaintext on disk and remain readable by trusted local tools.

`extensions.mixer.agentProvider` selects the Mixer agent used for **Ask AI**. Workflow `agent`,
`model`, and `thinking` fields belong to the imported engine and its harness providers. Workflow
execution stays behind those execution providers; launching an ordinary Mixer agent must not
bypass container, workspace, or publication protections. Agent CLIs still need their own setup.
When no editing agent is configured in the file, the Ask AI picker stores its choice in Mixer
preferences. Editing conversations do not require or inject the workflow harness's environment map.

Ask AI receives the installed extension SDK and documentation paths, host-specific storage paths,
and bundled CLI validation instructions. It can author local engine extensions with event sources,
namespaced frontmatter, and Safe Actions without changing Mixer. Checks use an isolated home and
fixtures, not production credentials. Installation into the live extensions directory and activation
require authorization because extensions run unsandboxed host code. New engine extensions are
enabled by default, so unreviewed code must stay outside the live extensions directory.

## Workspaces and Safe Actions

Use the imported [workspace lifecycle](../plugins/automations/server/engine/upstream/docs/workspaces.md)
and [Safe Action contract](../plugins/automations/server/engine/upstream/docs/safe-actions.md).
Repository runs use a mirror cache and disposable worktrees. Scratch runs have ownership markers;
cleanup and interrupted-run recovery belong to the engine. Unpublished workspace files are not
durable reports. Case memory is stored separately from disposable workspaces.

Engine protocol markers and reserved workflow environment variables use `MIXER_AUTOMATIONS_*`,
including `MIXER_AUTOMATIONS_RESULT`, `MIXER_AUTOMATIONS_HANDOFF`, and `MIXER_AUTOMATIONS_RUN_ID`.
Use the scripted `mixer-automations` helper for workflow handoffs and queries; the host `mixer`
CLI is separate. Extensions import `@mixer/automations-sdk`. The bundled docs and examples use
these same names. Existing workflow prompts, shell scripts, and local extensions must adopt
the new names before running. The old markers and helper are not aliases.

Source attribution and RoboPlane history import keep their original names. Engine IDs, SQLite
tables, database/PID filenames, and workspace ownership markers retain their stored formats so
the rename does not discard history or break cleanup. Mixer never shares RoboPlane's writable state.

## Source ownership and verification

The snapshot lives in `plugins/automations/server/engine/upstream`. `provenance.json` records its
source revision and original/imported SHA-256 hashes. Do not hand-edit that snapshot. Update
`scripts/import-automations-engine.mjs` for reviewed integration seams, then re-import it.

The recorded adaptations cover the public Mixer Automations namespace, opt-in storage paths,
packaged SDK lookup and local extension dependency bundling, the control socket, draft-schema export, and
Electron's Node subprocess flag. `engine/sqlite.ts` bridges the synchronous driver surface to
Node's built-in SQLite while retaining upstream SQL, migrations, and transaction boundaries.
The original control server is extracted during build rather than reimplemented.

```bash
node scripts/import-automations-engine.mjs --verify
npm run build:automations-engine
```

The engine requires Node 24 or newer. Its ESM runtime, workflow helper, SDK, and documentation
are built with the daemon. The upstream tests are preserved and use the same SQLite bridge.
Run focused files through the existing `@mixer/builtin-plugins` test script; do not run the full
engine suite locally. Mixer's server plugin suite covers packaging, handoffs, replay, migration
activation, and the editor/RPC boundary.

`packages/server/scripts/bundle-automations-engine.mjs` places the private workspace and its
runtime dependency closure inside the server package. Do not rely on a separately published
`@mixer/automations-engine`. After `npm run build:server`, run
`node scripts/check-automations-package.mjs` to execute a parent/child workflow from an extracted
server tarball outside the checkout.
