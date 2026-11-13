import { createHash } from "node:crypto";
import { CronExpressionParser } from "cron-parser";
import { z } from "zod";
import { defineExtension, type EventSourceContext, type WorkflowSubscription } from "@mixer/automations-sdk";

const scheduleSchema = z.object({
  cron: z.string().min(1).refine((value) => {
    try { CronExpressionParser.parse(value); return true; }
    catch { return false; }
  }, "invalid cron expression"),
}).strict();
const MAX_TIMER_MS = 60_000;

function isRepositoryFanout(subscription: WorkflowSubscription, cron: string, subscriptions: readonly WorkflowSubscription[]): boolean {
  return subscriptions.filter((candidate) => candidate.workflowId === subscription.workflowId && scheduleSchema.parse(candidate.config).cron === cron).length > 1;
}

function key(subscription: WorkflowSubscription, cron: string, fanout: boolean): string {
  const hash = createHash("sha256").update(cron).digest("hex").slice(0, 12);
  return `next:${subscription.workflowId}${fanout ? `:${subscription.repository ?? "none"}` : ""}:${hash}`;
}

function nextAfter(cron: string, date: Date): Date {
  return CronExpressionParser.parse(cron, { currentDate: date }).next().toDate();
}

export default defineExtension({
  name: "scheduler",
  version: "0.2.0",
  setup(api) {
    const state = api.state.namespace();
    let context: EventSourceContext | undefined;
    let subscriptions: readonly WorkflowSubscription[] = [];
    let timer: NodeJS.Timeout | undefined;
    let ticking = false;

    const arm = (): void => {
      if (!context || context.signal.aborted) return;
      if (timer) clearTimeout(timer);
      const now = Date.now();
      const waits = subscriptions.map((subscription) => {
        const { cron } = scheduleSchema.parse(subscription.config);
        const stateKey = key(subscription, cron, isRepositoryFanout(subscription, cron, subscriptions));
        const stored = state.get<string>(stateKey);
        const next = stored ? new Date(stored) : nextAfter(cron, new Date(now));
        if (!stored) state.set(stateKey, next.toISOString());
        return Math.max(0, next.getTime() - now);
      });
      if (!waits.length) return;
      timer = setTimeout(() => void tick(), Math.min(MAX_TIMER_MS, ...waits));
    };

    const tick = async (): Promise<void> => {
      if (!context || context.signal.aborted || ticking) return;
      ticking = true;
      try {
        const now = new Date();
        for (const subscription of subscriptions) {
          const { cron } = scheduleSchema.parse(subscription.config);
          const fanout = isRepositoryFanout(subscription, cron, subscriptions);
          const stateKey = key(subscription, cron, fanout);
          const stored = state.get<string>(stateKey);
          const scheduled = stored ? new Date(stored) : nextAfter(cron, now);
          if (!stored) state.set(stateKey, scheduled.toISOString());
          if (scheduled.getTime() > now.getTime()) continue;

          // One catch-up run is emitted after downtime. The next occurrence is
          // calculated from "now" so a long outage cannot create a run storm.
          const next = nextAfter(cron, now);
          const result = await context.emit({
            id: `schedule:${subscription.workflowId}:${fanout ? `${subscription.repository ?? "none"}:` : ""}${scheduled.toISOString()}`,
            type: "schedule",
            source: "scheduler",
            timestamp: now.toISOString(),
            repository: subscription.repository,
            data: {
              cron,
              workflowId: subscription.workflowId,
              scheduledFor: scheduled.toISOString(),
              caughtUp: now.getTime() - scheduled.getTime() >= MAX_TIMER_MS,
            },
          });
          const rejected = typeof result === "object" && result.status === "rejected";
          if (!rejected) state.set(stateKey, next.toISOString());
        }
      } catch (error) {
        context.reportHealth?.({
          version: 1,
          status: "degraded",
          observedAt: new Date().toISOString(),
          reason: error instanceof Error ? error.message : String(error),
        });
      } finally {
        ticking = false;
        arm();
      }
    };

    api.events.registerSource("schedule", {
      configSchema: scheduleSchema,
      start(nextContext) {
        context = nextContext;
        subscriptions = nextContext.subscriptions;
        nextContext.signal.addEventListener("abort", () => {
          if (timer) clearTimeout(timer);
          timer = undefined;
        }, { once: true });
        arm();
      },
      updateSubscriptions(_type, nextSubscriptions) {
        subscriptions = nextSubscriptions;
        arm();
      },
      match(event, config, operation) {
        const parsed = scheduleSchema.safeParse(config);
        const data = event.data as { cron?: string; workflowId?: string };
        return parsed.success
          && data.cron === parsed.data.cron
          && data.workflowId === operation?.workflowId;
      },
      stop() {
        if (timer) clearTimeout(timer);
        timer = undefined;
        context = undefined;
        subscriptions = [];
      },
    });
  },
});
