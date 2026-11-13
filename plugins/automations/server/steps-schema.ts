import path from "node:path";
import { z } from "zod";

const duration = z
  .string()
  .regex(/^\d+(?:ms|s|m|h)$/, "expected a positive duration such as 30s or 5m")
  .transform((value) => {
    const unit = value.replace(/^\d+/, "");
    const scale = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[unit];
    return Number.parseInt(value, 10) * (scale ?? 1);
  })
  .pipe(z.number().int().positive().max(2_147_483_647));
const directory = z
  .string()
  .min(1)
  .refine(
    (value) =>
      !path.isAbsolute(value) && !value.split(/[\\/]/).includes("..") && !value.includes("\0"),
    "working-directory must stay inside the workspace",
  );
export const stepsEnvironmentSchema = z
  .record(
    z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
    z
      .string({ error: "environment values must be strings; quote booleans and numbers" })
      .refine((value) => !value.includes("\0"), "environment cannot contain NUL"),
  )
  .refine(
    (values) =>
      !Object.keys(values).some((key) =>
        /^(MIXER_|PWD$|PATH$|BASH_ENV$|ENV$|SHELLOPTS$|BASHOPTS$|GIT_)/.test(key),
      ),
    "environment cannot override reserved run, shell, PATH, or Git context",
  );
const runDefaults = z
  .object({
    shell: z.enum(["bash", "sh"]).default("bash"),
    "working-directory": directory.default("."),
    timeout: duration.optional(),
    "no-output-timeout": duration.optional(),
  })
  .strict();
const step = z
  .object({
    id: z
      .string()
      .max(64)
      .regex(/^[A-Za-z_][A-Za-z0-9_-]*$/)
      .optional(),
    name: z.string().trim().min(1).optional(),
    run: z
      .string()
      .refine(
        (value) => value.trim().length > 0 && !value.includes("\0"),
        "run must be a non-empty script without NUL",
      )
      .refine(
        (value) => !value.includes("${{"),
        "GitHub Actions expressions are not supported; use environment variables",
      ),
    shell: z.enum(["bash", "sh"]).optional(),
    "working-directory": directory.optional(),
    env: stepsEnvironmentSchema.default({}),
    timeout: duration.optional(),
    "no-output-timeout": duration.optional(),
    if: z.enum(["success", "failure", "always"]).default("success"),
    "continue-on-error": z.boolean().default(false),
    retry: z
      .object({ maxAttempts: z.number().int().min(1).max(10), delay: duration.prefault("1s") })
      .strict()
      .optional(),
  })
  .strict();

export const stepsSchema = z
  .object({
    env: stepsEnvironmentSchema.default({}),
    defaults: z
      .object({ run: runDefaults.default({ shell: "bash", "working-directory": "." }) })
      .strict()
      .default({ run: { shell: "bash", "working-directory": "." } }),
    steps: z.array(step).min(1).max(1000),
  })
  .strict()
  .superRefine((value, context) => {
    const ids = new Set<string>();
    value.steps.forEach((item, index) => {
      const id = item.id ?? `step_${index + 1}`;
      if (ids.has(id))
        context.addIssue({
          code: "custom",
          path: ["steps", index, "id"],
          message: `duplicate step id: ${id}`,
        });
      ids.add(id);
    });
  });

export type StepsConfiguration = z.infer<typeof stepsSchema>;
