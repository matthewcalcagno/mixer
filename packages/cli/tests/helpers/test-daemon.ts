/**
 * Test Daemon Helper
 *
 * Provides utilities for launching real Mixer daemons in E2E tests.
 * Each test gets an isolated daemon on an available local port with its own MIXER_HOME.
 *
 * CRITICAL RULES (from design doc):
 * 1. Port: Use an available ephemeral local port - NEVER use 6767 (production)
 * 2. Protocol: WebSocket ONLY - daemon has no HTTP endpoints
 * 3. Temp dirs: Create temp directories for MIXER_HOME and agent --cwd
 * 4. Model: Always use claude provider with haiku model for fast, cheap tests
 * 5. Cleanup: Kill daemon and remove temp dirs after each test
 */

import { mkdtemp, rm, mkdir } from "fs/promises";
import { existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { fileURLToPath } from "url";
import { ChildProcess, spawn } from "child_process";
import { readDaemonInstance } from "@mixer/server/daemon-control";

export interface TestDaemonContext {
  /** Available local port for test daemon (never 6767) */
  port: number;
  /** WebSocket URL for connecting to daemon */
  wsUrl: string;
  /** Temp directory for MIXER_HOME */
  mixerHome: string;
  /** Temp directory for agent working directory */
  workDir: string;
  /** Running daemon process */
  process: ChildProcess | null;
  /** Whether the daemon is ready to accept connections */
  isReady: boolean;
  /** Stop the daemon and clean up resources */
  stop: () => Promise<void>;
}

const TEST_DAEMON_ENV_DEFAULTS: Record<string, string> = {
  MIXER_RELAY_ENABLED: "false",
  MIXER_LOCAL_SPEECH_AUTO_DOWNLOAD: process.env.MIXER_LOCAL_SPEECH_AUTO_DOWNLOAD ?? "0",
  MIXER_DICTATION_ENABLED: process.env.MIXER_DICTATION_ENABLED ?? "0",
  MIXER_VOICE_MODE_ENABLED: process.env.MIXER_VOICE_MODE_ENABLED ?? "0",
};
const TEST_DAEMON_HOST = "127.0.0.1";
const TSX_ENTRY = fileURLToPath(import.meta.resolve("tsx/cli"));

const DEFAULT_OUTPUT_CAPTURE_LIMIT = 256 * 1024;
const TEST_OUTPUT_CAPTURE_LIMIT = Number.parseInt(
  process.env.MIXER_TEST_OUTPUT_CAPTURE_BYTES ?? `${DEFAULT_OUTPUT_CAPTURE_LIMIT}`,
  10,
);

interface OutputCapture {
  value: string;
  truncated: boolean;
}

function createOutputCapture(): OutputCapture {
  return { value: "", truncated: false };
}

function appendOutputCapture(target: OutputCapture, chunk: Buffer): void {
  const next = target.value + chunk.toString();
  if (next.length <= TEST_OUTPUT_CAPTURE_LIMIT) {
    target.value = next;
    return;
  }
  target.truncated = true;
  target.value = next.slice(next.length - TEST_OUTPUT_CAPTURE_LIMIT);
}

function formatOutputCapture(target: OutputCapture): string {
  if (!target.truncated) {
    return target.value;
  }
  return `[truncated; showing last ${TEST_OUTPUT_CAPTURE_LIMIT} chars]\n${target.value}`;
}

function readNodeErrnoCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  return typeof (error as { code?: unknown }).code === "string"
    ? (error as { code: string }).code
    : undefined;
}

function signalProcessTree(pid: number, signal: NodeJS.Signals): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }

  if (process.platform !== "win32") {
    try {
      process.kill(-pid, signal);
      return true;
    } catch (error) {
      const code = readNodeErrnoCode(error);
      if (code === "ESRCH") {
        return false;
      }
    }
  }

  try {
    process.kill(pid, signal);
    return true;
  } catch (error) {
    const code = readNodeErrnoCode(error);
    if (code === "ESRCH") {
      return false;
    }
    throw error;
  }
}

async function terminateProcessTree(processRef: ChildProcess, timeoutMs: number): Promise<void> {
  const pid = processRef.pid;
  if (!Number.isInteger(pid) || pid <= 0) {
    return;
  }
  if (processRef.exitCode !== null || processRef.signalCode !== null) {
    return;
  }

  signalProcessTree(pid, "SIGTERM");

  await new Promise<void>((resolve) => {
    const done = () => resolve();
    const onExit = () => {
      clearTimeout(timeoutId);
      done();
    };
    const timeoutId = setTimeout(() => {
      signalProcessTree(pid, "SIGKILL");
      processRef.removeListener("exit", onExit);
      done();
    }, timeoutMs);
    processRef.once("exit", onExit);
  });
}

/**
 * Generate a random port for test daemon
 * Uses range 20000-30000 to avoid conflicts
 * NEVER uses 6767 (user's running daemon)
 */
export function getRandomPort(): number {
  return 20000 + Math.floor(Math.random() * 10000);
}

/**
 * Create isolated temp directories for testing
 */
export async function createTempDirs(): Promise<{ mixerHome: string; workDir: string }> {
  const mixerHome = await mkdtemp(join(tmpdir(), "mixer-e2e-home-"));
  const workDir = await mkdtemp(join(tmpdir(), "mixer-e2e-work-"));

  // Create the agents directory that the daemon expects
  const agentsDir = join(mixerHome, "agents");
  await mkdir(agentsDir, { recursive: true });

  return { mixerHome, workDir };
}

/**
 * Wait for daemon to be ready by running `mixer agent ls`
 * This connects via WebSocket and ensures the daemon is responsive
 */
async function probeDaemonReady(
  port: number,
  mixerHome: string,
  env?: NodeJS.ProcessEnv,
): Promise<boolean> {
  try {
    const { exitCode } = await runMixerCli(
      {
        port,
        wsUrl: `ws://${TEST_DAEMON_HOST}:${port}`,
        mixerHome,
        workDir: "",
        process: null,
        isReady: false,
        stop: async () => {},
      },
      ["agent", "ls", "--host", `${TEST_DAEMON_HOST}:${port}`],
      { env },
    );
    return exitCode === 0;
  } catch {
    return false;
  }
}

async function waitForDaemonReady(
  mixerHome: string,
  timeout = 30000,
  env?: NodeJS.ProcessEnv,
): Promise<number> {
  const deadline = Date.now() + timeout;

  async function poll(): Promise<number> {
    const instance = await readDaemonInstance(mixerHome);
    if (instance?.listen) {
      const port = Number(new URL(`http://${instance.listen}`).port);
      if (await probeDaemonReady(port, mixerHome, env)) return port;
    }
    if (Date.now() >= deadline) {
      throw new Error(`Daemon failed to publish a ready endpoint within ${timeout}ms`);
    }
    await sleep(100);
    return poll();
  }

  return poll();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Start a test daemon programmatically using the server's bootstrap API
 *
 * This starts the daemon in a separate process using the CLI's daemon start command
 * with isolated MIXER_HOME and MIXER_LISTEN environment variables.
 */
export async function startTestDaemon(options?: {
  port?: number;
  mixerHome?: string;
  workDir?: string;
  timeout?: number;
  env?: NodeJS.ProcessEnv;
}): Promise<TestDaemonContext> {
  // Let the listening process allocate its port, without a reserve/release race.
  const requestedPort = options?.port ?? 0;
  const { mixerHome, workDir } =
    options?.mixerHome && options?.workDir
      ? { mixerHome: options.mixerHome, workDir: options.workDir }
      : await createTempDirs();
  const timeout = options?.timeout ?? 30000;

  // Find the CLI entry point - use the source file directly with tsx
  const cliDir = join(import.meta.dirname, "..", "..");
  const cliSrcPath = join(cliDir, "src", "index.ts");

  // Start daemon process using tsx to run TypeScript directly
  const daemonProcess = spawn(process.execPath, [TSX_ENTRY, cliSrcPath, "daemon", "run"], {
    env: {
      ...Object.fromEntries(
        Object.entries(process.env).filter(([key]) => !key.startsWith("MIXER_")),
      ),
      ...TEST_DAEMON_ENV_DEFAULTS,
      MIXER_HOME: mixerHome,
      MIXER_LISTEN: `${TEST_DAEMON_HOST}:${requestedPort}`,
      // Force no TTY to prevent QR code output
      CI: "true",
      ...options?.env,
      HOME: mixerHome,
      USERPROFILE: mixerHome,
    },
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });

  const stdout = createOutputCapture();
  const stderr = createOutputCapture();

  daemonProcess.stdout?.on("data", (data) => {
    appendOutputCapture(stdout, data);
  });

  daemonProcess.stderr?.on("data", (data) => {
    appendOutputCapture(stderr, data);
  });

  const cleanup = async () => {
    if (daemonProcess) {
      await terminateProcessTree(daemonProcess, 5000);
    }

    // Clean up temp directories
    try {
      if (existsSync(mixerHome)) {
        await rm(mixerHome, { recursive: true, force: true });
      }
    } catch {
      // Ignore cleanup errors
    }

    try {
      if (existsSync(workDir)) {
        await rm(workDir, { recursive: true, force: true });
      }
    } catch {
      // Ignore cleanup errors
    }
  };

  // Handle process errors
  daemonProcess.on("error", (err) => {
    console.error("Daemon process error:", err);
  });

  daemonProcess.on("exit", (code) => {
    if (code !== 0 && code !== null) {
      console.error(`Daemon process exited with code ${code}`);
      const stderrText = formatOutputCapture(stderr);
      if (stderrText) {
        console.error("Daemon stderr:", stderrText);
      }
    }
  });

  // Wait for daemon to be ready
  try {
    const port = await waitForDaemonReady(mixerHome, timeout, options?.env);
    return {
      port,
      wsUrl: `ws://${TEST_DAEMON_HOST}:${port}`,
      mixerHome,
      workDir,
      process: daemonProcess,
      isReady: true,
      stop: cleanup,
    };
  } catch (err) {
    // Daemon failed to start - clean up and rethrow
    await cleanup();
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Failed to start test daemon: ${message}\nStdout: ${formatOutputCapture(stdout)}\nStderr: ${formatOutputCapture(stderr)}`,
      { cause: err },
    );
  }
}

/**
 * Run a mixer CLI command against a test daemon
 *
 * This is a helper that sets the correct environment variables
 * to point at the test daemon.
 */
export async function runMixerCli(
  ctx: TestDaemonContext,
  args: string[],
  options?: {
    timeout?: number;
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    /** Close the reading end of the CLI's stdout, as a launcher that discards output does. */
    closedStdout?: boolean;
  },
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const timeout = options?.timeout ?? 60000;
  const cwd = options?.cwd ?? ctx.workDir;

  const cliDir = join(import.meta.dirname, "..", "..");
  const cliSrcPath = join(cliDir, "src", "index.ts");

  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [TSX_ENTRY, cliSrcPath, ...args], {
      env: {
        ...Object.fromEntries(
          Object.entries(process.env).filter(([key]) => !key.startsWith("MIXER_")),
        ),
        ...TEST_DAEMON_ENV_DEFAULTS,
        MIXER_HOME: ctx.mixerHome,
        ...options?.env,
        HOME: ctx.mixerHome,
        USERPROFILE: ctx.mixerHome,
      },
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });

    const stdout = createOutputCapture();
    const stderr = createOutputCapture();

    if (options?.closedStdout) {
      proc.stdout?.destroy();
    }

    proc.stdout?.on("data", (data) => {
      appendOutputCapture(stdout, data);
    });

    proc.stderr?.on("data", (data) => {
      appendOutputCapture(stderr, data);
    });

    const timeoutId = setTimeout(() => {
      if (proc.pid) {
        signalProcessTree(proc.pid, "SIGKILL");
      }
      reject(new Error(`CLI command timed out after ${timeout}ms: mixer ${args.join(" ")}`));
    }, timeout);

    proc.on("exit", (code) => {
      clearTimeout(timeoutId);
      resolve({
        exitCode: code ?? 1,
        stdout: formatOutputCapture(stdout),
        stderr: formatOutputCapture(stderr),
      });
    });

    proc.on("error", (err) => {
      clearTimeout(timeoutId);
      reject(err);
    });
  });
}

/**
 * Create a test context that includes a started daemon
 * and a helper to run CLI commands against it.
 *
 * This is the main entry point for E2E tests.
 */
export async function createE2ETestContext(options?: {
  timeout?: number;
  env?: NodeJS.ProcessEnv;
}): Promise<
  TestDaemonContext & {
    /** Run a mixer CLI command against this daemon */
    mixer: (
      args: string[],
      opts?: { timeout?: number; cwd?: string; env?: NodeJS.ProcessEnv },
    ) => Promise<{
      exitCode: number;
      stdout: string;
      stderr: string;
    }>;
  }
> {
  const ctx = await startTestDaemon({ timeout: options?.timeout, env: options?.env });

  const mixer = (
    args: string[],
    opts?: { timeout?: number; cwd?: string; env?: NodeJS.ProcessEnv },
  ) => runMixerCli(ctx, args, opts);

  return {
    ...ctx,
    mixer,
  };
}
