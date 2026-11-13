# Extension authoring

Webhook providers use the bundled `webhooks` host. Register a provider-owned input handler through `api.inputs.register`, then select it in a `webhooks/*.yaml` endpoint definition. Do not open a separate HTTP listener or import webhook-extension internals. The host owns transport and admission acknowledgements; your handler owns authentication, decoding, and event semantics. Read `mixer-automations docs webhooks` and `mixer-automations docs sdk` for the contract.

Scripted execution is extension-owned. Register a runner with `api.workflows.registerRunner` and use supervised processes and fenced step context, not core internals. `ExtensionCommand.query` exposes read-only queries to steps while retaining credentials in the daemon. See `mixer-automations docs sdk`, `mixer-automations docs scripted-workflows`, and `mixer-automations docs workflow-handoffs`.

Mixer Automations extensions are user-owned TypeScript modules loaded from `$MIXER_AUTOMATIONS_HOME/extensions`. They can add event triggers, workflow frontmatter, Safe Actions, agent providers, workspaces, execution providers, lifecycle hooks, and CLI commands without importing core.

This guide is installed with the CLI. Use `mixer-automations docs --path` to locate the Markdown files, `mixer-automations docs --search <text>` to search them, and `mixer-automations docs extension-authoring` to print this page.

## Create

```bash
mixer-automations extensions create inbox --template event-source
mixer-automations extensions validate inbox
mixer-automations extensions reload inbox
```

New extensions are enabled by default. The scaffold is written to `$MIXER_AUTOMATIONS_HOME/extensions/inbox/index.ts`. Edit its query, stable event ID, event data, matcher, and trigger schema. Use `--template workflow-field` for a working extension-owned frontmatter example.

Names use lowercase letters, numbers, and hyphens. A single `.ts` file directly below the extensions directory also works. Directory extensions may contain helper modules and a `package.json`; install runtime dependencies in that directory.

```ts
import { defineExtension } from "@mixer/automations-sdk";

export default defineExtension({
  name: "inbox",
  version: "0.1.0",
  setup(api) {
    api.logger.info({}, "inbox registered");
  },
  async start(ctx) {
    // Start extension-wide resources here and observe ctx.signal.
  },
  async stop() {
    // Close resources. This is called during reload and disable.
  },
});
```

`setup` registers capabilities and validates configuration. Start timers, servers, polling, and connections in source `start` or extension `start`, then close them in `stop`.

## Public API

- `api.events.registerSource(type, source)` registers an event type, trigger schema, matcher, activation refresh, and source lifecycle.
- `api.workflows.registerField(name, definition)` registers a namespaced top-level frontmatter field and Zod schema.
- `api.actions.register`, `api.agents.register`, `api.workspaces.register`, and `api.executions.register` add the corresponding providers.
- `api.hooks.on(name, handler)` observes or cancels lifecycle operations.
- `api.commands.register(command)` registers a top-level CLI command.
- `api.config.get()` returns this extension's settings, excluding the reserved `enabled` property.
- `api.state.namespace(name?)` returns persistent extension-scoped JSON state.
- `api.process.run(options)`, `api.logger`, and `api.paths` provide trusted processes, logging, and standard directories.

Import types, `defineExtension`, and the re-exported `z` schema builder from `@mixer/automations-sdk`. Installed TypeScript declarations are authoritative for the installed version. Directory extensions can declare other runtime packages in their own `package.json`.

## Event sources

Sources receive current workflow subscriptions and emit normalized events. IDs must be stable for the same upstream item and version.

```ts
api.events.registerSource("inbox.message", {
  configSchema: z.object({ priority: z.string().optional() }).strict(),
  async start(ctx) {
    await ctx.emit({
      id: "message:42:revision:3",
      type: "inbox.message",
      source: "inbox",
      timestamp: new Date().toISOString(),
      repository: "owner/repo",
      data: { id: 42, priority: "high" },
    });
  },
  updateSubscriptions(type, subscriptions) {
    // Reconfigure long-lived work after workflow files change.
  },
  match(event, config) {
    const wanted = (config as { priority?: string }).priority;
    return !wanted || (event.data as { priority?: string }).priority === wanted;
  },
  stop() {
    // Clear timers, listeners, servers, and connections.
  },
});
```

Treat `accepted` and `duplicate` acknowledgements as delivered. Do not advance an upstream cursor after `rejected`. Store cursors with `api.state` and report degraded health when a long-running source cannot deliver.

The workflow trigger is extension-owned:

```yaml
on:
  inbox.message:
    priority: high
```

## Extension-owned frontmatter

Top-level fields must be namespaced:

```ts
const field = "team-policy.context";
api.workflows.registerField(field, {
  description: "Team instructions added to the harness prompt.",
  schema: z.object({ instructions: z.string().min(1) }).strict(),
});
api.hooks.on("agent:before", (ctx) => {
  const value = ctx.workflow?.extensions?.[field] as { instructions?: string } | undefined;
  if (value?.instructions) ctx.instructions.push(value.instructions);
});
```

```yaml
team-policy.context:
  instructions: Follow the team's release checklist.
```

Validated values are stored in `workflow.extensions` and durable workflow snapshots. An unknown field, or one owned by a disabled extension, makes the workflow invalid.

## Configuration and enabled state

Settings and enabled state share `$MIXER_AUTOMATIONS_HOME/.roboplane/config.json`:

```json
{
  "extensions": {
    "inbox": {
      "enabled": true,
      "baseUrl": "https://example.test",
      "token": "${INBOX_TOKEN}"
    }
  }
}
```

`enabled` is reserved and removed before `api.config.get()` returns the remaining object. Missing `enabled` means enabled. Validate the returned settings with Zod in `setup`.

`mixer-automations extensions disable <name>` stops its resources, unregisters capabilities, preserves code, settings, and state, and revalidates workflows. `enable` reverses it. A running daemon applies the change immediately; otherwise it applies on the next start.

## Validate, load, and observe

`mixer-automations extensions validate <name>` imports and registers the extension, detects registration/schema errors, and reports capabilities without starting event sources. Then validate workflows:

```bash
mixer-automations extensions validate inbox
mixer-automations automations validate
mixer-automations automations files
```

Apply code or configuration changes to one running extension:

```bash
mixer-automations extensions reload inbox
```

Reload stops that extension, removes its registrations, imports the current code, registers it, revalidates workflows, and starts its sources. Active runs retain persisted workflow snapshots; wait for active runs before changing a provider they use.

Observe it with:

```bash
mixer-automations extensions
mixer-automations extensions inspect inbox
mixer-automations status
mixer-automations automations list
mixer-automations logs
```

Inspection shows path, enabled/load status, configuration presence, errors, and capabilities. Status shows event-source health. Logs show routing and source failures.

## Authoring checklist

1. Read this guide and `mixer-automations docs events`.
2. Create or edit the intended extension under `$MIXER_AUTOMATIONS_HOME/extensions`.
3. Give every upstream event version a stable ID.
4. Validate settings and trigger configuration with Zod.
5. Persist cursors in `api.state`; keep timers and connections in memory.
6. Handle cancellation and close every resource in `stop`.
7. Run `extensions validate`, `automations validate`, and `automations files`.
8. Reload and inspect capabilities and source health.
