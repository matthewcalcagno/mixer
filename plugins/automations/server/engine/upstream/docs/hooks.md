# Hooks

Hooks provide optional cross-cutting behavior without integration logic in core.

```ts
api.hooks.on("agent:before", async (ctx) => {
  ctx.instructions.push("Read docs/engineering-policy.md.");
});
```

The normal prompt lifecycle uses `event:received`, `workflow:matched`, `run:created`, `run:acquire`, `run:before`, `run:after`, `run:finalized`, `agent:before`, and `agent:after`.

`run:created` is an admission notification, not an execution barrier. Put required execution initialization in `run:acquire` or `run:before`. `run:acquire` runs before live activation and matching, with no workspace. It supplies `signal` and `deadline` for cancellation-aware resource ownership. `run:before` retains activated event context and runs only after eligibility passes. Sources may also supply an opaque `resourceKey(event)` to reserve the resource in the durable queue without occupying a worker while another run owns it.

`execution:before` runs after attestation and before either agent or scripted execution. Scripts do not emit `agent:before` or `agent:after`. GitHub publication protection uses execution-neutral preparation for scripts while retaining existing agent hooks.

`run:after` executes before final workspace inspection and cleanup, including when preparation is skipped or deferred. `run:finalized` is durably delivered after terminal status and is not emitted between retry attempts or temporary eligibility waits. Delivery can retry after a failure or crash, so handlers must be idempotent. Pending finalized delivery retains resource ownership but does not occupy an executor slot. Finalized-hook failures cannot change the completed run status. A shutdown before executor control preserves the preparation phase for safe resumption rather than reporting a completed terminal attempt.

Handlers may mutate `instructions` and `metadata`. Set `ctx.cancelled = true` and optionally `ctx.reason` where cancellation is meaningful. Handlers run sequentially in registration order. Keep hooks fast and deterministic.

The evaluations extension captures bounded evidence from `run:finalized` and queues model work later. It does not run a model inside the completion hook or change the source run's terminal result. See `mixer-automations docs evaluations`.
