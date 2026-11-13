# Agent harnesses

Workflow authors should also read `mixer-automations docs workflow-authoring` for exact frontmatter and trigger syntax.

An agent harness is a small extension that turns a prompt into one unattended CLI process. Mixer Automations bundles:

| Agent | Invocation shape |
| --- | --- |
| `codex` | `codex exec --cd <checkout> --dangerously-bypass-approvals-and-sandbox ... <prompt>` |
| `claude` | `claude --dangerously-skip-permissions ... -p <prompt>` from the attested checkout |
| `opencode` | `opencode run --auto ... <prompt>` from the attested checkout |
| `pi` | `pi --print --no-session ... <prompt>` |
| `copilot` | `copilot -C <checkout> --allow-all --no-ask-user ... -p <prompt>` |

The workflow selects the harness, model, and optional thinking mode:

```yaml
agent: codex
model: gpt-5.3-codex
thinking: high
```

`thinking` is translated by each bundled adapter using the harness's native mechanism:

| Agent | Translation |
| --- | --- |
| `codex` | `--config model_reasoning_effort=<thinking>` |
| `claude` | `--effort <thinking>` |
| `opencode` | `--model <provider/model#thinking>` (requires `model` without a variant) |
| `pi` | `--thinking <thinking>` |
| `copilot` | `--effort <thinking>` |

The value is intentionally not a shared enum. Supported levels and variants depend on the harness version and selected model. When omitted, the harness's configured default remains in effect. OpenCode requires an explicit `model` when `thinking` is set; do not specify a `#variant` in `model` and `thinking` at the same time.

Harnesses use the installed CLI's normal home-directory credentials and configuration. Mixer Automations does not have a separate agent API-key configuration layer. Host processes inherit only ordinary execution variables such as `PATH`, `HOME`, locale, terminal, and temporary-directory settings; integration secrets are not inherited automatically. An advanced installation can opt in additional values with `extensions.<agent>.env`.

Every run has a total timeout and a no-output timeout. Stdin is closed, so a CLI cannot suspend indefinitely waiting for interactive input.

When a workflow declares `safeActions`, the prompt contains only those action names, descriptions, and JSON input schemas. A subprocess requests an action in its final `MIXER_AUTOMATIONS_RESULT` line. Mixer Automations validates and executes the proposal after the process exits; the harness must not claim the external action already succeeded. See `mixer-automations docs safe-actions`.

Codex and Copilot receive their documented explicit project-directory flag. OpenCode, Claude, and Pi define their project from the process working directory, so Mixer Automations launches them from the attested checkout or scratch directory. Every adapter also receives the same absolute-path instruction. An adapter must fail rather than run without a workspace.

## Extension contract

```ts
api.agents.register("my-agent", {
  async run(ctx) {
    const result = await ctx.execution.run({
      command: "my-agent",
      args: ["--automatic", ctx.prompt],
      cwd: ctx.workspace?.path,
      signal: ctx.signal,
      timeout: ctx.timeout,
      noOutputTimeout: ctx.noOutputTimeout,
    });
    if (result.exitCode !== 0) throw new Error(result.stderr);
    return { output: result.stdout };
  },
});
```

Adapters should use the harness's explicit directory option when it has one. Process `cwd` remains mandatory for every adapter.

There is no multi-agent handoff format. Managed execution asks for one final `MIXER_AUTOMATIONS_RESULT` line; missing or malformed reports are recorded as unknown, and no Safe Action is inferred from prose. Output is logged for inspection.

Scripted `.yaml` and `.yml` workflows can submit normal Markdown agent workflows using `mixer-automations automations run ...`. This does not alter agent reporting: children are independent and never return results to parents. Read `mixer-automations docs scripted-workflows` and `mixer-automations docs workflow-handoffs`. YAML rejects `agent`, `model`, and `thinking`; these remain in the invoked Markdown workflow.
