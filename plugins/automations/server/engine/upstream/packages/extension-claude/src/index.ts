import { defineExtension } from "@mixer/automations-sdk";
import { z } from "zod";

const configSchema = z.object({
  command: z.string().default("claude"),
  timeout: z.number().int().positive().optional(),
  env: z.record(z.string(), z.string()).default({}),
});

export function autonomousArgs(model?: string, thinking?: string): string[] {
  return ["--dangerously-skip-permissions", "--no-session-persistence", ...(model ? ["--model", model] : []), ...(thinking ? ["--effort", thinking] : []), "-p"];
}

export default defineExtension({
  name: "claude",
  version: "0.2.0",
  setup(api) {
    const config = configSchema.parse(api.config.get());
    api.agents.register("claude", {
      async run(context) {
        if (!context.workspace?.path) throw new Error("Claude requires an attested workspace");
        const prompt = [...context.instructions, context.prompt].filter(Boolean).join("\n\n");
        const result = await context.execution.run({
          command: config.command,
          args: [...autonomousArgs(context.model, context.thinking), prompt],
          cwd: context.workspace?.path,
          env: config.env,
          signal: context.signal,
          timeout: context.timeout ?? config.timeout,
          noOutputTimeout: context.noOutputTimeout,
          onStdout: (chunk) => context.logger.info({ stream: "stdout", chunk }),
          onStderr: (chunk) => context.logger.warn({ stream: "stderr", chunk }),
        });
        if (result.exitCode !== 0) throw new Error(`Claude exited with code ${result.exitCode}: ${result.stderr}`);
        return { output: result.stdout };
      },
    });
  },
});
