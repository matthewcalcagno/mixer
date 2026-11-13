# Configuration

Scripted `.yaml` and `.yml` workflows use the same queue, concurrency, deadlines, workspace providers, and retention as agents. The bundled `steps` extension is enabled by default and requires no credentials. Retries are explicit per-step; `runtime.maxAttempts` does not restart scripts after execution begins. `extensions.steps.env` explicitly opts selected values into every scripted run and supports the existing configuration environment placeholders. Workflow and step `env` values are literal strings. Integration secrets are never forwarded automatically; prefer scoped read-only daemon queries. Read `mixer-automations docs scripted-workflows` for the complete schema and credential examples.

Mixer Automations reads global JSON configuration from `$MIXER_AUTOMATIONS_HOME/.roboplane/config.json`, which defaults to `~/.roboplane/.roboplane/config.json`. `MIXER_AUTOMATIONS_HOME` remains the outer working directory; do not point it at the inner `.roboplane/`. The file is optional. `mixer-automations init` creates the smallest useful explicit configuration:

```json
{
  "runtime": {
    "concurrency": 1
  },
  "history": {
    "retention": "7d"
  },
  "extensions": {
    "github": {}
  }
}
```

Built-in extensions and agent harnesses load automatically. `extensions.<name>.enabled` explicitly enables or disables an extension; when omitted, extensions are enabled by default. Mixer Automations removes this reserved field before returning the remaining settings through `api.config.get()`. Empty scheduler, worktree, or agent entries are unnecessary.

## Working directory

Workflows live under `$MIXER_AUTOMATIONS_HOME/automations` and local extension code lives under `$MIXER_AUTOMATIONS_HOME/extensions`. Configuration, cases, logs, SQLite state, daemon PID and socket files, and workspaces live under `$MIXER_AUTOMATIONS_HOME/.roboplane`. Initialization adds `/.roboplane/` to the outer `.gitignore` without replacing existing rules.

Optional webhook definitions live under `$MIXER_AUTOMATIONS_HOME/webhooks`. The bundled extension opens no listener without enabled HTTP endpoints. `extensions.webhooks.listener.enabled: false` permits local CLI delivery without HTTP. `extensions.webhooks.enabled: false` disables the entire capability. Read `mixer-automations docs webhooks` for listener settings and secret references. There is no MCP configuration section; harnesses load their own MCP configuration.

The nested directory contains durable state and credentials, not merely a disposable cache. Keep it on persistent storage and use the resolved SDK paths when writing extension-owned files.

## Runtime

All runtime fields are optional:

| Field | Default | Meaning |
| --- | ---: | --- |
| `mode` | `managed` | `managed` requires a reported outcome when possible; `unsafe-direct` derives a legacy best-effort outcome. It does not change process isolation. |
| `concurrency` | `1` | Maximum runs executing simultaneously. |
| `maxQueuedRuns` | `1000` | Maximum runs admitted to the durable queue. |
| `maxAttempts` | `1` | Maximum agent attempts. Values above one can repeat external effects after an uncertain failure. |
| `timeout` | `3600000` | Total run deadline in milliseconds. |
| `noOutputTimeout` | `600000` | Maximum agent silence in milliseconds before termination. |
| `shutdownTimeout` | `300000` | Time allowed for active work to drain during shutdown. |

Unknown top-level and runtime keys are rejected so spelling mistakes cannot silently select defaults.

## Run history

`history.retention` is the single lifetime for terminal run records and their per-run log files. It defaults to `7d` and accepts a positive duration using `ms`, `s`, `m`, `h`, `d`, or `w`, for example `24h`, `7d`, or `2w`.

```json
{
  "history": {
    "retention": "24h"
  }
}
```

The daemon removes expired terminal runs at startup and hourly. It removes the run's Safe Action records, plans, effects, artifacts, handoffs, delivered lifecycle records, replay request, and `<run-id>.log` together. Active runs, unfinished lifecycle delivery, actions that may still execute, and the source or root of an active replay are retained regardless of age. Lightweight event and route records remain so an old upstream event is still deduplicated after its detailed run history expires.

The default `mixer-automations automations list` view is a fixed rolling 24-hour window independent of retention. This keeps the everyday view compact while `mixer-automations automations list --all` can show older retained history when retention is longer. `roboplane.log` and `daemon.log` are operational daemon logs rather than per-run history and are not removed with an individual run.

## Environment references

Any configuration string can reference an environment variable:

```json
{
  "extensions": {
    "github": {
      "token": "${GITHUB_TOKEN}"
    }
  }
}
```

The token may instead be written literally as `"token": "github_pat_..."`. This is supported, with the usual caveat that the credential is then stored in clear text in `config.json`; `mixer-automations init` creates that file with owner-only permissions. A missing reference fails with its exact configuration path. Mixer Automations does not read a private `.env` file. Variables exported by `.zshrc` are available when Mixer Automations is launched from that interactive shell; launchd, systemd, containers, and other supervisors must configure their own environment.

## GitHub authentication

The GitHub extension resolves authentication in this order:

1. `extensions.github.token`, when configured;
2. the token returned by `gh auth token`.

Use `gh auth login` for the normal local setup. An explicit token remains useful for service installations or choosing a particular credential. The shared `github.events` handler resolves the `secretEnv` named in its endpoint definition. GitHub has no standalone webhook listener; the old `extensions.github.webhook` setting is rejected. Listener settings belong under `extensions.webhooks`. Repository-event polling remains enabled by default; set `extensions.github.polling: false` for webhook-only collection.

The extension reports distinct errors when GitHub CLI is missing, GitHub CLI is unauthenticated, a configured environment reference is absent, or GitHub rejects the selected credential. Inspect setup failures with:

```bash
mixer-automations extensions inspect github
```

GitHub control-plane credentials are not automatically passed to agent processes. The agent uses the installed `gh` and Git authentication available through its normal home directory.

## Agent harnesses

There is no top-level `agents` configuration. Codex, Claude, OpenCode, Pi, and Copilot use their own installed CLI authentication and configuration.

Harness extension sections are needed only for real overrides:

```json
{
  "extensions": {
    "codex": {
      "command": "/opt/tools/codex",
      "timeout": 7200000,
      "env": {
        "MY_EXPLICIT_AGENT_SETTING": "value"
      }
    }
  }
}
```

`env` is an explicit opt-in to pass values to that harness. Do not place GitHub integration credentials there.

## Other extension settings

`extensions.jira` configures the bundled Jira Data Center integration. Set `baseUrl` and `token` together when subscribing to `jira.issue`; an unused Jira extension requires neither. Optional `pageSize` and `requestTimeoutMs` bound requests. Credentials are separate from harness MCP configuration. Read `mixer-automations docs jira` for the supported REST version, cron and JQL frontmatter, and delivery semantics.

`extensions.github` supports the token, polling, webhook, API URL, Git author, publication-guard, and global failure-report settings documented by `mixer-automations docs github`. Failure reports default to enabled; set `extensions.github.failureReports.enabled` to `false` to suppress automatic failure issues for every repository and workflow while retaining local run records and logs. `extensions.worktree` is needed only to override `git`, `cloneBaseUrl`, `cloneToken`, or workspace cleanup. `extensions.scratch.cleanup` defaults to `true`; set it to `false` only to retain repository-less run directories for diagnosis. Local extensions own and validate their own sections.

Older configurations containing `agents.<name>.apiKey` must remove that section and authenticate the installed CLI. If API-key authentication is intentionally required, configure the appropriate variable explicitly under `extensions.<agent>.env`. Replace the former `extensions.github.writerToken` alias with `extensions.github.token`; obsolete keys fail with an actionable configuration error instead of being ignored.
