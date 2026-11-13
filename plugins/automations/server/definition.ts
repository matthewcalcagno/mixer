import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { CronDate, CronExpressionParser } from "cron-parser";
import { parse } from "yaml";
import { z } from "zod";
import { githubTriggerSchema } from "./github-matcher.js";
import { safeActions } from "./safe-actions.js";
import { stepsSchema } from "./steps-schema.js";

export const repositorySlug = z
  .string()
  .regex(/^[a-zA-Z0-9_-][a-zA-Z0-9_.-]*\/[a-zA-Z0-9_-][a-zA-Z0-9_.-]*$/)
  .max(200);
const scalar = z.union([z.string(), z.number(), z.boolean(), z.null()]);
const webhook = z
  .object({
    endpoints: z.array(z.string().max(200)).max(64).optional(),
    payload: z
      .record(z.string().regex(/^[\w-]+(?:\.[\w-]+){0,9}$/), z.array(scalar).min(1).max(32))
      .refine((value) => Object.keys(value).length <= 64)
      .optional(),
  })
  .strict();
const cadenceSchema = z
  .object({ startDate: z.iso.date(), everyWeeks: z.number().int().min(1).max(52) })
  .strict();
const jira = z
  .object({
    cron: z.string().min(1).max(200),
    jql: z.string().min(1).max(10_000),
    cadence: cadenceSchema.optional(),
    timezone: z.string().min(1).max(100).default("UTC"),
    fields: z
      .array(z.string().regex(/^[a-zA-Z0-9_]+$/))
      .max(32)
      .default([
        "summary",
        "description",
        "status",
        "labels",
        "components",
        "issuetype",
        "updated",
      ]),
  })
  .strict();

const fields = {
  safeActions,
  name: z.string().trim().min(1).max(200).optional(),
  disabled: z.boolean().default(false),
  repository: z.union([repositorySlug, z.array(repositorySlug).min(1).max(25)]).optional(),
  workspace: z.enum(["worktree", "scratch"]).optional(),
  cwd: z.string().min(1).optional(),
  on: z
    .object({
      "webhook.received": webhook.optional(),
      "github.issue": githubTriggerSchema.optional(),
      "github.pull-request": githubTriggerSchema.optional(),
      "github.issue.comment": githubTriggerSchema.optional(),
      "github.pr.review": githubTriggerSchema.optional(),
      "github.pr.comment": githubTriggerSchema.optional(),
      "github.check": githubTriggerSchema.optional(),
      "jira.issue": jira.optional(),
      schedule: z
        .object({ cron: z.string().min(1).max(200) })
        .strict()
        .optional(),
    })
    .strict()
    .default({}),
};

export function nextOccurrence(cron: string, from: number, tz?: string) {
  return CronExpressionParser.parse(cron, { currentDate: from, tz }).next().getTime();
}

export async function readDefinition(root: string, path: string) {
  const source = await readFile(join(root, path), "utf8");
  return parseDefinition(path, source);
}

export function parseDefinition(path: string, source: string) {
  if (source.length > 1024 * 1024) throw new Error("Workflow exceeds 1 MiB.");
  const name = path.replace(/\.[^.]+$/, "");
  if (/\.md$/i.test(path)) {
    const frontmatter = /^---[ \t]*\r?\n([\s\S]*?)^---[ \t]*(?:\r?\n|$)/m.exec(source);
    if (frontmatter?.index) throw new Error("Workflow frontmatter must start on the first line.");
    const config = z
      .object({
        ...fields,
        agent: z.string().min(1).optional(),
        model: z.string().min(1).optional(),
        thinking: z.string().min(1).optional(),
      })
      .strict()
      .parse(frontmatter ? (parse(frontmatter[1], { maxAliasCount: 0 }) ?? {}) : {});
    const prompt = (frontmatter ? source.slice(frontmatter[0].length) : source).trim();
    if (!prompt && !config.disabled) throw new Error("Enter a workflow prompt.");
    const cron = validateTriggers(config.on);
    return { ...config, kind: "agent" as const, name: config.name ?? name, prompt, cron };
  }
  const config = stepsSchema.safeExtend(fields).parse(parse(source, { maxAliasCount: 0 }));
  const cron = validateTriggers(config.on);
  return { ...config, kind: "steps" as const, name: config.name ?? name, cron };
}

function validateTriggers(on: z.output<typeof fields.on>) {
  if (on.schedule) nextOccurrence(on.schedule.cron, Date.now());
  const jiraTrigger = on["jira.issue"];
  if (jiraTrigger) nextJiraOccurrence(jiraTrigger, Date.now());
  return on.schedule?.cron;
}

// Calendar windows follow RoboPlane's Jira cadence across daylight saving changes.
export function nextJiraOccurrence(trigger: z.output<typeof jira>, from: number) {
  const { cadence, cron, timezone } = trigger;
  if (!cadence) return nextOccurrence(cron, from, timezone);
  const dayMs = 86_400_000;
  const calendarDay = (date: CronDate) =>
    Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / dayMs;
  const anchor = new CronDate(`${cadence.startDate}T00:00:00`, timezone);
  const anchorDay = calendarDay(anchor);
  const iterator = CronExpressionParser.parse(cron, {
    tz: timezone,
    currentDate: new Date(Math.max(from, anchor.getTime() - 1)),
  });
  for (;;) {
    const candidate = iterator.next();
    const week = Math.floor((calendarDay(candidate) - anchorDay) / 7);
    if (week % cadence.everyWeeks === 0) return candidate.getTime();
    const nextWeek = week + cadence.everyWeeks - (week % cadence.everyWeeks);
    const date = new Date((anchorDay + nextWeek * 7) * dayMs).toISOString().slice(0, 10);
    iterator.reset(new Date(new CronDate(`${date}T00:00:00`, timezone).getTime() - 1));
  }
}
