import { createHash } from "node:crypto";
import { CronExpressionParser } from "cron-parser";
import { defineExtension, z, type Event, type EventSourceContext, type WorkflowSubscription } from "@mixer/automations-sdk";
import { configSchema, JiraClient } from "./client.js";
import { cadenceSchema, nextOccurrence } from "./schedule.js";

const triggerSchema = z.object({
  cron: z.string().min(1),
  timezone: z.string().min(1).default("UTC"),
  cadence: cadenceSchema.optional(),
  jql: z.string().trim().min(1),
  fields: z.array(z.string().min(1)).default(["summary", "description", "status", "labels", "components", "issuetype", "updated"]),
}).strict().superRefine((value, ctx) => {
  try {
    new Intl.DateTimeFormat("en", { timeZone: value.timezone });
    CronExpressionParser.parse(value.cron, { tz: value.timezone });
  }
  catch { ctx.addIssue({ code: "custom", message: "invalid cron expression or timezone", path: ["cron"] }); }
});
const eventDataSchema = z.object({
  workflowId: z.string().min(1),
  subscriptionId: z.string().min(1),
  issue: z.object({ id: z.string().regex(/^\d+$/), key: z.string().regex(/^[A-Z][A-Z0-9_]*-\d+$/), summary: z.string(), updated: z.string(), url: z.string() }),
});
type Trigger = z.infer<typeof triggerSchema>;
const RETRY_MS = 60_000;
const hash = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");

// ORDER BY is allowed in a subscription, but must follow the added key predicate.
// Ignore quoted literals and escaped quotes when locating that clause.
function forIssue(jql: string, key: string): string {
  let quote: string | undefined;
  for (let index = 0; index < jql.length; index++) {
    const char = jql[index];
    if (char === "\\") { index++; continue; }
    if (quote) { if (char === quote) quote = undefined; continue; }
    if (char === '"' || char === "'") { quote = char; continue; }
    if ((index === 0 || /\s/.test(jql[index - 1] ?? "")) && /^order\s+by\b/i.test(jql.slice(index))) {
      return `(${jql.slice(0, index).trim()}) AND key = "${key}" ${jql.slice(index)}`;
    }
  }
  return `(${jql}) AND key = "${key}"`;
}

export default defineExtension({
  name: "jira",
  version: "0.1.0",
  setup(api) {
    const config = configSchema.parse(api.config.get() ?? {});
    const client = "baseUrl" in config ? new JiraClient(config) : undefined;
    const state = api.state.namespace();
    const subscriptionId = (subscription: Pick<WorkflowSubscription, "workflowId" | "repository">, trigger: Trigger) => hash({
      baseUrl: "baseUrl" in config ? config.baseUrl : null,
      workflowId: subscription.workflowId,
      repository: subscription.repository ?? null,
      trigger,
    });
    let context: EventSourceContext | undefined;
    let subscriptions: readonly WorkflowSubscription[] = [];
    let timer: NodeJS.Timeout | undefined;
    let polling: Promise<void> | undefined;
    let controller = new AbortController();
    const retryAt = new Map<string, number>();

    const arm = (): void => {
      if (timer) clearTimeout(timer);
      timer = undefined;
      if (!context || context.signal.aborted || polling) return;
      const now = Date.now();
      const waits = subscriptions.map((subscription) => {
        const trigger = triggerSchema.parse(subscription.config);
        const id = subscriptionId(subscription, trigger);
        const stored = state.get<string>(`next:${id}`) ?? nextOccurrence(trigger, new Date(now));
        state.set(`next:${id}`, stored);
        return Math.max(0, Date.parse(stored) - now, (retryAt.get(id) ?? 0) - now);
      });
      if (waits.length) timer = setTimeout(() => {
        polling = poll();
        void polling.finally(() => { polling = undefined; arm(); });
      }, Math.min(RETRY_MS, ...waits));
    };

    const poll = async (): Promise<void> => {
      const active = context;
      if (!active || active.signal.aborted || !client) return;
      const signal = AbortSignal.any([active.signal, controller.signal]);
      let failed = false;
      for (const subscription of subscriptions) {
        if (signal.aborted) return;
        const trigger = triggerSchema.parse(subscription.config);
        const id = subscriptionId(subscription, trigger);
        const now = new Date();
        const scheduled = state.get<string>(`next:${id}`) ?? nextOccurrence(trigger, now);
        if (Date.parse(scheduled) > now.getTime() || (retryAt.get(id) ?? 0) > now.getTime()) continue;
        try {
          let startAt = 0;
          let more = true;
          while (more) {
            const page = await client.search({ jql: trigger.jql, fields: ["summary", "updated"], startAt, signal });
            if (page.startAt !== startAt || (!page.issues.length && startAt < page.total)) throw new Error("Jira pagination did not advance");
            for (const issue of page.issues) {
              if (signal.aborted) return;
              const receiptKey = `delivered:${id}:${issue.id}`;
              if (state.get<string>(receiptKey) === issue.fields.updated) continue;
              const event: Event = {
                id: `jira:${id}:${issue.id}:${hash(issue.fields.updated)}`,
                type: "jira.issue",
                source: "jira",
                timestamp: now.toISOString(),
                repository: subscription.repository,
                data: {
                  workflowId: subscription.workflowId,
                  subscriptionId: id,
                  issue: { id: issue.id, key: issue.key, summary: issue.fields.summary, updated: issue.fields.updated, url: client.browseUrl(issue.key) },
                },
              };
              const result = await active.emit(event);
              if (result === false || (typeof result === "object" && result.status === "rejected")) throw new Error("Jira event admission rejected; delivery will be retried");
              state.set(receiptKey, issue.fields.updated);
            }
            startAt += page.issues.length;
            more = startAt < page.total;
          }
          state.set(`next:${id}`, nextOccurrence(trigger, now));
          retryAt.delete(id);
        } catch (error) {
          if (signal.aborted) return;
          failed = true;
          retryAt.set(id, Date.now() + RETRY_MS);
          active.reportHealth?.({ version: 1, status: "degraded", observedAt: new Date().toISOString(), result: "failure", reason: error instanceof Error ? error.message : "Jira polling failed" });
        }
      }
      if (!failed && !retryAt.size) active.reportHealth?.({ version: 1, status: "ready", observedAt: new Date().toISOString(), result: "success" });
    };

    api.events.registerSource("jira.issue", {
      configSchema: triggerSchema,
      resourceKey(event) {
        const parsed = eventDataSchema.safeParse(event.data);
        return parsed.success ? `jira:${hash("baseUrl" in config ? config.baseUrl : null)}:${parsed.data.issue.id}` : undefined;
      },
      start(nextContext) {
        if (nextContext.subscriptions.length && !client) throw new Error("Jira subscriptions require extensions.jira.baseUrl and extensions.jira.token");
        controller = new AbortController();
        context = nextContext;
        subscriptions = nextContext.subscriptions;
        nextContext.signal.addEventListener("abort", () => { if (timer) clearTimeout(timer); timer = undefined; }, { once: true });
        arm();
      },
      updateSubscriptions(_type, nextSubscriptions) {
        if (nextSubscriptions.length && !client) throw new Error("Jira subscriptions require extensions.jira.baseUrl and extensions.jira.token");
        subscriptions = nextSubscriptions;
        const current = new Set(subscriptions.map((subscription) => subscriptionId(subscription, triggerSchema.parse(subscription.config))));
        for (const id of retryAt.keys()) if (!current.has(id)) retryAt.delete(id);
        arm();
      },
      match(event, input, operation) {
        const data = eventDataSchema.safeParse(event.data);
        const trigger = triggerSchema.safeParse(input);
        return event.type === "jira.issue" && data.success && trigger.success
          && data.data.workflowId === operation?.workflowId
          && data.data.subscriptionId === subscriptionId({ workflowId: data.data.workflowId, repository: event.repository }, trigger.data);
      },
      async activate(event, operation) {
        if (!client) throw new Error("Jira activation requires extensions.jira.baseUrl and extensions.jira.token");
        const data = eventDataSchema.parse(event.data);
        const trigger = triggerSchema.parse(operation?.workflow?.on["jira.issue"]);
        const signal = operation?.deadline
          ? AbortSignal.any([operation.signal, AbortSignal.timeout(Math.max(1, Date.parse(operation.deadline) - Date.now()))])
          : operation?.signal;
        const page = await client.search({ jql: forIssue(trigger.jql, data.issue.key), fields: [...new Set([...trigger.fields, "summary", "updated"])], maxResults: 1, signal });
        const issue = page.issues[0];
        if (!issue) return { decision: { kind: "skip", reason: "jira_issue_no_longer_eligible" } };
        if (issue.id !== data.issue.id || issue.key !== data.issue.key || issue.fields.updated !== data.issue.updated) {
          return { decision: { kind: "skip", reason: "jira_issue_changed_since_discovery" } };
        }
        return { data: { ...data, issue: { ...data.issue, fields: issue.fields }, names: page.names ?? {} } };
      },
      async stop() {
        controller.abort();
        if (timer) clearTimeout(timer);
        timer = undefined;
        context = undefined;
        subscriptions = [];
        await polling;
        retryAt.clear();
      },
    });
  },
});
