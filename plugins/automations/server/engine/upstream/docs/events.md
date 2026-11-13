# Events

Workflow authors should use `mixer-automations docs workflow-authoring` for the complete first-party trigger reference. This page documents the extension event-source contract.

Extensions register namespaced event types and emit normalized events. Emission returns an acknowledgement identifying accepted, duplicate, or rejected delivery:

```ts
api.events.registerSource("vendor.item", {
  async start(ctx) {
    await ctx.emit({
      id: "vendor-item-42-v3",
      type: "vendor.item",
      source: "vendor",
      timestamp: new Date().toISOString(),
      repository: "owner/repo",
      actor: { id: "7", name: "Ada" },
      data: { action: "opened" },
    });
  },
  match(event, workflowConfig) {
    return true;
  },
});
```

Event IDs must be stable for the same upstream event/version. Core deduplicates exact IDs. `repository` and `actor` are optional. `data` is extension-owned.

A first-class replay creates a new synthetic event ID and records `provenance` with the source run, root run, and source event IDs. This does not weaken normal upstream deduplication. Replay targets exactly one workflow and is audited separately from ordinary event routing.

A reroute clones a persisted event under a fresh ID while preserving its original type, source, actor, repository, and data. It records the source event ID in `provenance` and evaluates current workflow subscriptions. Use it when an event originally matched no workflow but now satisfies corrected matcher configuration; unlike a manual run, it preserves source-specific activation and security context. Each source event can be rerouted only once.

`ctx.subscriptions` contains `{ type, config, workflowId, repository? }` for valid workflows. A source's optional `match` interprets its workflow configuration. Core only checks type and repository equality.

An event source can expose `configSchema`. Core uses it during `mixer-automations automations validate`, while the extension still owns the schema and semantics. See `mixer-automations docs github` for composable GitHub-specific matching.

Sources may also expose `activate(event)`. This is a read-only refresh immediately before workspace creation. It returns an immutable activation snapshot and, when applicable, an exact `WorkspaceSource` revision. GitHub uses this boundary to re-fetch the PR head and triggering comment before a run can write.

Core reserves any source-defined resource before activation, then runs the matcher again against the persisted workflow snapshot. A false or ignored match completes as a no-op before workspace creation. A temporarily deferred match returns the same run to the queue without spending an executor attempt. Sources can provide a specific activation skip reason for obsolete work.

Source startup is awaited and its health is persisted. Failed starts retry with bounded backoff and appear as degraded or unavailable in `mixer-automations status`. Long-lived sources must supervise their own internal loops and call `reportHealth` when delivery becomes degraded.
