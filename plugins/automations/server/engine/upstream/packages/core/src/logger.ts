import fs from "node:fs";
import path from "node:path";
import pino, { type Logger as PinoLogger } from "pino";
import type { Logger, PathsAPI } from "@mixer/automations-sdk";

const secretKey = /(?:token|secret|password|authorization|api[_-]?key|credential)/i;
const secretValue = /\b(?:gh[opusr]_[A-Za-z0-9_]{20,}|Bearer\s+\S+)/gi;

export function redactSecrets(value: unknown): unknown {
  if (typeof value === "string") return value.replace(secretValue, "[REDACTED]");
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, secretKey.test(key) ? "[REDACTED]" : redactSecrets(item)]),
    );
  }
  return value;
}

function wrap(logger: PinoLogger): Logger {
  const write = (level: "debug" | "info" | "warn" | "error") => (data: unknown, message?: string) => {
    if (typeof data === "string" && message === undefined) logger[level](redactSecrets(data));
    else logger[level](redactSecrets(data), message);
  };
  return {
    debug: write("debug"),
    info: write("info"),
    warn: write("warn"),
    error: write("error"),
    child: (bindings) => wrap(logger.child(redactSecrets(bindings) as Record<string, unknown>)),
  };
}

export function createLogger(paths: PathsAPI, options: { console?: boolean; runId?: string } = {}): Logger {
  fs.mkdirSync(paths.logs, { recursive: true });
  const destination = pino.destination({
    dest: path.join(paths.logs, options.runId ? `${options.runId}.log` : "roboplane.log"),
    sync: true,
  });
  const streams: pino.StreamEntry[] = [{ stream: destination }];
  if (options.console) streams.push({ stream: process.stdout });
  return wrap(pino({ level: process.env.MIXER_AUTOMATIONS_LOG_LEVEL ?? "info" }, pino.multistream(streams)));
}
