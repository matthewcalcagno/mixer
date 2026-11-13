import { defineExtension } from "@mixer/automations-sdk";
import { z } from "zod";

const configSchema = z.object({
  command: z.string().default("opencode"),
  timeout: z.number().int().positive().optional(),
  env: z.record(z.string(), z.string()).default({}),
});

export function autonomousArgs(model?: string, thinking?: string): string[] {
  if (thinking && !model) throw new Error("OpenCode thinking requires a workflow model");
  if (thinking && model?.includes("#")) throw new Error("OpenCode model already specifies a variant; omit workflow thinking");
  return ["run", "--auto", ...(model ? ["--model", thinking ? `${model}#${thinking}` : model] : [])];
}

export default defineExtension({
  name: "opencode",
  version: "0.2.0",
  setup(api) {
    const config = configSchema.parse(api.config.get());
    api.agents.register("opencode", {
      async run(context) {
        if (!context.workspace?.path) throw new Error("OpenCode requires an attested workspace");
        const prompt = [...context.instructions, context.prompt].filter(Boolean).join("\n\n");
        const result = await context.execution.run({
          command: config.command,
          args: [...autonomousArgs(context.model, context.thinking), prompt],
          cwd: context.workspace.path,
          env: config.env,
          signal: context.signal,
          timeout: context.timeout ?? config.timeout,
          noOutputTimeout: context.noOutputTimeout,
          onStdout: (chunk) => context.logger.info({ stream: "stdout", chunk }),
          onStderr: (chunk) => context.logger.warn({ stream: "stderr", chunk }),
        });
        if (result.exitCode !== 0) throw new Error(`OpenCode exited with code ${result.exitCode}: ${result.stderr}`);
        return { output: result.stdout };
      },
    });
  },
});
