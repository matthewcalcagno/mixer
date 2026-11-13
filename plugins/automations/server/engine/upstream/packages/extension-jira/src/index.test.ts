import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Runtime, ensureHome, resolvePaths } from "@roboplane/core";
import scratch from "@roboplane/extension-scratch";
import { z, type Event, type EventEmitResult, type EventSourceHealth, type Extension, type Workflow, type WorkflowSubscription } from "@mixer/automations-sdk";
import jira from "./index.js";
import { configSchema, JiraClient } from "./client.js";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.useRealTimers();
});

const query = z.object({ jql: z.string(), fields: z.array(z.string()), startAt: z.number(), maxResults: z.number() });
const issue = (number: number, updated = "2026-01-01T00:00:00.000+0000") => ({
  id: String(number), key: `TEST-${number}`, fields: { summary: `Issue ${number}`, updated },
});
const subscription = (workflowId = "refine.md", jql = 'project = TEST AND labels = "refinement_requested"'): WorkflowSubscription => ({
  type: "jira.issue", workflowId, config: { cron: "* * * * *", jql },
});
const definition = (sub: WorkflowSubscription): Workflow => ({
  id: sub.workflowId, name: "Refine", path: "/refine.md", agent: "test", execution: "host", workspace: "scratch",
  repository: sub.repository, on: { "jira.issue": sub.config }, safeActions: {}, prompt: "Read one ticket.",
});

async function waitFor(assertion: () => void): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try { assertion(); return; }
    catch (error) { if (attempt === 199) throw error; }
    await delay(5);
  }
}

async function server() {
  const requests: Array<z.infer<typeof query>> = [];
  let items = [issue(1), issue(2), issue(3)];
  let status = 200;
  let malformed = false;
  let hanging = false;
  const http = createServer(async (request, response) => {
    if (hanging) return;
    if (request.method !== "POST" || request.url !== "/jira/rest/api/2/search") { response.writeHead(501).end(); return; }
    if (request.headers.authorization !== "Bearer test-secret") { response.writeHead(401).end(); return; }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const parsed = query.parse(JSON.parse(Buffer.concat(chunks).toString()));
    requests.push(parsed);
    response.setHeader("content-type", "application/json");
    if (status === 302) response.setHeader("location", "/unexpected-login");
    if (status !== 200) { response.writeHead(status).end('{"error":"test-secret must not be logged"}'); return; }
    if (malformed) { response.end('{"issues":[]}'); return; }
    const key = /AND key = "(TEST-\d+)"/.exec(parsed.jql)?.[1];
    const matches = key ? items.filter((item) => item.key === key) : items;
    const page = matches.slice(parsed.startAt, parsed.startAt + Math.min(parsed.maxResults, 2));
    response.end(JSON.stringify({ startAt: parsed.startAt, maxResults: 2, total: matches.length, issues: page, names: { summary: "Summary" } }));
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const address = http.address();
  if (!address || typeof address === "string") throw new Error("No HTTP fixture address");
  cleanups.push(async () => {
    http.closeAllConnections();
    await new Promise<void>((resolve, reject) => http.close((error) => error ? reject(error) : resolve()));
  });
  return {
    baseUrl: `http://127.0.0.1:${address.port}/jira`, requests,
    setItems(value: typeof items) { items = value; },
    setStatus(value: number) { status = value; },
    setMalformed(value: boolean) { malformed = value; },
    setHanging(value: boolean) { hanging = value; },
  };
}

async function setup(config: unknown, home?: string) {
  if (!home) {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "roboplane-jira-"));
    const directory = home;
    cleanups.push(() => fs.rmSync(directory, { recursive: true, force: true }));
    ensureHome(resolvePaths(home));
    fs.writeFileSync(resolvePaths(home).config, JSON.stringify({ extensions: { jira: config } }));
  }
  const runtime = new Runtime({ home, builtins: [{ extension: jira }] });
  await runtime.initialize();
  cleanups.push(() => runtime.stop());
  const source = runtime.registry.eventSources.get("jira.issue");
  if (!source) throw new Error("Jira source was not registered");
  const events: Event[] = [];
  const health: EventSourceHealth[] = [];
  const controller = new AbortController();
  cleanups.push(async () => { controller.abort(); await source.stop?.(); });
  const start = (subscriptions: WorkflowSubscription[] = [subscription()], emit?: (event: Event) => Promise<boolean | EventEmitResult>) => source.start({
    type: "jira.issue", subscriptions, signal: controller.signal,
    emit: emit ?? (async (event) => { events.push(event); return { version: 1, eventId: event.id, status: "accepted" }; }),
    reportHealth: (value) => { health.push(value); },
  });
  return { runtime, home, source, events, health, start };
}

function clock() {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
}

describe("Jira issue polling", () => {
  it("does not contact Jira before the anchor or in the intervening week", async () => {
    const http = await server();
    clock();
    vi.setSystemTime(new Date("2026-10-27T10:00:00Z"));
    const fixture = await setup({ baseUrl: http.baseUrl, token: "test-secret" });
    const sub = {
      ...subscription(),
      config: { cron: "0 9 * * 4", timezone: "Europe/Madrid", jql: "project = TEST", cadence: { startDate: "2026-11-05", everyWeeks: 2 } },
    };
    await fixture.start([sub]);
    vi.setSystemTime(new Date("2026-11-05T07:59:00Z"));
    await vi.advanceTimersByTimeAsync(59_999);
    expect(http.requests).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    await waitFor(() => expect(fixture.events).toHaveLength(3));
    await fixture.source.stop?.();
    expect(http.requests).toHaveLength(2);

    vi.setSystemTime(new Date("2026-11-12T08:00:00Z"));
    await fixture.start([sub]);
    await vi.advanceTimersByTimeAsync(60_000);
    await fixture.source.stop?.();
    expect(http.requests).toHaveLength(2);

    http.setItems([issue(1, "2026-11-19T07:00:00Z"), issue(2), issue(3)]);
    vi.setSystemTime(new Date("2026-11-19T07:59:00Z"));
    await fixture.start([sub]);
    await vi.advanceTimersByTimeAsync(60_000);
    await waitFor(() => expect(fixture.events).toHaveLength(4));
    expect(fixture.events.at(-1)?.data).toMatchObject({ issue: { key: "TEST-1", updated: "2026-11-19T07:00:00Z" } });
  });

  it("routes each ticket through live activation into its own isolated agent run", async () => {
    const http = await server();
    clock();
    const fixture = await setup({ baseUrl: http.baseUrl, token: "test-secret" });
    await fixture.start();
    await vi.advanceTimersByTimeAsync(60_000);
    await waitFor(() => expect(fixture.events).toHaveLength(3));
    await fixture.runtime.stop();
    vi.useRealTimers();
    const observed: Array<{ key: string; workspace: string | undefined }> = [];
    const testHarness: Extension = {
      name: "test-harness",
      setup(api) {
        api.workflows.registerDiscovery("test", { watchPaths: [], discover: () => ({ workflows: [definition(subscription())], errors: [] }) });
        api.executions.register("host", { isolation: "none", open: () => ({ process: api.process, close() {} }) });
        api.agents.register("test", { run(context) {
          const data = z.object({ issue: z.object({ key: z.string(), fields: z.object({ summary: z.string() }) }) }).parse(context.event.data);
          observed.push({ key: data.issue.key, workspace: context.workspace?.path });
          return { version: 1, outcome: "no-op", reason: data.issue.fields.summary };
        } });
      },
    };
    const runtime = new Runtime({ home: fixture.home, builtins: [{ extension: jira }, { extension: scratch }, { extension: testHarness }] });
    await runtime.initialize();
    cleanups.push(() => runtime.stop());
    expect(runtime.workflowErrors).toEqual([]);
    for (const event of fixture.events) await runtime.receive(event);
    await runtime.idle();
    expect(observed.map((value) => value.key).sort()).toEqual(["TEST-1", "TEST-2", "TEST-3"]);
    expect(new Set(observed.map((value) => value.workspace)).size).toBe(3);
    expect(runtime.database.listRuns().map((run) => run.status)).toEqual(["completed", "completed", "completed"]);
    expect(observed.every((value) => value.workspace && !fs.existsSync(value.workspace))).toBe(true);
  });

  it("paginates into separate ticket events and skips unchanged versions across polls and restarts", async () => {
    const http = await server();
    clock();
    const fixture = await setup({ baseUrl: http.baseUrl, token: "test-secret" });
    await fixture.start();
    expect(fixture.source.configSchema?.safeParse({ cron: "bad", jql: "project = TEST" }).success).toBe(false);
    await vi.advanceTimersByTimeAsync(60_000);
    await waitFor(() => expect(fixture.events).toHaveLength(3));
    await fixture.source.stop?.();
    expect(fixture.events.map((event) => z.object({ issue: z.object({ key: z.string() }) }).parse(event.data).issue.key)).toEqual(["TEST-1", "TEST-2", "TEST-3"]);
    expect(http.requests.map((request) => request.startAt)).toEqual([0, 2]);
    expect(fixture.events[0]?.repository).toBeUndefined();
    expect(JSON.stringify(fixture.events)).not.toContain("test-secret");
    await fixture.runtime.stop();

    const restarted = await setup({}, fixture.home);
    await restarted.start();
    await vi.advanceTimersByTimeAsync(60_000);
    await waitFor(() => expect(http.requests).toHaveLength(4));
    await restarted.source.stop?.();
    expect(restarted.events).toEqual([]);
    http.setItems([issue(1, "2026-01-01T00:02:00.000+0000"), issue(2), issue(3)]);
    await restarted.start();
    await vi.advanceTimersByTimeAsync(60_000);
    await waitFor(() => expect(restarted.events).toHaveLength(1));
    expect(restarted.events[0]?.data).toMatchObject({ issue: { key: "TEST-1", updated: "2026-01-01T00:02:00.000+0000" } });
    expect(restarted.events[0]?.id).not.toBe(fixture.events[0]?.id);
  });

  it("retries rejected admission without redelivering accepted tickets or changing the rejected event ID", async () => {
    const http = await server();
    http.setItems([issue(1), issue(2)]);
    clock();
    const fixture = await setup({ baseUrl: http.baseUrl, token: "test-secret" });
    const deliveries: Event[] = [];
    let reject = true;
    await fixture.start([subscription()], async (event) => {
      deliveries.push(event);
      if (deliveries.length === 2 && reject) return { version: 1, eventId: event.id, status: "rejected" };
      return { version: 1, eventId: event.id, status: "accepted" };
    });
    await vi.advanceTimersByTimeAsync(60_000);
    await waitFor(() => expect(fixture.health.at(-1)?.status).toBe("degraded"));
    expect(deliveries.map((event) => z.object({ issue: z.object({ key: z.string() }) }).parse(event.data).issue.key)).toEqual(["TEST-1", "TEST-2"]);
    reject = false;
    await vi.advanceTimersByTimeAsync(60_000);
    await waitFor(() => expect(fixture.health.at(-1)?.status).toBe("ready"));
    expect(deliveries).toHaveLength(3);
    expect(deliveries[2]?.id).toBe(deliveries[1]?.id);
  });

  it("keeps workflow and repository subscriptions distinct while serializing the same issue", async () => {
    const http = await server();
    http.setItems([issue(1)]);
    clock();
    const fixture = await setup({ baseUrl: http.baseUrl, token: "test-secret" });
    const one = subscription("one.md");
    const two = { ...subscription("two.md"), repository: "owner/repo" };
    await fixture.start([one, two]);
    await vi.advanceTimersByTimeAsync(60_000);
    await waitFor(() => expect(fixture.events).toHaveLength(2));
    const [first, second] = fixture.events;
    if (!first || !second) throw new Error("Missing ticket events");
    expect(first.id).not.toBe(second.id);
    expect(await fixture.source.match?.(first, one.config, { signal: new AbortController().signal, workflowId: "one.md" })).toBe(true);
    expect(await fixture.source.match?.(first, two.config, { signal: new AbortController().signal, workflowId: "two.md" })).toBe(false);
    expect(fixture.source.resourceKey?.(first)).toBe(fixture.source.resourceKey?.(second));
    expect(fixture.source.resourceKey?.(first)).toMatch(/^jira:[a-f0-9]+:1$/);
    expect([first.repository, second.repository]).toEqual([undefined, "owner/repo"]);
  });

  it("refreshes eligibility and fields before execution and skips changed or removed tickets", async () => {
    const http = await server();
    http.setItems([issue(1)]);
    clock();
    const fixture = await setup({ baseUrl: http.baseUrl, token: "test-secret" });
    const sub = subscription("refine.md", 'summary ~ "order by" ORDER BY key ASC');
    await fixture.start([sub]);
    await vi.advanceTimersByTimeAsync(60_000);
    await waitFor(() => expect(fixture.events).toHaveLength(1));
    await fixture.source.stop?.();
    const event = fixture.events[0];
    if (!event) throw new Error("Missing event");
    const operation = { signal: new AbortController().signal, workflowId: sub.workflowId, workflow: definition(sub) };
    const activation = await fixture.source.activate?.(event, operation);
    expect(activation).toMatchObject({ data: {
      issue: { id: "1", key: "TEST-1", fields: issue(1).fields, url: `${http.baseUrl}/browse/TEST-1` }, names: { summary: "Summary" },
    } });
    expect(await fixture.source.match?.({ ...event, data: activation?.data }, sub.config, operation)).toBe(true);
    expect(http.requests.at(-1)?.jql).toBe('(summary ~ "order by") AND key = "TEST-1" ORDER BY key ASC');
    http.setItems([issue(1, "2026-01-01T00:01:00Z")]);
    expect(await fixture.source.activate?.(event, operation)).toEqual({ decision: { kind: "skip", reason: "jira_issue_changed_since_discovery" } });
    http.setItems([]);
    expect(await fixture.source.activate?.(event, operation)).toEqual({ decision: { kind: "skip", reason: "jira_issue_no_longer_eligible" } });
  });

  it("reports sanitized authentication and malformed-response failures, then recovers", async () => {
    const http = await server();
    http.setStatus(401);
    clock();
    const fixture = await setup({ baseUrl: http.baseUrl, token: "test-secret" });
    await fixture.start();
    await vi.advanceTimersByTimeAsync(60_000);
    await waitFor(() => expect(fixture.health.at(-1)?.reason).toContain("HTTP 401"));
    expect(fixture.events).toEqual([]);
    expect(JSON.stringify(fixture.health)).not.toContain("test-secret");
    http.setStatus(200);
    http.setMalformed(true);
    await vi.advanceTimersByTimeAsync(60_000);
    await waitFor(() => expect(fixture.health.at(-1)?.reason).toContain("invalid response"));
    http.setMalformed(false);
    await vi.advanceTimersByTimeAsync(60_000);
    await waitFor(() => expect(fixture.events).toHaveLength(3));
  });

  it("is idle without credentials until subscribed, and validates timezone and paired configuration", async () => {
    const fixture = await setup({});
    await fixture.start([]);
    expect(() => fixture.start()).toThrow("Jira subscriptions require");
    expect(fixture.source.configSchema?.safeParse({ cron: "0 9 * * *", timezone: "Europe/Madrid", jql: "project = TEST" }).success).toBe(true);
    expect(fixture.source.configSchema?.safeParse({ cron: "0 9 * * *", timezone: "Invalid/Zone", jql: "project = TEST" }).success).toBe(false);
    expect(configSchema.safeParse({ baseUrl: "https://jira.example.test/jira" }).success).toBe(false);
    expect(configSchema.safeParse({ baseUrl: "https://jira.example.test/jira", token: "secret" }).success).toBe(true);
    expect(configSchema.safeParse({ baseUrl: "https://user:password@jira.example.test", token: "secret" }).success).toBe(false);
  });

  it("cancels a hanging request when stopped", async () => {
    const http = await server();
    http.setHanging(true);
    clock();
    const fixture = await setup({ baseUrl: http.baseUrl, token: "test-secret" });
    await fixture.start();
    await vi.advanceTimersByTimeAsync(60_000);
    await fixture.source.stop?.();
    expect(fixture.events).toEqual([]);
    http.setHanging(false);
    await fixture.start();
    await vi.advanceTimersByTimeAsync(0);
    await waitFor(() => expect(fixture.events).toHaveLength(3));
  });

  it("performs one overdue scan after downtime and responds to subscription removal", async () => {
    const http = await server();
    http.setItems([issue(1)]);
    clock();
    const fixture = await setup({ baseUrl: http.baseUrl, token: "test-secret" });
    await fixture.start();
    await vi.advanceTimersByTimeAsync(60_000);
    await waitFor(() => expect(fixture.events).toHaveLength(1));
    await fixture.source.stop?.();
    vi.setSystemTime(new Date("2026-01-01T00:10:00Z"));
    http.setItems([issue(1), issue(2)]);
    await fixture.start();
    await vi.advanceTimersByTimeAsync(0);
    await waitFor(() => expect(fixture.events).toHaveLength(2));
    await waitFor(() => expect(fixture.health.at(-1)?.status).toBe("ready"));
    expect(http.requests).toHaveLength(2);
    await fixture.source.updateSubscriptions?.("jira.issue", []);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(http.requests).toHaveLength(2);
    expect(fixture.events.map((event) => z.object({ issue: z.object({ key: z.string() }) }).parse(event.data).issue.key)).toEqual(["TEST-1", "TEST-2"]);
  });
});

describe("Jira HTTP client", () => {
  it("uses real HTTP and preserves the Jira context path", async () => {
    const http = await server();
    const parsed = configSchema.parse({ baseUrl: `${http.baseUrl}/`, token: "test-secret" });
    if (!("baseUrl" in parsed)) throw new Error("Missing connection");
    const client = new JiraClient(parsed);
    const page = await client.search({ jql: "project = TEST", fields: ["summary", "updated"] });
    expect(page.issues.map((item) => item.key)).toEqual(["TEST-1", "TEST-2"]);
    expect(client.browseUrl("TEST-1")).toBe(`${http.baseUrl}/browse/TEST-1`);
  });

  it("rejects redirects and bounds hanging requests without exposing response bodies", async () => {
    const http = await server();
    const parsed = configSchema.parse({ baseUrl: http.baseUrl, token: "test-secret", requestTimeoutMs: 50 });
    if (!("baseUrl" in parsed)) throw new Error("Missing connection");
    const client = new JiraClient(parsed);
    http.setStatus(302);
    await expect(client.search({ jql: "project = TEST", fields: ["summary", "updated"] })).rejects.toThrow("Jira request failed, timed out, or redirected");
    http.setStatus(200);
    http.setHanging(true);
    await expect(client.search({ jql: "project = TEST", fields: ["summary", "updated"] })).rejects.toThrow("Jira request failed, timed out, or redirected");
    http.setHanging(false);
    const page = await client.search({ jql: "project = TEST", fields: ["summary", "updated"] });
    expect(page.issues.map((item) => item.key)).toEqual(["TEST-1", "TEST-2"]);
  });
});
