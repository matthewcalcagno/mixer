# SDK reference

Extensions import from `@mixer/automations-sdk` and register capabilities during `setup`.

```ts
interface MixerAutomationsAPI {
  events: EventRegistry;
  inputs: InputRegistry;
  workflows: WorkflowRegistry;
  actions: SafeActionRegistry;
  agents: AgentRegistry;
  workspaces: WorkspaceRegistry;
  executions: ExecutionRegistry;
  hooks: HookRegistry;
  commands: CommandRegistry;
  config: { get(): unknown; historyRetentionMs(): number };
  state: { namespace(name?: string): ExtensionState };
  process: ProcessAPI;
  logger: Logger;
  paths: PathsAPI;
}
```

The normal harness context is:

```ts
interface AgentContext {
  run: Run;
  event: Event;
  repository?: string;
  workspace?: Workspace;
  workspaceAccess?: "read-only" | "read-write";
  instructions: string[];
  prompt: string;
  model?: string;
  thinking?: string;
  actions: readonly SafeActionTool[];
  timeout?: number;
  noOutputTimeout?: number;
  execution: ProcessAPI;
  signal: AbortSignal;
  logger: Logger;
}
```

Agent providers call `ctx.execution.run`, not trusted `api.process`, so the runtime can supervise cwd, cancellation, stdin, timeouts, and logs.

Subprocess adapters receive the action catalog in the prompt. A managed harness requests an authorized action with `actions: [{ "name": "extension.action", "input": {...} }]` in its final `MIXER_AUTOMATIONS_RESULT`. Core records the proposal and executes it only after the harness exits. Extensions register schemas, policies, preparation, execution, and idempotent reconciliation through `api.actions.register`.

Scripted workflows request the same registered actions through `mixer-automations actions request`, using the active step's scoped token. Extension handlers do not need a separate scripted implementation. `SafeActionPrepareContext.workflow` supplies the immutable workflow snapshot so preparation can enforce execution-specific requirements. Execution and reconciliation receive the cancellation signal and deadline when available. Observe them before starting a new external mutation. `SafeActionContext.operation` identifies the action, plan, effect, idempotency key, attempt, and reconciliation state. Reconciliation may inspect an uncertain effect after a deadline, but must not start a new mutation then.

```ts
interface ProcessRunOptions {
  command: string;
  args?: readonly string[];
  cwd?: string;
  env?: Record<string, string | undefined>;
  signal?: AbortSignal;
  timeout?: number;
  noOutputTimeout?: number;
  onStdout?(chunk: string): void;
  onStderr?(chunk: string): void;
}
```

The installed TypeScript declarations remain authoritative for event-source, workspace, hook, command, state, logging, and path interfaces.

`PathsAPI.home` identifies the outer working directory, `PathsAPI.workflows` is its `automations/` directory, and `PathsAPI.extensions` is its `extensions/` directory. `config` is the full path to `.roboplane/config.json`; `cases`, `state`, `logs`, and `workspaces` are directories inside the nested `.roboplane/`. Extensions must use these resolved paths instead of appending private directory names to `home`.

Namespaced extension state supports `get`, `set`, `delete`, and literal-prefix `entries(prefix?)`. Enumeration never crosses the calling extension's namespace and is intended for bounded reconciliation and retention work. `api.config.historyRetentionMs()` exposes the effective global history lifetime without exposing other extensions' configuration or credentials.

Event sources report readiness with `EventSourceContext.reportHealth`. Set `result: "success"` or `result: "failure"` to describe the latest operation independently of readiness. For example, a successful poll with an unresolved historical warning reports `status: "degraded", result: "success"`. Core retains the warning but resets consecutive failures and updates the last-success timestamp. If `result` is omitted, core uses the existing status-based accounting: `ready` succeeds and other statuses count as failures.

## Extension-owned workflow discovery

`api.workflows.registerDiscovery(name, { watchPaths, discover })` registers an extension-owned definition format. `discover(knownWorkflows)` receives the definitions already discovered and returns `{workflows, errors}`. The daemon watches the additional paths, validates every returned workflow against registered capabilities, rejects duplicate identities, and uses the ordinary supervised queue and immutable snapshots. Disabling or reloading the extension retires its discovery provider. Core remains unaware of the custom file format.

## Source-bound input handlers

`api.inputs.register(name, handler)` registers an `InputHandler` with `configSchema`, `eventTypes`, and `receive(input, config, context)`. `api.inputs.validate(name, config)` checks handler availability and its configuration. `api.inputs.submit(name, input, config, operation?)` delegates input to the installed handler.

`context` extends `OperationContext` with `emit(candidate): Promise<EventEmitResult>`. Candidates contain `id`, `type`, an ISO timestamp, JSON `data`, and optional `repository` and `actor`. They cannot contain `source`, provenance, handoff input, or activation facts. Core derives `source` from registration ownership and rejects types not declared by the handler or registered by its extension. Reload retires handler contexts and source emitters. Observe the context's cancellation signal before provider calls.

Handlers return one of:

```ts
type InputResult =
  | { kind: "event"; result: EventEmitResult }
  | { kind: "ignored"; reason: string }
  | { kind: "rejected"; status: number; reason: string }
  | { kind: "response"; status: number; body: string; contentType?: string };
```

For shared webhook hosting, validate input using the SDK's `webhookRequestSchema`. It contains `endpoint`, raw `body: Uint8Array`, lowercase string `headers`, and `local`. Verify raw bytes before parsing. `local` is true only for the daemon's CLI bridge; providers must decide whether that is acceptable. Generic observations must not assert authenticated vendor authority. `response` supports provider verification challenges. Use sanitized reasons and response bodies; the host must not expose credentials.

IDs deduplicate globally. Providers must namespace stable upstream delivery keys. Multiple automations can match one event. Batch emission has no atomic multi-event guarantee; return one normalized event per delivery unless the provider defines its own retry behavior. The shared host is a bundled extension, not an HTTP dependency of the kernel. Read `mixer-automations docs webhooks`.

## Deferred event matching

`EventSource.match` returns `true` to admit a run, `false` to ignore an event, `{kind: "ignore", reason}` to record a specific skip reason, or a deferred decision:

```ts
return {
  kind: "defer",
  resourceKey: "project:item:42",
  reason: "not_ready",
  retryAfter: 30_000,
  expiresAfter: 604_800_000,
};
```

Core validates this result, atomically persists pending routes alongside event admission, and periodically calls the source matcher again. Retry and expiry durations are milliseconds. Retry must be between one second and one day, and expiry between one second and 30 days. Expiry is bounded by the original event time and never extended by reevaluation. Routing remains unique per workflow and original event, even if another workflow already ran for that event.

Sources decide which failures are temporary and fetch current resource state before reevaluation. They may call `EventSourceContext.reconcile(resourceKey)` after an external resource change. This wakes pending routes for event types registered with the same source object. Core treats the resource key as opaque and does not infer integration semantics.

`OperationContext.batchId` identifies one reconciliation batch. A source may reuse read-only resource fetches within that batch, but must not reuse those snapshots for later batches or activation. `OperationContext.workflow` supplies the immutable candidate definition for extension-owned execution policies. Observe the operation cancellation signal. A batch evaluates at most 100 due routes and has a 30-second cancellation budget. Pending routes survive source failures and restarts, but expire or become invalid when their workflow configuration changes.

A deferred match immediately before execution returns the existing run to the queue until retry or an explicit resource wakeup. It does not spend an executor attempt, allocate a workspace, or restart an executor that already received control. Expiry remains bounded by the original event timestamp. An authoritative activation can return `decision: {kind: "skip", reason}` to finish obsolete work as a no-op without invoking an executor.

`EventSource.resourceKey(event)` supplies an optional, synchronous opaque key for exclusive execution. Namespace keys by integration. Runs sharing a key remain queued until the active owner's lease and terminal lifecycle delivery finish. Core does not interpret issue numbers, PRs, or other integration semantics. Source-derived snapshots require their registered provider at execution; manual events are the explicit exception.

## Scripted executor contract

`api.workflows.registerRunner(name, { schema, run })` registers a non-agent executor. The steps extension validates `env`, `defaults`, and `steps`. `Workflow.task` is omitted for Markdown snapshots and contains `{kind: "steps", runner, configuration}` for scripts. The existing `agent` field is empty for scripts, never a default agent selection.

`WorkflowRunnerContext` contains run, activated event, workflow, configuration, workspace, supervised execution, signal, deadline, no-output timeout, logger, and optional CLI command. `recordStep` persists `StepRecord` using the fenced lease. `stepEnvironment` supplies scoped context for child submission, read-only queries, and Safe Action requests from the active step. Tokens expire when the step ends. `WorkflowRunnerResult` does not contain action proposals; requests go through the CLI and daemon. Extensions must not import core or its database.

`ProcessRunOptions.captureOutput` defaults to true. Set it to false when only stream callbacks are needed. `ExtensionCommand.query(args, context)` optionally exposes a read-only daemon query returning JSON. Context contains the authoritative run, activated event, workflow, cancellation signal, and run deadline. Observe the signal in network calls; it aborts when the parent step ends. Only registered query handlers are callable from scoped scripted CLI invocations. Installed extensions remain trusted; this is not a sandbox.
