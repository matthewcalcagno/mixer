# Optional webhooks and local events

The bundled `webhooks` extension receives events independently of GitHub. It opens no HTTP listener when `$MIXER_AUTOMATIONS_HOME/webhooks` is absent, empty, or contains no enabled HTTP endpoints. Schedules, GitHub polling, and manual runs do not require webhook configuration.

`mixer-automations init` creates an empty `webhooks/` folder next to `automations/` and `extensions/`. Definitions use YAML 1.2, unique mapping keys, bounded aliases, and a 1 MiB file limit. Nested directories are supported. The relative filename without `.yaml` or `.yml` is the endpoint name.

## Configure an endpoint

Create `$MIXER_AUTOMATIONS_HOME/webhooks/build-alerts.yaml`:

```yaml
handler: webhook.json
auth:
  type: bearer
  secretEnv: BUILD_ALERT_SECRET
deliveryIdHeader: X-Delivery-ID
```

The default URL is `http://127.0.0.1:8787/webhooks/build-alerts`. Export `BUILD_ALERT_SECRET` in the environment that starts the daemon. Mixer Automations does not load `.env` files. YAML values are literal; `secretEnv` names a variable instead of embedding its value. Secrets do not become event data or workflow snapshots.

Endpoint fields are:

| Field | Default | Meaning |
| --- | --- | --- |
| `handler` | Required | Installed input handler, such as `webhook.json` or `github.events`. |
| `enabled` | `true` | Disabled definitions install no route. |
| `http` | `true` | Set to `false` for local CLI submission only. |
| `path` | `/webhooks/<name>` | Optional exact HTTP path. |

All other fields are handler configuration and must pass its schema. The default JSON handler requires bearer authentication and a stable delivery ID. It accepts any JSON value. HTTP headers are case-insensitive. `X-Delivery-ID` is the default delivery-ID header.

Only POST is accepted. Requests authenticate before JSON decoding. HTTPS exposure requires a reverse proxy or tunnel; the listener binds to loopback by default. Creating subscriptions on remote services is a separate provider-specific task.

## Subscribe an automation

Create `$MIXER_AUTOMATIONS_HOME/automations/build-failure.md`:

```markdown
---
agent: codex
on:
  webhook.received:
    endpoints: [build-alerts]
    payload:
      status: [failed]
      build.environment: [production]
---
Investigate the failed production build described in the event payload.
```

The event data is `{ "endpoint": "build-alerts", "payload": <original JSON> }`. Endpoint alternatives combine with OR. Payload fields combine with AND, while values within a field combine with OR. Values compare exactly, including their JSON types. A missing field does not match. Dot-separated paths access nested objects, not array indexes. Filters allow at most 64 fields, 32 scalar alternatives per field, and 10 path segments. Omitting both filters matches all generic webhook events.

Each matching automation receives an independent run. Acceptance can produce zero runs. Filters select work; they do not grant Safe Action authority. For more complex matching, register a provider-owned event source and matcher instead of embedding expressions in YAML.

## Submit without an HTTP server

Set `http: false` in the endpoint, or disable the listener globally:

```json
{
  "extensions": {
    "webhooks": {
      "listener": { "enabled": false }
    }
  }
}
```

With the daemon running, submit JSON through its owner-only local control socket:

```bash
mixer-automations events emit build-alerts --id build-123 --input '{"status":"failed","build":{"environment":"production"}}'
mixer-automations events emit build-alerts --id build-124 --input-file payload.json
cat payload.json | mixer-automations events emit build-alerts --id build-125 --input-file -
```

Use one of `--input`, `--input-file`, or repeated `--arg key=value` flags. Argument values are strings. Local JSON submission needs no bearer secret because it does not use HTTP. It still requires an enabled endpoint and the bundled extension. Custom handlers decide whether to accept local input. The GitHub handler rejects it because a local observation is not a provider-authenticated delivery.

Use stable IDs when retrying. Generic events deduplicate by endpoint name and delivery ID, not by body hash. Identical payloads with different IDs remain independent events. CLI submission returns JSON and requires the running daemon; it does not launch a second runtime or listener.

## Inspect and reload

```bash
mixer-automations webhooks list
mixer-automations webhooks deliveries
mixer-automations webhooks reload
mixer-automations extensions reload webhooks
```

`list` reports the listener address, active endpoint names, handlers, paths, and HTTP flags. `deliveries` reports the most recent 100 delivery diagnostics without bodies, headers, or secrets. These records are diagnostics, not a durable raw-request inbox.

`webhooks reload` reads endpoint files again. It revokes previous routes and cancels their deliveries before installing replacements. Invalid YAML, duplicate names or paths, unavailable handlers, and invalid handler configuration disable webhook routes without stopping unrelated sources. Concurrent reload requests share one operation. Use `extensions reload webhooks` for changes to listener settings in `config.json`.

Listener bind failures report unhealthy source status, including an address-in-use reason. Disabling the extension with `mixer-automations extensions disable webhooks` removes its routes and listener but does not disable other extensions.

## Listener settings

Settings live under `extensions.webhooks` in `.roboplane/config.json`:

| Field | Default | Meaning |
| --- | --- | --- |
| `listener.enabled` | `true` | Permit HTTP when an enabled HTTP endpoint exists. |
| `listener.host` | `127.0.0.1` | Bind address. |
| `listener.port` | `8787` | Port. `0` requests an ephemeral port. |
| `maxBodyBytes` | `1048576` | Maximum raw request body, at most 10 MiB. |
| `timeoutMs` | `15000` | Request and handler deadline, between 10 and 120000 milliseconds. |
| `maxRequests` | `32` | Maximum connections and concurrent provider calls, at most 1000. |

Headers are limited to 16 KiB. Providers receive a deadline and cancellation signal. A handler that ignores cancellation keeps its capacity slot until it finishes, and cannot admit events through an expired context.

HTTP `202` means the normalized event was admitted durably, was already persisted, or was intentionally ignored. It does not mean execution completed. Concurrent duplicates await the original admission result. Queue pressure and transient handler failures return `503`; malformed input returns `400`, failed authentication returns `401`, and oversized bodies return `413`. Providers can also return validation-challenge responses. Retry transient failures with the original delivery ID.

## GitHub through the shared host

The GitHub extension registers `github.events`. Create `webhooks/github.yaml`:

```yaml
handler: github.events
secretEnv: GITHUB_WEBHOOK_SECRET
```

Configure GitHub to send to `/webhooks/github` with that secret. The handler verifies `X-Hub-Signature-256` against the original bytes, requires `X-GitHub-Delivery`, and accepts only repositories named in active GitHub subscriptions. It preserves normal GitHub event IDs, normalization, enrichment, self-mutation suppression, matching, and live activation.

`extension-webhooks` is the only webhook listener. GitHub has no standalone server. The old `extensions.github.webhook` setting is rejected; listener settings belong under `extensions.webhooks`, while handler settings belong in the endpoint YAML. Add `path: /github/webhook` if the remote subscription must retain that URL.

GitHub polling remains enabled by default. Set `extensions.github.polling: false` before configuring the shared GitHub endpoint; endpoint validation rejects simultaneous collection through both transports to prevent duplicate transitions. This does not disable PR schedules, matching, activation, or Safe Actions.

## Custom providers and MCP

Extensions use `api.inputs.register(name, handler)` and `api.events.registerSource(type, source)`. All provider and custom webhook handlers use the shared host rather than opening their own HTTP servers. They depend on the public SDK, not webhook-extension internals. An endpoint YAML selects the registered handler. The shared host delegates unchanged bytes and headers through the SDK. The handler owns its authentication, payload schema, normalization, and optional challenge response. Core derives the event source identity and permits emission only for types registered by that handler's extension. See `mixer-automations docs sdk` for the contract.

MCP configuration stays in Codex, Claude, OpenCode, or the selected harness. Mixer Automations has no MCP client or MCP configuration section. A scheduled automation can query the harness's configured MCP tools and handle the result within the run. An explicit local bridge can use `events emit`, but that does not provide automatic subscriptions, provider-authenticated provenance, or durable polling cursors.
