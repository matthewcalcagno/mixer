import { execa } from "execa";
import type { ProcessAPI, ProcessResult, ProcessRunOptions } from "@mixer/automations-sdk";

const DEFAULT_ENV = ["PATH", "HOME", "USER", "SHELL", "TMPDIR", "LANG", "LC_ALL", "TERM"];
const SECRET_NAME = /(?:TOKEN|SECRET|PASSWORD|AUTH|CREDENTIAL|API_KEY)/i;

export class CoreProcessAPI implements ProcessAPI {
  async run(options: ProcessRunOptions): Promise<ProcessResult> {
    options.signal?.throwIfAborted();
    const inherited = options.inheritEnv ?? DEFAULT_ENV;
    const denied = new Set(options.denyEnv ?? []);
    const env: Record<string, string> = {};
    if (process.env.MIXER_AUTOMATIONS_EMBEDDED === "1" && process.versions.electron && !denied.has("ELECTRON_RUN_AS_NODE")) env.ELECTRON_RUN_AS_NODE = "1";
    for (const name of inherited) {
      if (!denied.has(name) && !SECRET_NAME.test(name) && process.env[name] !== undefined) env[name] = process.env[name];
    }
    for (const [name, value] of Object.entries(options.env ?? {})) {
      if (value !== undefined && !denied.has(name)) env[name] = value;
    }

    const child = execa(options.command, [...(options.args ?? [])], {
      cwd: options.cwd,
      env,
      extendEnv: false,
      stdin: "ignore",
      cancelSignal: options.signal,
      reject: false,
      buffer: options.captureOutput ?? true,
      detached: process.platform !== "win32",
    });
    let idleTimer: NodeJS.Timeout | undefined;
    let totalTimer: NodeJS.Timeout | undefined;
    let escalation: NodeJS.Timeout | undefined;
    let idleTimedOut = false;
    let totalTimedOut = false;
    let stopped = false;
    const kill = (signal: "SIGTERM" | "SIGKILL") => {
      try {
        if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch { /* The process group may already have exited. */ }
    };
    const stop = () => {
      if (stopped) return;
      stopped = true;
      kill("SIGTERM");
      escalation = setTimeout(() => kill("SIGKILL"), 1000);
      escalation.unref();
    };
    options.signal?.addEventListener("abort", stop, { once: true });
    if (options.timeout) {
      totalTimer = setTimeout(() => { totalTimedOut = true; stop(); }, options.timeout);
      totalTimer.unref();
    }
    const touch = () => {
      if (!options.noOutputTimeout) return;
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        idleTimedOut = true;
        stop();
      }, options.noOutputTimeout);
      idleTimer.unref();
    };
    child.stdout?.on("data", (chunk: Buffer) => { touch(); options.onStdout?.(chunk.toString()); });
    child.stderr?.on("data", (chunk: Buffer) => { touch(); options.onStderr?.(chunk.toString()); });
    touch();
    try {
      const result = await child;
      if (idleTimedOut) throw new Error(`Process produced no output for ${options.noOutputTimeout}ms`);
      if (totalTimedOut) throw new Error(`Process exceeded its ${options.timeout}ms timeout`);
      options.signal?.throwIfAborted();
      return { exitCode: result.exitCode ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "", errorCode: result.code };
    } finally {
      if (idleTimer) clearTimeout(idleTimer);
      if (totalTimer) clearTimeout(totalTimer);
      if (escalation) clearTimeout(escalation);
      options.signal?.removeEventListener("abort", stop);
      if (stopped) kill("SIGKILL");
    }
  }
}
