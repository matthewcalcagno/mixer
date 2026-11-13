import { describe, expect, it } from "vitest";
import { cadenceSchema, nextOccurrence } from "./schedule.js";

const fortnightly = {
  cron: "0 9 * * 4",
  timezone: "Europe/Madrid",
  cadence: { startDate: "2026-11-05", everyWeeks: 2 },
};

describe("anchored Jira schedules", () => {
  it("starts November 5 and continues every other Thursday through month and year boundaries", () => {
    let after = new Date("2026-10-27T10:00:00Z");
    const dates: string[] = [];
    for (let index = 0; index < 6; index++) {
      const next = nextOccurrence(fortnightly, after);
      dates.push(next);
      after = new Date(next);
    }
    expect(dates).toEqual([
      "2026-11-05T08:00:00.000Z",
      "2026-11-19T08:00:00.000Z",
      "2026-12-03T08:00:00.000Z",
      "2026-12-17T08:00:00.000Z",
      "2026-12-31T08:00:00.000Z",
      "2027-01-14T08:00:00.000Z",
    ]);
  });

  it("keeps 09:00 local time across daylight saving changes", () => {
    expect(nextOccurrence(fortnightly, new Date("2027-03-18T08:00:00Z"))).toBe("2027-03-25T08:00:00.000Z");
    expect(nextOccurrence(fortnightly, new Date("2027-03-25T08:00:00Z"))).toBe("2027-04-08T07:00:00.000Z");
    expect(nextOccurrence(fortnightly, new Date("2027-10-21T07:00:00Z"))).toBe("2027-11-04T08:00:00.000Z");
  });

  it("applies the anchor before any scan and skips excluded weeks for dense cron expressions", () => {
    const dense = { ...fortnightly, cron: "* * * * *" };
    expect(nextOccurrence(dense, new Date("2026-10-27T10:00:00Z"))).toBe("2026-11-04T23:00:00.000Z");
    expect(nextOccurrence(dense, new Date("2026-11-12T08:00:00Z"))).toBe("2026-11-18T23:00:00.000Z");
    expect(nextOccurrence(dense, new Date("2026-11-19T08:00:00Z"))).toBe("2026-11-19T08:01:00.000Z");
  });

  it("preserves plain cron behavior and rejects incomplete or invalid cadence settings", () => {
    expect(nextOccurrence({ cron: "0 9 * * 4", timezone: "Europe/Madrid" }, new Date("2026-10-27T10:00:00Z"))).toBe("2026-10-29T08:00:00.000Z");
    expect(cadenceSchema.safeParse({ startDate: "2026-11-05", everyWeeks: 2 }).success).toBe(true);
    expect(cadenceSchema.safeParse({ startDate: "2026-02-30", everyWeeks: 2 }).success).toBe(false);
    expect(cadenceSchema.safeParse({ startDate: "2026-11-05" }).success).toBe(false);
    expect(cadenceSchema.safeParse({ startDate: "2026-11-05", everyWeeks: 0 }).success).toBe(false);
  });
});
