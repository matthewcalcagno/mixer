# Workflow handoffs

A scripted step can start another workflow through the CLI. The child is an independent run. The parent never parses or waits for an agent result.

```yaml
name: Prepare investigation
repository: owner/repo
on:
  github.issue:
    events: [opened]
steps:
  - id: prepare
    run: printf '%s\n' '{"note":"Inspect the activated issue"}' > context.json
  - id: investigate
    run: |
      mixer-automations automations run shared/investigate.md \
        --repository "$MIXER_AUTOMATIONS_REPOSITORY" \
        --input-file context.json \
        --inherit-event \
        --handoff-key investigate
```

The child must exist below `$MIXER_AUTOMATIONS_HOME/automations`. Use `on: {}` for a manual/handoff-only child, so the original event does not launch it independently before preparation finishes:

```md
---
name: Investigate the prepared issue
repository: owner/repo
agent: codex
on: {}
---

Investigate the activated issue using the handoff input as context.
```

A child with automatic triggers may also be called, but inherited execution requires a compatible event type and filters. If both workflows match the same original event, the child can run automatically as well as through the handoff. Prefer manual-only children for composed workflows. A manual-only child still receives authoritative live activation and its own repository and action checks; it never trusts caller JSON as activation.

## Submission contract

`mixer-automations automations run` submits through the daemon control socket and returns immediately by default. It never starts a nested runtime or worker. Success means the run and workflow snapshot were durably admitted, not that the agent succeeded.

```bash
mixer-automations start
mixer-automations automations run shared/prepare.yaml --json
```

JSON includes `ok`, `runId`, and `status: "accepted"`. Without `--json`, the accepted ID is printed. Missing daemon, unavailable workflow, repository mismatch, queue-capacity rejection, and invalid parent context cause nonzero exits.

Inside a scripted step, `--wait` is rejected. Submission is detached by default, including with concurrency one. Waiting while holding a parent slot or GitHub case lock would prevent the child from progressing.

`--input` accepts JSON text. `--input-file` reads JSON immediately, is limited to 48 KiB, and is mutually exclusive with `--input`. Control requests are bounded too. Input is persisted; the child never reads a path in the parent's disposable workspace.

## Target and permissions

Each invocation creates at most one repository-bound child. A multi-repository child needs a selected repository. Parent context can select the parent's repository when allowed by the child; examples should pass `--repository` explicitly.

Without `--inherit-event`, the child receives a manual event containing input. A PR number in JSON does not grant event-derived publication or merge authority.

With `--inherit-event`, the daemon copies the persisted event and provenance. Input is separate `event.input`, also included in the agent prompt. The child reactivates live state and evaluates its own filters. It derives its own permissions and Safe Actions. Parent policy, branch capabilities, and workspaces are never transferred. Switching repositories during event inheritance is rejected.

Arbitrary terminal commands cannot inherit an event by claiming a run ID. Context is scoped to the active step and attempt, validated against the lease, cancellation state, and deadline. Context expires when the step or run ends.

## Idempotency

Submissions are deduplicated by parent run, step ID, and handoff key. The default key is the child workflow ID. Use an explicit key when one step intentionally submits several children to the same workflow, such as one per repository.

Repeating a request returns the existing ID, including after response loss. Reusing a key with different input, repository, workflow, or inheritance mode fails. This protects admission, not arbitrary preceding shell commands.

Ancestor-workflow recursion is rejected. Chains are bounded to 16 ancestors. Children obey queue limits. Parent replay has a new run ID and can intentionally create another child.

## Lifecycle

- Parent completion does not depend on child completion.
- Accepted children survive later parent failure or cancellation.
- Parent cancellation does not cascade. Cancel child IDs explicitly.
- Children get separate fresh workspaces and normal concurrency treatment.
- GitHub case locks serialize conflicting work on the same issue or PR.

```bash
mixer-automations automations inspect <parent-run-id>
mixer-automations automations inspect <child-run-id> --json
mixer-automations automations logs <parent-run-id> --step investigate
mixer-automations automations cancel <child-run-id>
```

Inspection links immediate parents and accepted children. There is no agent-return schema, paused parent, or child-result propagation.
