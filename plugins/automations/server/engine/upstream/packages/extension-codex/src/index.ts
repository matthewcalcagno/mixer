import { defineExtension } from "@mixer/automations-sdk";
import { z } from "zod";

const configSchema = z.object({
  command: z.string().default("codex"),
  timeout: z.number().int().positive().optional(),
  env: z.record(z.string(), z.string()).default({}),
});

export function autonomousArgs(model?: string, directory?: string, thinking?: string): string[] {
  return ["exec", "--color", "never", "--ephemeral", "--dangerously-bypass-approvals-and-sandbox", ...(directory ? ["--cd", directory] : []), ...(model ? ["--model", model] : []), ...(thinking ? ["--config", `model_reasoning_effort=${JSON.stringify(thinking)}`] : [])];
}

export default defineExtension({
  name: "codex",
  version: "0.2.0",
  setup(api) {
    const config = configSchema.parse(api.config.get());
    api.agents.register("codex", {
      async run(context) {
        if (!context.workspace?.path) throw new Error("Codex requires an attested workspace");
        const prompt = [...context.instructions, context.prompt].filter(Boolean).join("\n\n");
        const result = await context.execution.run({
          command: config.command,
          args: [...autonomousArgs(context.model, context.workspace.path, context.thinking), prompt],
          cwd: context.workspace?.path,
          env: config.env,
          signal: context.signal,
          timeout: context.timeout ?? config.timeout,
          noOutputTimeout: context.noOutputTimeout,
          onStdout: (chunk) => context.logger.info({ stream: "stdout", chunk }),
          onStderr: (chunk) => context.logger.warn({ stream: "stderr", chunk }),
        });
        if (result.exitCode !== 0) throw new Error(`Codex exited with code ${result.exitCode}: ${result.stderr}`);
        return { output: result.stdout };
      },
    });
  },
});
