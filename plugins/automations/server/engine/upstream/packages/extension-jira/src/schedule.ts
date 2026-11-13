import { CronDate, CronExpressionParser } from "cron-parser";
import { z } from "@mixer/automations-sdk";

export const cadenceSchema = z.object({
  startDate: z.iso.date(),
  everyWeeks: z.number().int().min(1).max(52),
}).strict();

type Schedule = {
  cron: string;
  timezone: string;
  cadence?: z.infer<typeof cadenceSchema>;
};
const DAY_MS = 86_400_000;

// Compare calendar days, not elapsed hours, so DST does not shift the week parity.
function calendarDay(date: CronDate): number {
  return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / DAY_MS;
}

export function nextOccurrence(schedule: Schedule, after: Date): string {
  const { cron, timezone, cadence } = schedule;
  if (!cadence) return CronExpressionParser.parse(cron, { tz: timezone, currentDate: after }).next().toDate().toISOString();

  const anchor = new CronDate(`${cadence.startDate}T00:00:00`, timezone);
  const anchorDay = calendarDay(anchor);
  const iterator = CronExpressionParser.parse(cron, {
    tz: timezone,
    currentDate: new Date(Math.max(after.getTime(), anchor.getTime() - 1)),
  });
  for (;;) {
    const candidate = iterator.next();
    const week = Math.floor((calendarDay(candidate) - anchorDay) / 7);
    if (week % cadence.everyWeeks === 0) return candidate.toDate().toISOString();

    // Jump over an excluded week instead of iterating every minute of a dense cron.
    const nextWeek = week + cadence.everyWeeks - week % cadence.everyWeeks;
    const date = new Date((anchorDay + nextWeek * 7) * DAY_MS).toISOString().slice(0, 10);
    const nextWindow = new CronDate(`${date}T00:00:00`, timezone);
    iterator.reset(new Date(nextWindow.getTime() - 1));
  }
}
