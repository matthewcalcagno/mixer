import { defineExtension } from "@mixer/automations-sdk";
import { z } from "zod";

const configSchema = z.object({
  command: z.string().default("copilot"),
  timeout: z.number().int().positive().optional(),
  env: z.record(z.string(), z.string()).default({}),
});

export function autonomousArgs(model?: string, directory?: string, thinking?: string): string[] {
  return ["--allow-all", "--no-ask-user", ...(directory ? ["-C", directory] : []), ...(model ? ["--model", model] : []), ...(thinking ? ["--effort", thinking] : []), "-p"];
}

export default defineExtension({
  name: "copilot",
  version: "0.2.0",
  setup(api) {
    const config = configSchema.parse(api.config.get());
    api.agents.register("copilot", {
      async run(context) {
        if (!context.workspace?.path) throw new Error("Copilot requires an attested workspace");
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
        if (result.exitCode !== 0) throw new Error(`Copilot exited with code ${result.exitCode}: ${result.stderr}`);
        return { output: result.stdout };
      },
    });
  },
});
