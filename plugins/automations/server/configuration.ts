import { execFile } from "node:child_process";
import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { PluginSettings } from "@mixer/plugin/server";
import { z } from "zod";
import { automationSettings } from "../shared/contracts.js";
import { connectionSchema } from "./jira.js";
import { stepsEnvironmentSchema } from "./steps-schema.js";
import { valueAt } from "./github-facts.js";

const exec = promisify(execFile);
const DAY = 86_400_000;
const duration = z.string().regex(/^[1-9]\d*(?:ms|s|m|h|d|w)$/);
const apiUrl = z
  .url()
  .pipe(
    z.string().refine((value) => {
      const url = new URL(value);
      return (
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash &&
        (url.protocol === "https:" ||
          (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
      );
    }, "Use HTTPS without credentials, query, or fragment; HTTP is allowed only on loopback."),
  )
  .transform((value) => new URL(value).toString().replace(/\/+$/, ""));
const secret = z
  .string()
  .min(1)
  .refine(
    (value) => !value.includes("\r") && !value.includes("\n") && !value.includes("\0"),
    "Secrets cannot contain control characters.",
  );
const agent = z
  .object({ enabled: z.boolean().default(true), env: stepsEnvironmentSchema.default({}) })
  .strict()
  .optional();
export const automationConfigSchema = z
  .object({
    runtime: z
      .object({
        concurrency: z.number().int().min(1).max(32).default(1),
        maxAttempts: z.literal(1).default(1),
        maxQueuedRuns: z.number().int().min(1).max(100_000).default(1000),
        timeout: z.number().int().min(1).max(86_400_000).default(3_600_000),
        noOutputTimeout: z.number().int().min(1).max(3_600_000).default(600_000),
      })
      .strict()
      .default({
        concurrency: 1,
        maxAttempts: 1,
        maxQueuedRuns: 1000,
        timeout: 3_600_000,
        noOutputTimeout: 600_000,
      }),
    history: z
      .object({ retention: duration.default("7d") })
      .strict()
      .default({ retention: "7d" }),
    extensions: z
      .object({
        github: z
          .object({
            enabled: z.boolean().default(true),
            token: secret.optional(),
            actionToken: secret.optional(),
            apiUrl: apiUrl.default("https://api.github.com"),
            polling: z.boolean().default(true),
            pollInterval: duration.default("1m"),
            maxPages: z.number().int().min(1).max(100).default(3),
            failureReports: z
              .object({ enabled: z.literal(false) })
              .strict()
              .optional(),
          })
          .strict()
          .default({
            enabled: true,
            apiUrl: "https://api.github.com",
            polling: true,
            pollInterval: "1m",
            maxPages: 3,
          }),
        jira: z
          .object({
            enabled: z.boolean().default(true),
            baseUrl: apiUrl.optional(),
            token: secret.optional(),
            pageSize: z.number().int().min(1).max(1000).default(50),
            requestTimeoutMs: z.number().int().min(1).max(300_000).default(30_000),
          })
          .strict()
          .default({ enabled: true, pageSize: 50, requestTimeoutMs: 30_000 }),
        steps: z
          .object({ enabled: z.boolean().default(true), env: stepsEnvironmentSchema.default({}) })
          .strict()
          .default({ enabled: true, env: {} }),
        scheduler: z
          .object({ enabled: z.boolean().default(true) })
          .strict()
          .default({ enabled: true }),
        webhooks: z
          .object({
            enabled: z.boolean().default(true),
            githubSecret: secret.optional(),
            secret: secret.optional(),
            listener: z
              .object({
                enabled: z.boolean().default(true),
                host: z.literal("127.0.0.1").default("127.0.0.1"),
                port: z.number().int().min(0).max(65535).default(0),
              })
              .strict()
              .default({ enabled: true, host: "127.0.0.1", port: 0 }),
          })
          .strict()
          .default({ enabled: true, listener: { enabled: true, host: "127.0.0.1", port: 0 } }),
        mixer: z
          .object({ agentProvider: z.string().trim().max(200).optional() })
          .strict()
          .default({}),
        worktree: z
          .object({ enabled: z.boolean().default(true), cloneBaseUrl: apiUrl.optional() })
          .strict()
          .default({ enabled: true }),
        claude: agent,
        codex: agent,
        opencode: agent,
        copilot: agent,
        pi: agent,
        cursor: agent,
      })
      .strict()
      .prefault({}),
  })
  .strict();
type Config = z.output<typeof automationConfigSchema>;
type BaseSettings = PluginSettings<typeof automationSettings.schema>;
type Json = z.output<ReturnType<typeof z.json>>;

export function durationMilliseconds(value: string) {
  duration.parse(value);
  const multipliers = new Map([
    ["ms", 1],
    ["s", 1000],
    ["m", 60_000],
    ["h", 3_600_000],
    ["d", DAY],
    ["w", 7 * DAY],
  ]);
  const unit = value.replace(/^\d+/, "");
  const result = Number.parseInt(value, 10) * (multipliers.get(unit) ?? 0);
  if (!Number.isSafeInteger(result) || result <= 0)
    throw new Error("Configuration duration is too large.");
  return result;
}

function interpolate(value: Json, environment: NodeJS.ProcessEnv, location: string): Json {
  if (typeof value === "string")
    return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name: string) => {
      const replacement = environment[name];
      if (replacement === undefined)
        throw new Error(`Missing environment variable ${name} at ${location}.`);
      return replacement;
    });
  if (Array.isArray(value))
    return value.map((item, index) => interpolate(item, environment, `${location}[${index}]`));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        interpolate(item, environment, `${location}.${key}`),
      ]),
    );
  return value;
}

function parseJson(source: string) {
  try {
    return z.json().parse(JSON.parse(source));
  } catch {
    throw new Error("Invalid JSON in automations/config.json. Correct its syntax.");
  }
}

export function parseAutomationConfiguration(
  source: string,
  environment: NodeJS.ProcessEnv = process.env,
) {
  if (Buffer.byteLength(source) > 1024 * 1024)
    throw new Error("Automations configuration exceeds 1 MiB.");
  const raw = parseJson(source);
  if (valueAt(raw, "extensions.github.publishGuard") !== undefined)
    throw new Error(
      "config.extensions.github.publishGuard: Mixer does not yet enforce RoboPlane's publication guard. This configuration was not activated. Do not remove the protection solely to migrate.",
    );
  const parsed = automationConfigSchema.safeParse(interpolate(raw, environment, "config"));
  if (!parsed.success)
    throw new Error(
      parsed.error.issues
        .map((issue) => `config.${issue.path.join(".")}: ${issue.message}`)
        .join("\n"),
    );
  const config = parsed.data;
  durationMilliseconds(config.history.retention);
  const interval = durationMilliseconds(config.extensions.github.pollInterval);
  if (interval > 2_147_483_647)
    throw new Error("config.extensions.github.pollInterval is too large.");
  const jira = config.extensions.jira;
  if (jira.enabled && Boolean(jira.baseUrl) !== Boolean(jira.token))
    throw new Error("config.extensions.jira: set baseUrl and token together.");
  const webhooks = config.extensions.webhooks;
  if (
    config.extensions.github.enabled &&
    config.extensions.github.polling &&
    webhooks.enabled &&
    webhooks.listener.enabled &&
    webhooks.listener.port > 0 &&
    webhooks.githubSecret
  )
    throw new Error(
      "Disable extensions.github.polling when using signed GitHub webhooks; the transports do not share delivery IDs.",
    );
  return { config, secretVariables: secretReferences(raw) };
}

function secretReferences(raw: Json) {
  const names = new Set<string>();
  function visit(value: Json, key = "") {
    if (
      typeof value === "string" &&
      ["token", "actionToken", "githubSecret", "secret"].includes(key)
    ) {
      for (const match of value.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g)) names.add(match[1]);
    }
    if (value && typeof value === "object" && !Array.isArray(value))
      for (const [name, item] of Object.entries(value)) visit(item, name);
  }
  visit(raw);
  return names;
}

export function createAutomationConfiguration(home: string, settings: BaseSettings) {
  const file = join(home, "automations", "config.json");
  let githubCredential: { host: string; token: string; expires: number } | undefined;
  async function githubCliToken(host: string) {
    if (githubCredential?.host === host && githubCredential.expires > Date.now())
      return githubCredential.token;
    const { stdout } = await exec("gh", ["auth", "token", "--hostname", host], {
      timeout: 10_000,
      maxBuffer: 16_384,
    }).catch(() => ({ stdout: "" }));
    const parsedToken = secret.safeParse(stdout.trim());
    const token = parsedToken.success ? parsedToken.data : "";
    githubCredential = { host, token, expires: Date.now() + 60_000 };
    return token;
  }
  async function read() {
    const preferences = await settings.read();
    if (preferences.status !== "ready") return preferences;
    try {
      const source = await configurationSource(file);
      const values = pluginConfiguration(preferences.values, { resolveJira: source === null });
      if (source === null) return { ...preferences, values };
      const { config, secretVariables } = parseAutomationConfiguration(source);
      const github = config.extensions.github;
      let token = "";
      if (github.enabled) {
        const host = new URL(github.apiUrl).hostname.replace(/^api\.github\.com$/, "github.com");
        token = github.token ?? (await githubCliToken(host));
      }
      if ((await configurationSource(file)) !== source)
        throw new Error(
          "Automations configuration changed while resolving credentials. Retry the request.",
        );
      return { ...preferences, values: fileConfiguration(config, values, token, secretVariables) };
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Could not load automations/config.json.";
      return { status: "error" as const, error: message };
    }
  }
  return {
    read,
    subscribe: (listener: Parameters<BaseSettings["subscribe"]>[0]) => settings.subscribe(listener),
  };
}

async function configurationSource(file: string) {
  try {
    const stat = await lstat(file);
    if (!stat.isFile() || stat.size > 1024 * 1024)
      throw new Error(
        "automations/config.json must be a regular file no larger than 1 MiB, not a symbolic link.",
      );
    return await readFile(file, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}

function jiraConnection(baseUrl: string, token: string, options?: Config["extensions"]["jira"]) {
  if (!baseUrl || !token) return null;
  return connectionSchema.parse({
    baseUrl,
    token,
    pageSize: options?.pageSize,
    requestTimeoutMs: options?.requestTimeoutMs,
  });
}

function pluginConfiguration(
  base: z.output<typeof automationSettings.schema>,
  options: { resolveJira: boolean },
) {
  const token = (name: string) => (name ? (process.env[name] ?? "") : "");
  const credentials = {
    githubToken: token(base.integrations.githubTokenEnv),
    githubActionToken: token(base.integrations.githubActionTokenEnv),
    githubSecret: token(base.integrations.githubSecretEnv),
    webhookSecret: token(base.integrations.webhookSecretEnv),
    jiraToken: token(base.integrations.jiraTokenEnv),
  };
  const secretVariables = new Set(
    [
      base.integrations.githubTokenEnv,
      base.integrations.githubActionTokenEnv,
      base.integrations.githubSecretEnv,
      base.integrations.webhookSecretEnv,
      base.integrations.jiraTokenEnv,
    ].filter(Boolean),
  );
  return {
    ...base,
    fileConfigured: false,
    credentials,
    secretVariables: credentialVariables(secretVariables, credentials),
    jiraConnection: options.resolveJira
      ? jiraConnection(base.integrations.jiraBaseUrl, credentials.jiraToken)
      : null,
    jiraEnabled: true,
    runtime: {
      concurrency: 1,
      maxAttempts: 1,
      maxQueuedRuns: 100,
      timeout: 3_600_000,
      noOutputTimeout: 600_000,
    },
    retentionMs: base.retentionDays * DAY,
    github: {
      enabled: true,
      apiUrl: "https://api.github.com",
      polling: !base.integrations.githubSecretEnv,
      pollInterval: "1m",
      maxPages: 3,
    },
    steps: { enabled: true, env: {} },
    worktree: { enabled: true, cloneBaseUrl: "https://github.com" },
    agents: agentConfigurations(undefined),
  };
}

function fileConfiguration(
  config: Config,
  base: ReturnType<typeof pluginConfiguration>,
  token: string,
  secretVariables: Set<string>,
): ReturnType<typeof pluginConfiguration> {
  const { github, jira, webhooks } = config.extensions;
  const credentials = {
    githubToken: token,
    githubActionToken: github.enabled ? (github.actionToken ?? token) : "",
    githubSecret: webhooks.enabled ? (webhooks.githubSecret ?? "") : "",
    webhookSecret: webhooks.enabled ? (webhooks.secret ?? "") : "",
    jiraToken: jira.enabled ? (jira.token ?? "") : "",
  };
  const jiraBaseUrl = jira.baseUrl ?? "";
  const webhookPort = webhooks.enabled && webhooks.listener.enabled ? webhooks.listener.port : 0;
  return {
    ...base,
    fileConfigured: true,
    credentials,
    secretVariables: credentialVariables(
      new Set([...base.secretVariables, ...secretVariables]),
      credentials,
    ),
    agentProvider: config.extensions.mixer.agentProvider ?? base.agentProvider,
    schedulesEnabled: config.extensions.scheduler.enabled,
    integrations: { ...base.integrations, jiraBaseUrl, webhookPort },
    jiraConnection: jiraConnection(jiraBaseUrl, credentials.jiraToken, jira),
    jiraEnabled: jira.enabled,
    runtime: config.runtime,
    retentionMs: durationMilliseconds(config.history.retention),
    github: { ...github, polling: github.enabled && github.polling },
    steps: config.extensions.steps,
    worktree: {
      enabled: config.extensions.worktree.enabled,
      cloneBaseUrl: config.extensions.worktree.cloneBaseUrl ?? githubCloneBase(github.apiUrl),
    },
    agents: agentConfigurations(config),
  };
}

function githubCloneBase(api: string) {
  const url = new URL(api);
  return url.hostname === "api.github.com" ? "https://github.com" : url.origin;
}

function credentialVariables(names: Set<string>, credentials: Record<string, string>) {
  const secrets = new Set(Object.values(credentials).filter(Boolean));
  for (const [name, value] of Object.entries(process.env))
    if (value && secrets.has(value)) names.add(name);
  return names;
}

function agentConfigurations(config: Config | undefined) {
  const agents = new Map<string, { enabled: boolean; env: Record<string, string> }>();
  for (const name of ["claude", "codex", "opencode", "copilot", "pi", "cursor"] as const) {
    const value = config?.extensions[name];
    if (value) agents.set(name, value);
  }
  return agents;
}
export type AutomationConfiguration = ReturnType<typeof createAutomationConfiguration>;
export type ResolvedAutomationValues = Extract<
  Awaited<ReturnType<AutomationConfiguration["read"]>>,
  { status: "ready" }
>["values"];

export function automationAgentEnvironment(values: ResolvedAutomationValues, provider: string) {
  const name = provider.split("/")[0];
  const configured = values.agents.get(name);
  if (configured?.enabled === false)
    throw new Error(`The ${name} agent is disabled in automations/config.json.`);
  return {
    ...Object.fromEntries(Array.from(values.secretVariables, (variable) => [variable, ""])),
    ...configured?.env,
  };
}
