import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { Runtime, resolvePaths, ensureHome } from "@roboplane/core";
import scratch from "@roboplane/extension-scratch";
import container from "@roboplane/extension-container";
import { webhookRequestSchema, z, type Extension, type InputResult } from "@mixer/automations-sdk";
import webhooks from "./index.js";

const runtimes: Runtime[] = [];
const homes: string[] = [];
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.stop();
  for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true });
  delete process.env.MIXER_AUTOMATIONS_TEST_WEBHOOK_SECRET;
});

async function fixture(options: { definition?: string; listener?: boolean; port?: number; extra?: Extension; workflow?: string; enabled?: boolean; timeoutMs?: number; maxRequests?: number } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "rp-wh-"));
  homes.push(home);
  const paths = resolvePaths(home);
  ensureHome(paths);
  fs.writeFileSync(paths.config, JSON.stringify({ extensions: { webhooks: {
    enabled: options.enabled ?? true, listener: { enabled: options.listener ?? true, port: options.port ?? 0 }, timeoutMs: options.timeoutMs ?? 1000, maxRequests: options.maxRequests ?? 32, maxBodyBytes: 1024,
  } } }));
  if (options.definition !== undefined) {
    fs.mkdirSync(path.join(home, "webhooks"));
    fs.writeFileSync(path.join(home, "webhooks", "alerts.yaml"), options.definition);
  }
  if (options.workflow) fs.writeFileSync(path.join(paths.workflows, "react.md"), options.workflow);
  const agent: Extension = { name: "test-agent", setup(api) {
    api.agents.register("test-agent", { run: () => ({ version: 1, outcome: "no-op", reason: "test" }) });
  } };
  const runtime = new Runtime({ home, builtins: [{ extension: webhooks }, { extension: scratch }, { extension: container }, { extension: agent }, ...(options.extra ? [{ extension: options.extra }] : [])] });
  runtimes.push(runtime);
  await runtime.initialize();
  await runtime.start();
  return runtime;
}
const definition = "handler: webhook.json\nauth:\n  type: bearer\n  secretEnv: MIXER_AUTOMATIONS_TEST_WEBHOOK_SECRET\n";
async function list(runtime: Runtime) {
  const result = await runtime.submitInput("webhooks.control", { command: "list" });
  if (result.kind !== "response") throw new Error("Expected list response");
  return z.object({ listener: z.object({ port: z.number() }).passthrough().nullable(), error: z.string().nullable(),
    endpoints: z.array(z.object({ name: z.string(), handler: z.string(), http: z.boolean() }).passthrough()) }).parse(JSON.parse(result.body));
}
async function url(runtime: Runtime) {
  const port = (await list(runtime)).listener?.port;
  if (!port) throw new Error("Listener did not start");
  return `http://127.0.0.1:${port}/webhooks/alerts`;
}
function post(address: string, body: string, headers: Record<string, string> = {}) {
  return fetch(address, { method: "POST", body, headers });
}
function emitted(result: InputResult) {
  if (result.kind !== "event") throw new Error(`Expected event, got ${result.kind}`);
  return result.result;
}

describe("optional webhook host", () => {
  it("opens no listener when definitions are absent or disabled", async () => {
    const absent = await fixture();
    expect(await list(absent)).toEqual({ listener: null, error: null, endpoints: [] });
    const disabled = await fixture({ definition: "enabled: false\nhandler: webhook.json\n" });
    expect(await list(disabled)).toEqual({ listener: null, error: null, endpoints: [] });
  });

  it("supports local CLI-style delivery with HTTP disabled and no secret configured", async () => {
    const runtime = await fixture({ definition, listener: false });
    expect((await list(runtime)).listener).toBeNull();
    const input = { command: "emit", endpoint: "alerts", deliveryId: "local-1", data: { status: "failed" } };
    const accepted = emitted(await runtime.submitInput("webhooks.control", input));
    expect(accepted).toMatchObject({ status: "accepted", runIds: [] });
    expect(emitted(await runtime.submitInput("webhooks.control", input))).toMatchObject({ status: "duplicate", eventId: accepted.eventId });
    expect(runtime.database.getEvent(accepted.eventId)).toMatchObject({ source: "webhooks", type: "webhook.received", data: { endpoint: "alerts", payload: { status: "failed" } } });
  });

  it("starts no listener for http:false endpoints", async () => {
    const runtime = await fixture({ definition: definition + "http: false\n" });
    expect((await list(runtime)).listener).toBeNull();
  });

  it("can disable the bundled extension completely", async () => {
    const runtime = await fixture({ definition, enabled: false });
    await expect(runtime.submitInput("webhooks.control", { command: "list" })).rejects.toThrow("unavailable");
    expect(runtime.registry.eventSources.has("webhook.received")).toBe(false);
  });

  it("authenticates, validates, admits durably, filters, and records sanitized diagnostics", async () => {
    process.env.MIXER_AUTOMATIONS_TEST_WEBHOOK_SECRET = "test-secret";
    const runtime = await fixture({ definition, workflow: "---\nagent: test-agent\non:\n  webhook.received:\n    endpoints: [alerts]\n    payload:\n      build.status: [failed]\n---\nReact.\n" });
    expect(runtime.workflowErrors).toEqual([]);
    const address = await url(runtime);
    expect((await post(address, "{}", { "x-delivery-id": "bad-auth" })).status).toBe(401);
    const auth = { authorization: "Bearer test-secret", "x-delivery-id": "delivery-1" };
    expect((await post(address, "{" , auth)).status).toBe(400);
    expect((await post(address, "{}", { authorization: "Bearer test-secret" })).status).toBe(400);
    expect((await post(address, "x".repeat(1025), auth)).status).toBe(413);
    const ignored = await post(address, '{"build":{"status":"passed"}}', { ...auth, "x-delivery-id": "delivery-0" });
    expect(ignored.status).toBe(202);
    expect(await ignored.json()).toMatchObject({ kind: "event", result: { status: "accepted", runIds: [] } });
    const response = await post(address, '{"build":{"status":"failed"}}', auth);
    expect(response.status).toBe(202);
    const result = z.object({ kind: z.literal("event"), result: z.object({ eventId: z.string(), runIds: z.array(z.string()) }) }).parse(await response.json());
    expect(result.result.runIds).toHaveLength(1);
    expect(runtime.database.getEvent(result.result.eventId)).toMatchObject({ data: { payload: { build: { status: "failed" } } } });
    expect(await (await post(address, '{"build":{"status":"failed"}}', auth)).json()).toMatchObject({ result: { status: "duplicate" } });
    await runtime.idle();
    expect(runtime.database.getRun(result.result.runIds[0]!)?.status).toBe("completed");
    const deliveries = await runtime.submitInput("webhooks.control", { command: "deliveries" });
    expect(JSON.stringify(deliveries)).not.toContain("test-secret");
    expect(JSON.stringify(deliveries)).not.toContain('build');
  });

  it("fails closed on malformed reload while unrelated manual workflows still run", async () => {
    const runtime = await fixture({ definition, listener: false, workflow: "---\nagent: test-agent\non: {}\n---\nManual.\n" });
    fs.writeFileSync(path.join(runtime.paths.home, "webhooks", "alerts.yaml"), "handler: webhook.json\nhandler: duplicate\n");
    await expect(runtime.submitInput("webhooks.control", { command: "reload" })).rejects.toThrow("configuration");
    expect(await list(runtime)).toEqual({ listener: null, error: "configuration_or_listener_failed", endpoints: [] });
    const run = runtime.runManual("react");
    await runtime.idle();
    expect(runtime.database.getRun(run.id)?.status).toBe("completed");
  });

  it("hosts an SDK-only custom provider with raw-body HMAC and provider-owned events", async () => {
    const provider: Extension = { name: "custom", setup(api) {
      api.events.registerSource("custom.alert", { start() {}, match: () => true });
      api.inputs.register("custom.signed", {
        configSchema: z.object({ secretEnv: z.string() }).strict(), eventTypes: ["custom.alert"],
        async receive(input, configuration, context) {
          const request = webhookRequestSchema.parse(input);
          const config = z.object({ secretEnv: z.string() }).parse(configuration);
          const signature = createHmac("sha256", process.env[config.secretEnv] ?? "").update(request.body).digest("hex");
          if (signature !== request.headers.signature) return { kind: "rejected", status: 401, reason: "signature_failed" };
          return { kind: "event", result: await context.emit({ id: "custom:1", type: "custom.alert", timestamp: new Date().toISOString(), data: { original: Buffer.from(request.body).toString() } }) };
        },
      });
    } };
    process.env.MIXER_AUTOMATIONS_TEST_WEBHOOK_SECRET = "provider-secret";
    const runtime = await fixture({ definition: "handler: custom.signed\nsecretEnv: MIXER_AUTOMATIONS_TEST_WEBHOOK_SECRET\n", extra: provider });
    fs.writeFileSync(path.join(runtime.paths.home, "webhooks", "generic.yaml"), definition);
    await runtime.submitInput("webhooks.control", { command: "reload" });
    const address = await url(runtime);
    const body = "not JSON\n";
    const signature = createHmac("sha256", "provider-secret").update(body).digest("hex");
    const response = await post(address, body, { signature });
    expect(response.status).toBe(202);
    expect(runtime.database.getEvent("custom:1")).toMatchObject({ type: "custom.alert", source: "custom", data: { original: body } });
    const generic = await post(address.replace("/webhooks/alerts", "/webhooks/generic"), '{"status":"failed"}', {
      authorization: "Bearer provider-secret", "x-delivery-id": "generic-1",
    });
    expect(generic.status).toBe(202);
    expect(await generic.json()).toMatchObject({ kind: "event", result: { status: "accepted" } });
    expect((await list(runtime)).endpoints.map((endpoint) => endpoint.handler)).toEqual(["custom.signed", "webhook.json"]);
  });

  it("times out uncooperative providers, retains their capacity slot, and prevents late admission", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const provider: Extension = { name: "slow", setup(api) {
      api.events.registerSource("slow.event", { start() {} });
      api.inputs.register("slow.input", { configSchema: z.object({}).strict(), eventTypes: ["slow.event"],
        async receive(_input, _config, context) {
          await gate;
          return { kind: "event", result: await context.emit({ id: "too-late", type: "slow.event", timestamp: new Date().toISOString(), data: {} }) };
        },
      });
    } };
    const runtime = await fixture({ definition: "handler: slow.input\nhttp: false\n", extra: provider, timeoutMs: 20, maxRequests: 1 });
    const input = { command: "emit", endpoint: "alerts", deliveryId: "one", data: {} };
    try {
      expect(await runtime.submitInput("webhooks.control", input)).toEqual({ kind: "rejected", status: 503, reason: "delivery_aborted" });
      expect(await runtime.submitInput("webhooks.control", input)).toEqual({ kind: "rejected", status: 503, reason: "request_capacity" });
    } finally { release(); }
    await new Promise((resolve) => setImmediate(resolve));
    expect(runtime.database.getEvent("too-late")).toBeUndefined();
  });

  it("rejects duplicate endpoint names and unknown handlers without breaking the runtime", async () => {
    const runtime = await fixture({ definition, listener: false });
    fs.writeFileSync(path.join(runtime.paths.home, "webhooks", "alerts.yml"), definition);
    await expect(runtime.submitInput("webhooks.control", { command: "reload" })).rejects.toThrow();
    expect((await list(runtime)).endpoints).toEqual([]);
    fs.unlinkSync(path.join(runtime.paths.home, "webhooks", "alerts.yml"));
    fs.writeFileSync(path.join(runtime.paths.home, "webhooks", "alerts.yaml"), "handler: missing.input\n");
    await expect(runtime.submitInput("webhooks.control", { command: "reload" })).rejects.toThrow();
    expect((await list(runtime)).listener).toBeNull();
    fs.writeFileSync(path.join(runtime.paths.home, "webhooks", "alerts.yaml"), definition);
    const reloads = await Promise.all([runtime.submitInput("webhooks.control", { command: "reload" }), runtime.submitInput("webhooks.control", { command: "reload" })]);
    expect(reloads.map((result) => result.kind)).toEqual(["response", "response"]);
    expect((await list(runtime)).endpoints).toHaveLength(1);
  });

  it("reports bind failures without stopping manual execution", async () => {
    const occupied = http.createServer();
    await new Promise<void>((resolve) => occupied.listen(0, "127.0.0.1", resolve));
    const address = occupied.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");
    try {
      const runtime = await fixture({ definition, port: address.port, workflow: "---\nagent: test-agent\non: {}\n---\nManual.\n" });
      expect(await list(runtime)).toEqual({ listener: null, error: "listener_address_in_use", endpoints: [] });
      expect(runtime.database.getSourceHealth("webhook.received")?.status).toBe("unavailable");
      const run = runtime.runManual("react");
      await runtime.idle();
      expect(runtime.database.getRun(run.id)?.status).toBe("completed");
    } finally { await new Promise<void>((resolve) => occupied.close(() => resolve())); }
  });
});
