# Execution

Normal workflows use the built-in `host` provider. Markdown agent reporting is selected globally by `runtime.mode`. YAML executes sequential steps through the steps extension without parsing agent reports. Read `mixer-automations docs scripted-workflows` for shell, timeout, retry, failure, and interruption semantics.

`managed` is the default. It asks the harness to end with a `MIXER_AUTOMATIONS_RESULT` version 1 envelope using `acted`, `no-op`, `blocked`, or `failed`. Mixer Automations persists a valid report together with authoritative run state. Missing or malformed reporting does not fail an otherwise successful run: the outcome is recorded as `unknown` with `report_missing` or `report_invalid`. Authoritative workspace changes can upgrade that outcome to `acted`. A declared Safe Action must be requested structurally in this envelope; prose never authorizes an action.

Safe Action proposals execute after the harness process exits. The action name and input schema come from the workflow, while the extension revalidates policy and live state. Rejected actions make the run outcome blocked; failed external execution makes the run fail without automatically rerunning the harness.

For YAML workflows, request a declared action with `mixer-automations actions request` from an active step. Shell output and `MIXER_AUTOMATIONS_RESULT` never authorize a scripted action. The daemon records the proposal and applies it after successful workflow execution and session cleanup. The requesting attempt must succeed; a tolerated failure does not authorize its request. Explicit retries deduplicate requests but must confirm them again in the successful attempt. Failed, cancelled, expired, or interrupted execution discards proposals that have no prepared plan.

A recorded proposal is not a completed operation. `mixer-automations automations inspect <run> --json` exposes `actions`, `plan`, and `effects`; an executed Safe Action upgrades a successful scripted outcome to `acted`. Dry-run stages the action without performing its effect. Prepared effects use the existing restart reconciler instead of restarting the script. See `mixer-automations docs scripted-workflows` for examples and the command contract.

`unsafe-direct` accepts legacy harness output and derives a best-effort outcome. It is intentionally equivalent to launching the harness from the user's terminal:

- The process runs inside a disposable repository checkout.
- It inherits the user's home directory and ordinary execution variables, but not integration-secret variables automatically.
- It can use normal `git`, `gh`, provider authentication, and network access.
- Stdin is closed.
- Total and no-output timeouts are enforced.
- Output and exit status are logged.

Every run has a persisted absolute deadline. `mixer-automations automations cancel <run>` records cancellation before signalling only that run. Cancellation, deadline expiry, daemon shutdown, and lease loss propagate through workspace and process contexts.

The process is not sandboxed. An autonomous CLI can perform anything the same user could perform manually. Docker is not required and is no longer workflow configuration. Users who require isolation should run Mixer Automations itself on a dedicated host, VM, container, or other external sandbox.
