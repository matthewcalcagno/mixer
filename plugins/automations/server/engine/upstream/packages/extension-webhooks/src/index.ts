import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import { parseDocument } from "yaml";
import { defineExtension, webhookRequestSchema, z, type WebhookRequest, type InputResult, type JsonValue, type OperationContext, type MixerAutomationsAPI } from "@mixer/automations-sdk";

const settingsSchema = z.object({
  enabled: z.boolean().optional(),
  listener: z.object({ enabled: z.boolean().default(true), host: z.string().default("127.0.0.1"),
    port: z.number().int().min(0).max(65535).default(8787) }).strict().default({ enabled: true, host: "127.0.0.1", port: 8787 }),
  maxBodyBytes: z.number().int().min(1).max(10 * 1024 * 1024).default(1024 * 1024),
  timeoutMs: z.number().int().min(10).max(120_000).default(15_000),
  maxRequests: z.number().int().min(1).max(1000).default(32),
}).strict();
const definitionSchema = z.object({
  handler: z.string().min(1), enabled: z.boolean().default(true), http: z.boolean().default(true),
  path: z.string().regex(/^\/[a-zA-Z0-9_./-]+$/).optional(),
}).passthrough();
const scalarSchema = z.union([z.string(), z.number().finite(), z.boolean(), z.null()]);
export const webhookTriggerSchema = z.object({
  endpoints: z.array(z.string().min(1)).min(1).max(100).optional(),
  payload: z.record(z.string().max(200), z.array(scalarSchema).min(1).max(32)).refine((value) => Object.keys(value).length <= 64).optional(),
}).strict();
const jsonConfigSchema = z.object({
  auth: z.object({ type: z.literal("bearer"), secretEnv: z.string().min(1) }).strict(),
  deliveryIdHeader: z.string().regex(/^[a-zA-Z0-9-]+$/).default("X-Delivery-ID"),
}).strict();
const localCommandSchema = z.discriminatedUnion("command", [
  z.object({ command: z.literal("list") }).strict(),
  z.object({ command: z.literal("reload") }).strict(),
  z.object({ command: z.literal("deliveries") }).strict(),
  z.object({ command: z.literal("emit"), endpoint: z.string().min(1), deliveryId: z.string().min(1).max(512), data: z.json() }).strict(),
]);

interface Endpoint { name: string; handler: string; path: string; http: boolean; config: unknown }

function files(directory: string): string[] {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? files(file) : entry.isFile() && /\.ya?ml$/.test(entry.name) ? [file] : [];
  }).sort();
}

function definitions(api: MixerAutomationsAPI): Map<string, Endpoint> {
  const root = path.join(api.paths.home, "webhooks");
  const endpoints = new Map<string, Endpoint>();
  const paths = new Set<string>();
  for (const file of files(root)) {
    if (fs.statSync(file).size > 1024 * 1024) throw new Error("Webhook definition exceeds 1 MiB");
    const document = parseDocument(fs.readFileSync(file, "utf8"), { version: "1.2", uniqueKeys: true, merge: false });
    if (document.errors.length || document.warnings.length) throw new Error(`Invalid webhook YAML: ${path.relative(root, file)}`);
    if (document.directives?.yaml.version !== "1.2") throw new Error("Webhook YAML must use version 1.2");
    const value: unknown = document.toJS({ maxAliasCount: 10 });
    z.json().parse(value);
    const { handler, enabled, http: useHttp, path: customPath, ...config } = definitionSchema.parse(value);
    const name = path.relative(root, file).split(path.sep).join("/").replace(/\.ya?ml$/, "");
    if (!/^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$/.test(name)) throw new Error(`Invalid webhook name: ${name}`);
    if (endpoints.has(name)) throw new Error(`Duplicate webhook name: ${name}`);
    if (!enabled) continue;
    const route = customPath ?? `/webhooks/${name}`;
    if (route.includes("//") || route.split("/").some((part) => part === "." || part === "..")) throw new Error(`Invalid webhook path: ${name}`);
    if (paths.has(route)) throw new Error(`Duplicate webhook path: ${route}`);
    api.inputs.validate(handler, config);
    paths.add(route);
    endpoints.set(name, { name, handler, path: route, http: useHttp, config });
  }
  return endpoints;
}

function atPath(value: JsonValue, field: string): JsonValue | undefined {
  const parts = field.split(".");
  if (parts.length > 10 || parts.some((part) => !part || ["__proto__", "constructor", "prototype"].includes(part))) return undefined;
  let current: JsonValue | undefined = value;
  for (const part of parts) {
    if (!current || typeof current !== "object" || Array.isArray(current) || !Object.hasOwn(current, part)) return undefined;
    current = current[part];
  }
  return current;
}

function statusOf(result: InputResult): number {
  if (result.kind === "rejected" || result.kind === "response") return result.status;
  return result.kind === "event" && result.result.status === "rejected" ? 503 : 202;
}

export default defineExtension({
  name: "webhooks",
  setup(api) {
    const settings = settingsSchema.parse(api.config.get() ?? {});
    const state = api.state.namespace();
    let endpoints = new Map<string, Endpoint>();
    let server: http.Server | undefined;
    let started = false;
    let active = 0;
    let lifecycle = new AbortController();
    let failure: string | undefined;
    let sequence = 0;
    let reloading: Promise<void> | undefined;

    api.events.registerSource("webhook.received", {
      configSchema: webhookTriggerSchema,
      async start() { if (started && !failure) return; started = true; await reload(); },
      async stop() {
        started = false;
        lifecycle.abort(new Error("Webhook host stopped"));
        await reloading?.catch(() => {});
        endpoints = new Map();
        await close();
      },
      health() { return { version: 1, status: failure ? "unhealthy" : "ready", observedAt: new Date().toISOString(), reason: failure }; },
      match(event, config) {
        const trigger = webhookTriggerSchema.parse(config);
        const data = z.object({ endpoint: z.string(), payload: z.json() }).parse(event.data);
        return (!trigger.endpoints || trigger.endpoints.includes(data.endpoint))
          && Object.entries(trigger.payload ?? {}).every(([field, expected]) => {
            const actual = atPath(data.payload, field);
            return actual !== undefined && expected.some((value) => value === actual);
          });
      },
    });

    api.inputs.register("webhook.json", {
      configSchema: jsonConfigSchema, eventTypes: ["webhook.received"],
      async receive(input, configuration, context) {
        const request = webhookRequestSchema.parse(input);
        const config = jsonConfigSchema.parse(configuration);
        if (!request.local) {
          const secret = process.env[config.auth.secretEnv];
          if (!secret) return { kind: "rejected", status: 503, reason: "secret_unavailable" };
          const received = Buffer.from(request.headers.authorization ?? "");
          const expected = Buffer.from(`Bearer ${secret}`);
          if (received.length !== expected.length || !timingSafeEqual(received, expected)) return { kind: "rejected", status: 401, reason: "authentication_failed" };
        }
        const deliveryId = request.headers[config.deliveryIdHeader.toLowerCase()];
        if (!deliveryId || deliveryId.length > 512) return { kind: "rejected", status: 400, reason: "delivery_id_required" };
        let payload: JsonValue;
        try { payload = z.json().parse(JSON.parse(Buffer.from(request.body).toString("utf8"))); }
        catch { return { kind: "rejected", status: 400, reason: "invalid_json" }; }
        const key = createHash("sha256").update(JSON.stringify([request.endpoint, deliveryId])).digest("hex");
        return { kind: "event", result: await context.emit({
          id: `webhook:${key}`, type: "webhook.received", timestamp: new Date().toISOString(),
          data: { endpoint: request.endpoint, payload },
        }) };
      },
    });

    const record = (endpoint: string, status: number, reason: string) => {
      const key = `delivery:${Date.now()}:${String(sequence++).padStart(12, "0")}`;
      state.set(key, { endpoint, status, reason, timestamp: new Date().toISOString() });
      const entries = state.entries("delivery:").sort((a, b) => a.key.localeCompare(b.key));
      for (const entry of entries.slice(0, Math.max(0, entries.length - 100))) state.delete(entry.key);
    };

    const deliver = async (endpoint: Endpoint, request: WebhookRequest, operation: OperationContext): Promise<InputResult> => {
      if (active >= settings.maxRequests) { record(endpoint.name, 503, "request_capacity"); return { kind: "rejected", status: 503, reason: "request_capacity" }; }
      if (request.body.byteLength > settings.maxBodyBytes) { record(endpoint.name, 413, "body_too_large"); return { kind: "rejected", status: 413, reason: "body_too_large" }; }
      active++;
      const controller = new AbortController();
      const signal = AbortSignal.any([operation.signal, lifecycle.signal, controller.signal]);
      const timer = setTimeout(() => controller.abort(new Error("Webhook deadline exceeded")), settings.timeoutMs);
      let submitted: Promise<InputResult> | undefined;
      try {
        // Enforce the response deadline even when a trusted provider ignores its signal.
        const result = await new Promise<InputResult>((resolve, reject) => {
          const aborted = () => reject(signal.reason);
          signal.addEventListener("abort", aborted, { once: true });
          if (signal.aborted) aborted();
          else {
            submitted = api.inputs.submit(endpoint.handler, request, endpoint.config, {
              signal, deadline: new Date(Date.now() + settings.timeoutMs).toISOString(),
            });
            void submitted.then(resolve, reject).finally(() => signal.removeEventListener("abort", aborted));
          }
        });
        record(endpoint.name, statusOf(result), result.kind === "event" ? result.result.status : result.kind === "response" ? "response" : result.reason);
        return result;
      } catch {
        const reason = signal.aborted ? "delivery_aborted" : "handler_failed";
        record(endpoint.name, 503, reason);
        return { kind: "rejected", status: 503, reason };
      } finally {
        clearTimeout(timer);
        // A provider that ignores cancellation still occupies its bounded slot.
        if (submitted) void submitted.then(() => { active--; }, () => { active--; });
        else active--;
      }
    };

    const close = async () => {
      lifecycle.abort(new Error("Webhook host stopped"));
      const previous = server;
      server = undefined;
      if (previous) {
        previous.closeAllConnections();
        await new Promise<void>((resolve) => previous.close(() => resolve()));
      }
    };

    const listen = async () => {
      if (server || !settings.listener.enabled || ![...endpoints.values()].some((endpoint) => endpoint.http)) return;
      const generation = lifecycle.signal;
      const listener = http.createServer({ maxHeaderSize: 16 * 1024 }, (request, response) => {
        const endpoint = [...endpoints.values()].find((item) => item.http && item.path === request.url?.split("?")[0]);
        const reply = (status: number, body: string, contentType = "application/json") => {
          if (response.destroyed || response.writableEnded) return;
          response.writeHead(status, { "content-type": contentType, "connection": "close" }); response.end(body);
        };
        if (!endpoint) { reply(404, '{"reason":"endpoint_not_found"}'); request.resume(); return; }
        if (request.method !== "POST") { record(endpoint.name, 405, "method_not_allowed"); reply(405, '{"reason":"method_not_allowed"}'); request.resume(); return; }
        if (active >= settings.maxRequests) { record(endpoint.name, 503, "request_capacity"); reply(503, '{"reason":"request_capacity"}'); request.resume(); return; }
        const chunks: Buffer[] = [];
        let size = 0;
        let oversized = false;
        const controller = new AbortController();
        response.once("close", () => { if (!response.writableEnded) controller.abort(new Error("Client disconnected")); });
        request.setTimeout(settings.timeoutMs, () => { controller.abort(); reply(408, '{"reason":"request_timeout"}'); request.destroy(); });
        request.on("error", () => controller.abort());
        request.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > settings.maxBodyBytes && !oversized) { oversized = true; chunks.length = 0; record(endpoint.name, 413, "body_too_large"); reply(413, '{"reason":"body_too_large"}'); }
          else if (!oversized) chunks.push(chunk);
        });
        request.on("end", () => {
          if (oversized) return;
          const headers: Record<string, string> = {};
          for (const [name, value] of Object.entries(request.headers)) if (typeof value === "string") headers[name] = value;
          void deliver(endpoint, { endpoint: endpoint.name, headers, body: Buffer.concat(chunks), local: false }, { signal: AbortSignal.any([controller.signal, generation]) })
            .then((result) => reply(statusOf(result), result.kind === "response" ? result.body : JSON.stringify(result),
              result.kind === "response" ? result.contentType ?? "text/plain" : "application/json"));
        });
      });
      listener.requestTimeout = settings.timeoutMs;
      listener.headersTimeout = settings.timeoutMs;
      listener.maxConnections = settings.maxRequests;
      try {
        await new Promise<void>((resolve, reject) => {
          listener.once("error", reject);
          listener.listen(settings.listener.port, settings.listener.host, () => { listener.removeListener("error", reject); resolve(); });
        });
        if (generation.aborted || !started) {
          listener.closeAllConnections();
          await new Promise<void>((resolve) => listener.close(() => resolve()));
          return;
        }
        server = listener;
        listener.on("error", () => { failure = "listener_failed"; api.logger.error({ reason: failure }, "Webhook listener failed"); });
      } catch (error) {
        listener.close();
        throw error;
      }
    };

    const performReload = async () => {
      // Remove previous routes first: deleted secrets and invalid replacements fail closed.
      endpoints = new Map();
      await close();
      lifecycle = new AbortController();
      try {
        endpoints = definitions(api);
        if (started) await listen();
        failure = undefined;
      } catch (error) {
        endpoints = new Map();
        failure = error instanceof Error && "code" in error && error.code === "EADDRINUSE"
          ? "listener_address_in_use" : "configuration_or_listener_failed";
        api.logger.error({ reason: failure }, "Webhook configuration failed; routes disabled");
        throw new Error(`Webhook configuration or listener failed: ${failure}`);
      }
    };

    const reload = async () => {
      if (reloading) return reloading;
      reloading = Promise.resolve().then(performReload);
      try { await reloading; }
      finally { reloading = undefined; }
    };

    api.inputs.register("webhooks.control", {
      configSchema: z.object({}).strict(), eventTypes: [],
      async receive(input, _config, context) {
        const command = localCommandSchema.parse(input);
        if (command.command === "reload") await reload();
        if (command.command === "emit") {
          const endpoint = endpoints.get(command.endpoint);
          if (!endpoint) return { kind: "rejected", status: 404, reason: "endpoint_not_found" };
          const config = endpoint.handler === "webhook.json" ? jsonConfigSchema.parse(endpoint.config) : undefined;
          return deliver(endpoint, { endpoint: endpoint.name, body: Buffer.from(JSON.stringify(command.data)), local: true,
            headers: { [config?.deliveryIdHeader.toLowerCase() ?? "x-delivery-id"]: command.deliveryId } }, context);
        }
        const body = command.command === "deliveries" ? state.entries("delivery:").map((entry) => entry.value)
          : { listener: server?.address() ?? null, error: failure ?? null,
            endpoints: [...endpoints.values()].map(({ name, handler, path: route, http: useHttp }) => ({ name, handler, path: route, http: useHttp })) };
        return { kind: "response", status: 200, body: JSON.stringify(body), contentType: "application/json" };
      },
    });

  },
});
