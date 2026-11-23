export function skipMissedSchedules(file, text) {
  const replace = (before, after) => {
    if (!text.includes(before)) throw new Error(`Schedule import seam changed: ${file}`);
    text = text.replace(before, after);
  };
  const startupArms = {
    "extension-scheduler": "arm",
    "extension-github": "armPrSchedule",
    "extension-jira": "arm",
  };
  for (const [extension, arm] of Object.entries(startupArms)) {
    if (file !== `packages/${extension}/src/index.ts`) continue;
    replace(`const ${arm} = ()`, `const ${arm} = (skipBefore?: number)`);
    const end = `        ${arm}();\n      },\n      updateSubscriptions`;
    replace(end, `        ${arm}(Date.now());\n      },\n      updateSubscriptions`);
    if (extension === "extension-scheduler") {
      replace(
        "const next = stored ? new Date(stored) : nextAfter(cron, new Date(now));\n        if (!stored)",
        "const next = stored && (skipBefore === undefined || Date.parse(stored) >= skipBefore)\n          ? new Date(stored) : nextAfter(cron, new Date(now));\n        if (stored !== next.toISOString())",
      );
      replace(
        '// One catch-up run is emitted after downtime. The next occurrence is\n          // calculated from "now" so a long outage cannot create a run storm.',
        "// Advance from the current time after delivering the active occurrence.",
      );
      replace("              caughtUp: now.getTime() - scheduled.getTime() >= MAX_TIMER_MS,\n", "");
    } else if (extension === "extension-github") {
      replace(
        "const next = state.get<string>(key) ?? nextPrSchedule(cron, now).toISOString();\n        if (!state.get<string>(key))",
        "const stored = state.get<string>(key);\n        const next = stored && (skipBefore === undefined || Date.parse(stored) >= skipBefore)\n          ? stored : nextPrSchedule(cron, now).toISOString();\n        if (stored !== next)",
      );
    } else {
      replace(
        "const stored = state.get<string>(`next:${id}`) ?? nextOccurrence(trigger, new Date(now));\n        state.set(`next:${id}`, stored);",
        "const stored = state.get<string>(`next:${id}`);\n        const next = stored && (skipBefore === undefined || Date.parse(stored) >= skipBefore)\n          ? stored : nextOccurrence(trigger, new Date(now));\n        if (stored !== next) state.set(`next:${id}`, next);",
      );
      replace("Math.max(0, Date.parse(stored) - now,", "Math.max(0, Date.parse(next) - now,");
    }
  }
  if (file === "packages/extension-scheduler/src/index.test.ts") {
    replace("emits one catch-up after downtime", "skips missed runs after a week offline");
    replace(
      'vi.setSystemTime(new Date("2026-01-01T00:05:00.000Z"));',
      'vi.setSystemTime(new Date("2026-01-08T00:05:00.000Z"));',
    );
    replace(
      "    expect(events).toHaveLength(2);\n    expect((events[1] as { data: { caughtUp: boolean } }).data.caughtUp).toBe(true);",
      '    expect(events).toHaveLength(1);\n    await vi.advanceTimersByTimeAsync(60_000);\n    expect(events).toHaveLength(2);\n    expect(events[1]).toMatchObject({ data: { scheduledFor: "2026-01-08T00:06:00.000Z" } });\n    source.stop();',
    );
  }
  if (file === "docs/workflow-authoring.md")
    replace(
      "After downtime, the scheduler emits at most one catch-up run per workflow and calculates the next occurrence from the current time. It does not replay every missed interval.",
      "When Automations starts, it skips missed occurrences and waits for the next scheduled time.",
    );
  if (file === "docs/jira.md")
    replace(
      "After downtime, a persisted overdue schedule performs one catch-up scan, then resumes from the next future occurrence.",
      "When Automations starts, it skips overdue scans and waits for the next cron occurrence.",
    );
  return text;
}
