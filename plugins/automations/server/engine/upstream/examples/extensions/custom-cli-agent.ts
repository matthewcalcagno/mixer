import { defineExtension } from "@mixer/automations-sdk";
import { z } from "zod";

const configSchema = z.object({
  providerName: z.string().min(1),
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  timeout: z.number().int().positive().optional(),
});

export default defineExtension({
  name: "custom-cli-agent",

  setup(api) {
    const config = configSchema.parse(api.config.get());

    api.agents.register(config.providerName, {
      async run(ctx) {
        const result = await ctx.execution.run({
          command: config.command,
          args: [...config.args, ctx.prompt],
          cwd: ctx.workspace?.path,
          signal: ctx.signal,
          timeout: ctx.timeout ?? config.timeout,
          noOutputTimeout: ctx.noOutputTimeout,
          onStdout: (chunk) => ctx.logger.info({ chunk }, "agent stdout"),
          onStderr: (chunk) => ctx.logger.warn({ chunk }, "agent stderr"),
        });
        if (result.exitCode !== 0) throw new Error(`${config.command} exited with code ${result.exitCode}: ${result.stderr}`);
        return { output: result.stdout };
      },
    });
  },
});
