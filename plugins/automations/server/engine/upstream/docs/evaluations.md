# Report-only evaluations

The bundled `evaluations` extension reviews batches of historical automation runs against criteria you define. It writes a report and optional improvement suggestion. It does not apply patches, modify automations, publish comments, or authorize Safe Actions.

## Define an evaluation

Create `$MIXER_AUTOMATIONS_HOME/evaluations/<name>/evaluation.yaml`. Names use letters, digits, underscores, and hyphens. `evaluation.yml` is also accepted, but keep only one manifest per folder.

`mixer-automations init` creates the empty `evaluations/` directory. Loading the enabled extension also creates it for existing installations. Both paths preserve existing definitions and reports.

```text
~/.roboplane/
  evaluations/
    issue-triage-comments/
      evaluation.yaml
      reports/
        2026-10-08T14-00-00-000Z_eval_a81c0123456789abcdef012345.md
```

```yaml
workflow: shared/issues/issue-triage.md
agent: opencode
model: github-copilot/gpt-6.1-sol
thinking: high
afterRuns: 10

evidence:
  retention: 14d

criteria:
  - description: The comment explains the next action.
    passWhen: |
      The reader understands what was established and what happens next.
      If work cannot continue, the comment identifies the blocker.

  - description: The comment sounds like a maintainer response.
    passWhen: |
      It avoids canned acknowledgements, repetitive status templates,
      and explanations of internal automation mechanics.

  - description: Claims are supported by evidence.
    passWhen: |
      Verified facts are distinguished from hypotheses.
      Tests and fixes are described as successful only when verified.
```

`workflow` is the exact relative automation filename, including its extension. Runs from every configured repository contribute evidence, but different automation versions are evaluated separately. The target must be an existing, valid automation.

Each criterion has only `description` and `passWhen`. No identifier, assessment type, required flag, numeric score, or expression language is needed. There must be 1–20 criteria with unique descriptions. Unknown keys are rejected.

`agent` defaults to `codex`. `model` and `thinking` use the selected harness's normal settings and authentication. OpenCode thinking requires a model without a `#variant`. `timeout` defaults to `10m` and cannot exceed `1h`. Set `disabled: true` to stop new evaluation admission.

## Trigger and execution

`afterRuns` defaults to 10 and accepts 1–50. It counts new terminal runs with captured, unexpired evidence. Completed, failed, cancelled, and interrupted runs can contribute. Evaluation runs never contribute to another evaluation. Duplicate lifecycle delivery does not increase the counter.

The extension checks eligibility at daemon startup and every hour. Time does not trigger a model call: one automation version must have enough new evidence. `afterRuns: 1` produces single-run batches at the next eligibility check. It is not an immediate per-run trigger.

Each batch freezes exactly `afterRuns` source IDs, the automation version, and the evaluation-definition version. New runs remain pending for another batch. Only one batch per evaluation is open at a time. The extension admits a normal scratch-workspace agent run through the daemon queue, respecting concurrency, deadlines, cancellation, and run history. Do not run the internal `evaluations/<name>/evaluation.yaml` workflow manually; it requires a valid admitted batch.

Changing criteria or lowering `afterRuns` can reuse unconsumed evidence for the same target. The new definition is pinned when the batch is created; existing reports remain unchanged.

Reports are written only after evaluation finishes. A malformed response, unsupported evidence claim, failed harness, or missing criterion produces an error report rather than an improvement. Missing evidence or an exceeded prompt budget produces an inconclusive result. Failed terminal batches are not automatically repeated; harness attempts still follow the global runtime retry policy. A batch is consumed only after its report is stored, including when the report describes an evaluation error.

## Evidence and retention

Completion captures a bounded snapshot of the original prompt, event context, terminal outcome, agent output, and the end of the source log. Evidence records limitations when content is truncated or logs are absent. Common credential fields and token patterns are redacted, but this is not a complete sensitive-data detector.

Agent output is not necessarily the published comment. If the actual output needed by a criterion is absent, the evaluator must report `insufficient-evidence`. The extension does not fetch remote comments or replay production tasks. A report cannot prove correctness or natural writing from an agent's claim alone.

Pending evidence and reports default to global `history.retention`. Setting `evidence.retention: 14d` explicitly authorizes longer retention for that evaluation, even if normal run history and logs expire after `1d`. Snapshots live in private extension state, not in the public evaluation folder. Reports retain their cited excerpts under the same evaluation policy and are written with owner-only file permissions.

Expired evidence no longer counts. Evidence is removed after report creation, leaving a deduplication receipt until expiry. Reports and private batch records expire too. Cleanup runs during eligibility checks while the extension is enabled and the daemon is running. Shortening global history retention also shortens inherited evidence and report lifetimes. Explicit evaluation retention remains independent. Modified reports are preserved during cleanup rather than overwritten or deleted.

Source evidence expires relative to source completion. Report retention starts when its batch is created. References to source logs may stop resolving after normal history cleanup; the report preserves the exact excerpts it cites.

## Reports and stopping conditions

A criterion receives `pass`, `fail`, `not-applicable`, or `insufficient-evidence`. Pass and fail require an exact captured excerpt and a source run ID from the batch. The extension validates that those references exist. This checks attribution, not the truth of the model's interpretation.

The report includes the harness and model, versions, source IDs, criterion definitions and findings, evidence excerpts, limitations, and at most one suggestion. Suggestions require a supported failed criterion. A clean batch reports **No change justified**. A failed criterion does not require a prompt change; it may describe an environment problem or an isolated task failure.

The evaluation is done when its report is safely stored. It does not continue rewriting, evaluate its own suggestions, or change its own rubric. Applying any suggestion remains a separate manual decision.

Only named manifests are discovered. Reports and other YAML or Markdown assets are never evaluation definitions. Reports are installed atomically without overwriting an existing file. Symlinked evaluation and report directories are rejected.

## Commands and settings

```bash
mixer-automations evaluations list
mixer-automations evaluations status --json
mixer-automations evaluations validate
mixer-automations automations validate
mixer-automations extensions disable evaluations
mixer-automations extensions enable evaluations
```

`evaluations validate` checks manifest syntax. `automations validate` also checks target availability and registered harnesses. Status shows the largest pending automation-version group, not a total across incompatible versions, plus per-version counts in JSON.

The extension owns these optional `extensions.evaluations` settings:

```json
{
  "extensions": {
    "evaluations": {
      "pollInterval": "1h",
      "maxRunBytes": 8192,
      "maxPromptBytes": 262144,
      "maxPendingRuns": 100
    }
  }
}
```

`pollInterval` is a positive duration no larger than one day. It controls checks, not the run threshold. `maxRunBytes` bounds captured event context, output, and logs; the original prompt has a separate 32 KiB cap. `maxPromptBytes` bounds the combined evaluator instructions and evidence before invoking a model. `maxPendingRuns` bounds pending evidence per evaluation; additional runs are not counted when that limit is reached.

For a low-volume workflow, configure a retention period long enough to collect `afterRuns`, or reduce the threshold. Longer retention preserves potentially sensitive evidence, so make that choice deliberately.

## Trust boundary

The extension has no automatic edit or apply operation and grants no Safe Actions. The evaluator works in a disposable scratch directory and returns its judgment on stdout; trusted extension code validates the response and writes the report. Evaluation failures do not change the source run's outcome.

Normal host harnesses still have the user's account and filesystem authority. Scratch directories and prompt instructions are not a security sandbox. Use an externally restricted account or machine if you need a hard guarantee against a hostile harness accessing other files or credentials. Review suggestions before changing an automation.
