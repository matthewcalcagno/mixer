# Extensions

The bundled `steps` extension registers the scripted workflow runner. YAML discovery is core-owned; step schema, conditions, retries, and shell semantics belong to this extension. Disabling it makes scripted execution unavailable. Enable it with `mixer-automations extensions enable steps`. It requires no model configuration. Read `mixer-automations docs scripted-workflows`.

The bundled `webhooks` extension hosts optional HTTP endpoints and local CLI inputs. It opens no port without enabled HTTP endpoints. Providers register input handlers through the SDK; GitHub registers `github.events`. Read `mixer-automations docs webhooks`.

The bundled `evaluations` extension discovers `evaluations/<name>/evaluation.yaml`, captures terminal-run evidence, and evaluates batches through the supervised queue. It writes reports without applying automation changes. Read `mixer-automations docs evaluations` for criteria, run-count triggers, retention, and the host trust boundary.

Place local extensions at `$MIXER_AUTOMATIONS_HOME/extensions/name.ts` or `$MIXER_AUTOMATIONS_HOME/extensions/name/index.ts`. Run `mixer-automations extensions reload <name>` after changing extension code.

For the complete create, validate, enable, reload, and observe workflow, run `mixer-automations docs extension-authoring`. `mixer-automations extensions create <name>` scaffolds an enabled extension.

## Minimal Extension

```ts
import { defineExtension } from "@mixer/automations-sdk";

export default defineExtension({
  name: "example",
  version: "0.1.0",
  setup(api) {
    api.logger.info({}, "example registered");
  },
  async start(ctx) {
    // Start optional long-running work. Observe ctx.signal.
  },
  async stop() {
    // Stop optional resources.
  },
});
```

`setup` registers capabilities. `start` and `stop` are optional. Do not start polling in `setup`.

## API

- `api.events.registerSource(type, source)` registers event production and matching.
- `api.inputs.register(name, handler)` registers provider-owned input decoding and admission.
- `api.workflows.registerField(name, definition)` registers a namespaced top-level workflow frontmatter field.
- `api.workflows.registerDiscovery(name, provider)` discovers extension-owned definitions as normal supervised workflows.
- `api.actions.register(name, definition)` registers an extension-owned Safe Action with input and policy schemas plus preparation and execution handlers.
- `api.agents.register(name, provider)` registers an agent provider.
- `api.workspaces.register(name, provider)` registers workspace creation and cleanup.
- `api.executions.register(name, provider)` registers a run-scoped agent process boundary.
- `api.hooks.on(name, handler)` observes or cancels lifecycle operations.
- `api.commands.register(command)` adds a top-level command.
- `api.config.get()` returns this extension's `config.json` section.
- `api.config.historyRetentionMs()` returns the effective global history retention without exposing credentials.
- `api.state.namespace(name?)` returns synchronous namespaced JSON state.
- `api.process.run(options)` runs a trusted extension subprocess. Agent providers must use `ctx.execution.run` instead.
- `api.logger` is a secret-redacting scoped logger.
- `api.paths` exposes standard Mixer Automations paths. `home` is the outer working directory, `workflows` resolves to its `automations/` directory, and `extensions` resolves to its `extensions/` directory. `config`, `cases`, `state`, `logs`, and `workspaces` resolve inside its nested `.roboplane/`. Use these paths rather than constructing private locations from `home`.

## Configuration And State

Validate `api.config.get()` in `setup` with Zod. Never print configuration values. State values must be JSON-compatible:

```ts
const config = z.object({ interval: z.number().positive() }).parse(api.config.get());
const state = api.state.namespace();
state.set("cursor", "abc");
const cursor = state.get<string>("cursor");
const expiring = state.entries("temporary:");
```

`entries(prefix?)` is scoped to the extension namespace. Use a narrow literal prefix when reconciling or garbage-collecting extension-owned records.

## Testing

Import the extension, call `setup` with a small API fake, and assert registrations. Integration tests should use temporary `MIXER_AUTOMATIONS_HOME` directories and fake executors. Run `mixer-automations automations validate` against an example workflow.

## Complete Event Example

```ts
import { randomUUID } from "node:crypto";
import { defineExtension } from "@mixer/automations-sdk";

export default defineExtension({
  name: "inbox",
  setup(api) {
    api.events.registerSource("inbox.message", {
      start(ctx) {
        const timer = setInterval(() => void ctx.emit({
          id: randomUUID(),
          type: "inbox.message",
          source: "inbox",
          timestamp: new Date().toISOString(),
          data: { priority: "normal" },
        }), 60_000);
        ctx.signal.addEventListener("abort", () => clearInterval(timer), { once: true });
      },
      match(event, config) {
        const wanted = (config as { priority?: string }).priority;
        return !wanted || (event.data as { priority?: string }).priority === wanted;
      },
    });
  },
});
```

See `mixer-automations docs sdk`, `events`, `agents`, `execution`, and `workspaces` for exact interfaces.

Agent harness integrations are ordinary extensions. Adding a future CLI does not require a core release: register its provider with `api.agents.register("name", provider)`, then select it with `agent: name` in a workflow.

The bundled Codex, Claude, OpenCode, Pi, and Copilot providers use the same public interface and import no core internals. Each harness launches its CLI in unattended mode with `ctx.prompt` and `ctx.workspace.path`.
