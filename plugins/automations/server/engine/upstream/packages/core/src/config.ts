import fs from "node:fs";
import { z } from "zod";
import type { JsonValue, PathsAPI } from "@mixer/automations-sdk";

const durationPattern = /^([1-9]\d*)(ms|s|m|h|d|w)$/;
const durationMultipliers = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 } as const;

export function parseDuration(value: string): number {
  const match = durationPattern.exec(value);
  if (!match) throw new Error(`Invalid duration '${value}'; use a positive value such as 30m, 24h, 7d, or 2w`);
  const milliseconds = Number(match[1]) * durationMultipliers[match[2] as keyof typeof durationMultipliers];
  if (!Number.isSafeInteger(milliseconds)) throw new Error(`Duration '${value}' is too large`);
  return milliseconds;
}

const durationSchema = z.string().regex(durationPattern, "use a positive duration such as 30m, 24h, 7d, or 2w");

export const configSchema = z.object({
  runtime: z.object({
    mode: z.enum(["managed", "unsafe-direct"]).default("managed"),
    concurrency: z.number().int().positive().max(32).default(1),
    maxQueuedRuns: z.number().int().positive().max(100_000).default(1_000),
    maxAttempts: z.number().int().min(1).max(10).default(1),
    timeout: z.number().int().positive().max(86_400_000).default(3_600_000),
    noOutputTimeout: z.number().int().positive().max(3_600_000).default(600_000),
    shutdownTimeout: z.number().int().positive().max(3_600_000).default(300_000),
  }).strict().default({ mode: "managed", concurrency: 1, maxQueuedRuns: 1_000, maxAttempts: 1, timeout: 3_600_000, noOutputTimeout: 600_000, shutdownTimeout: 300_000 }),
  history: z.object({
    retention: durationSchema.default("7d").transform(parseDuration),
  }).strict().default({ retention: 7 * 24 * 60 * 60 * 1_000 }),
  extensions: z.record(z.string(), z.unknown()).default({}),
}).strict();

export interface Config {
  runtime: { mode: "managed" | "unsafe-direct"; concurrency: number; maxQueuedRuns: number; maxAttempts: number; timeout: number; noOutputTimeout: number; shutdownTimeout: number };
  history: { retention: number };
  extensions: Record<string, unknown>;
}

export function extensionEnabled(config: Config, name: string): boolean {
  const value = config.extensions[name];
  return !(value && typeof value === "object" && !Array.isArray(value) && (value as Record<string, unknown>).enabled === false);
}

export function extensionConfig(config: Config, name: string): unknown {
  const value = config.extensions[name];
  if (!value || typeof value !== "object" || Array.isArray(value)) return value ?? {};
  const { enabled: _enabled, ...settings } = value as Record<string, unknown>;
  return settings;
}

export function setExtensionEnabled(configPath: string, name: string, enabled: boolean): void {
  const raw = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, "utf8")) as Record<string, unknown> : {};
  const extensions = raw.extensions && typeof raw.extensions === "object" && !Array.isArray(raw.extensions)
    ? raw.extensions as Record<string, unknown> : {};
  const current = extensions[name];
  extensions[name] = current && typeof current === "object" && !Array.isArray(current)
    ? { ...current as Record<string, unknown>, enabled }
    : { enabled };
  raw.extensions = extensions;
  fs.writeFileSync(configPath, `${JSON.stringify(raw, null, 2)}\n`, { mode: 0o600 });
}

function interpolate(value: unknown, environment: NodeJS.ProcessEnv, location = "config"): unknown {
  if (typeof value === "string") {
    return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name: string) => {
      const replacement = environment[name];
      if (replacement === undefined) throw new Error(`Missing environment variable ${name} at ${location}`);
      return replacement;
    });
  }
  if (Array.isArray(value)) return value.map((item, index) => interpolate(item, environment, `${location}[${index}]`));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, interpolate(item, environment, `${location}.${key}`)]));
  }
  return value;
}

export function loadConfig(paths: PathsAPI): Config {
  const configPath = paths.config;
  const raw: JsonValue = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, "utf8")) : {};
  if (raw && typeof raw === "object" && !Array.isArray(raw) && Object.hasOwn(raw, "agents")) {
    throw new Error("config.agents is no longer supported; authenticate each installed agent CLI directly or use extensions.<agent>.env for an explicit environment override");
  }
  return configSchema.parse(interpolate(raw, process.env));
}
