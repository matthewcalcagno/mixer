import { afterEach, describe, expect, it, vi } from "vitest";
import type { MixerAutomationsAPI, WorkflowSubscription } from "@mixer/automations-sdk";
import scheduler from "./index.js";

describe("durable scheduler", () => {
  afterEach(() => vi.useRealTimers());

  it("persists the next occurrence and emits one catch-up after downtime", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    let source: any;
    const values = new Map<string, unknown>();
    const events: unknown[] = [];
    const subscription: WorkflowSubscription = { type: "schedule", config: { cron: "* * * * *" }, workflowId: "weekly.md", repository: "owner/repo" };
    const api = {
      state: { namespace: () => ({
        get: (key: string) => values.get(key),
        set: (key: string, value: unknown) => values.set(key, value),
        delete: (key: string) => values.delete(key),
      }) },
      events: { registerSource: (_type: string, registered: unknown) => { source = registered; } },
    } as unknown as MixerAutomationsAPI;
    scheduler.setup!(api);
    const context = {
      type: "schedule", signal: new AbortController().signal, subscriptions: [subscription],
      emit: vi.fn(async (event) => { events.push(event); return true; }),
    };
    source.start(context);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(events).toHaveLength(1);
    expect((events[0] as { data: { scheduledFor: string } }).data.scheduledFor).toBe("2026-01-01T00:01:00.000Z");
    expect((events[0] as { data: { workflowId: string } }).data.workflowId).toBe("weekly.md");
    source.stop();

    vi.setSystemTime(new Date("2026-01-01T00:05:00.000Z"));
    source.start(context);
    await vi.advanceTimersByTimeAsync(0);
    expect(events).toHaveLength(2);
    expect((events[1] as { data: { caughtUp: boolean } }).data.caughtUp).toBe(true);
  });

  it("matches only the workflow that emitted a shared cron schedule", () => {
    let source: any;
    const api = {
      state: { namespace: () => ({ get: () => undefined, set: () => {}, delete: () => {} }) },
      events: { registerSource: (_type: string, registered: unknown) => { source = registered; } },
    } as unknown as MixerAutomationsAPI;
    scheduler.setup!(api);
    const event = {
      id: "schedule:weekly-a.md:2026-01-01T00:01:00.000Z",
      data: { cron: "* * * * *", workflowId: "weekly-a.md" },
    };

    const operation = { signal: new AbortController().signal, workflowId: "weekly-a.md" };
    expect(source.match(event, { cron: "* * * * *" }, operation)).toBe(true);
    expect(source.match(event, { cron: "* * * * *" }, { ...operation, workflowId: "weekly-b.md" })).toBe(false);
    expect(source.match(event, { cron: "*/5 * * * *" }, operation)).toBe(false);
  });

  it("tracks and emits each repository subscription independently", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    let source: any;
    const values = new Map<string, unknown>();
    const events: Array<{ id: string; repository?: string }> = [];
    const subscriptions: WorkflowSubscription[] = ["owner/one", "owner/two"].map((repository) => ({
      type: "schedule", config: { cron: "* * * * *" }, workflowId: "weekly.md", repository,
    }));
    const api = {
      state: { namespace: () => ({ get: (key: string) => values.get(key), set: (key: string, value: unknown) => values.set(key, value), delete: (key: string) => values.delete(key) }) },
      events: { registerSource: (_type: string, registered: unknown) => { source = registered; } },
    } as unknown as MixerAutomationsAPI;
    scheduler.setup!(api);
    source.start({ type: "schedule", signal: new AbortController().signal, subscriptions, emit: async (event: typeof events[number]) => { events.push(event); return true; } });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(events.map((event) => event.repository)).toEqual(["owner/one", "owner/two"]);
    expect(new Set(events.map((event) => event.id)).size).toBe(2);
    expect(values.size).toBe(2);
    source.stop();
  });

  it("retains a due occurrence when emission fails", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    let source: any;
    const values = new Map<string, unknown>();
    const subscription: WorkflowSubscription = { type: "schedule", config: { cron: "* * * * *" }, workflowId: "weekly.md" };
    const api = {
      state: { namespace: () => ({
        get: (key: string) => values.get(key), set: (key: string, value: unknown) => values.set(key, value), delete: (key: string) => values.delete(key),
      }) },
      events: { registerSource: (_type: string, registered: unknown) => { source = registered; } },
    } as unknown as MixerAutomationsAPI;
    scheduler.setup!(api);
    const emit = vi.fn()
      .mockRejectedValueOnce(new Error("database unavailable"))
      .mockResolvedValue({ version: 1, eventId: "event", status: "accepted" });
    source.start({ type: "schedule", signal: new AbortController().signal, subscriptions: [subscription], emit });
    await vi.advanceTimersByTimeAsync(60_000);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(emit.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(emit.mock.calls[0]?.[0].data.scheduledFor).toBe("2026-01-01T00:01:00.000Z");
    expect(emit.mock.calls[1]?.[0].data.scheduledFor).toBe("2026-01-01T00:01:00.000Z");
    source.stop();
  });
});
