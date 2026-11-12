import { spawn } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { StepsConfiguration } from "./steps-schema.js";

// Port of RoboPlane's step ordering, conditions, retries and timeouts.
export async function executeSteps(
  config: StepsConfiguration,
  root: string,
  signal: AbortSignal,
  log: (text: string) => void,
  context: Record<string, string>,
) {
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(([key]) =>
      /^(PATH|HOME|USER|LOGNAME|TMPDIR|TEMP|TMP|LANG|LC_[A-Z_]+|SYSTEMROOT|USERPROFILE)$/i.test(
        key,
      ),
    ),
  );
  let failure: Error | undefined;
  for (const [ordinal, step] of config.steps.entries()) {
    signal.throwIfAborted();
    const id = step.id ?? `step_${ordinal + 1}`;
    if (step.if !== "always" && (step.if === "failure") !== Boolean(failure)) {
      log(`\n${step.name ?? id} · Skipped\n`);
      continue;
    }
    const error = await executeStep(
      step,
      config.defaults.run,
      root,
      signal,
      log,
      {
        ...environment,
        ...config.env,
        ...step.env,
        ...context,
        MIXER_STEP_ID: id,
      },
      id,
    );
    if (error) failure ??= error;
  }
  if (failure) throw failure;
}

async function executeStep(
  step: StepsConfiguration["steps"][number],
  defaults: StepsConfiguration["defaults"]["run"],
  root: string,
  signal: AbortSignal,
  log: (text: string) => void,
  environment: NodeJS.ProcessEnv,
  id: string,
) {
  const timeout = step.timeout ?? defaults.timeout ?? 15 * 60_000;
  const deadline = Date.now() + timeout;
  const attempts = step.retry?.maxAttempts ?? 1;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    log(`\n${step.name ?? id} · Attempt ${attempt}\n`);
    try {
      const cwd = await resolveStepDirectory(
        root,
        step["working-directory"] ?? defaults["working-directory"],
      );
      const shell = step.shell ?? defaults.shell;
      await runShell(
        shell,
        step.run,
        cwd,
        {
          ...environment,
          MIXER_ATTEMPT: String(attempt),
        },
        Math.max(1, deadline - Date.now()),
        step["no-output-timeout"] ?? defaults["no-output-timeout"],
        signal,
        log,
      );
      return;
    } catch (cause) {
      signal.throwIfAborted();
      const reason = cause instanceof Error ? cause.message : String(cause);
      log(`\n${reason}\n`);
      const wait = step.retry?.delay ?? 0;
      if (attempt < attempts && Date.now() + wait < deadline) {
        await delay(wait, undefined, { signal });
        continue;
      }
      if (!step["continue-on-error"]) return new Error(`${id}: ${reason}`);
      return;
    }
  }
}

async function resolveStepDirectory(root: string, directory: string) {
  const cwd = await realpath(resolve(root, directory));
  const inside = relative(root, cwd);
  if (
    inside === ".." ||
    inside.startsWith(`..${sep}`) ||
    isAbsolute(inside) ||
    !(await stat(cwd)).isDirectory()
  )
    throw new Error("Step working directory must stay inside the workspace.");
  return cwd;
}

function runShell(
  shell: "bash" | "sh",
  script: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeout: number,
  idleTimeout: number | undefined,
  signal: AbortSignal,
  log: (text: string) => void,
) {
  return new Promise<void>((resolveRun, reject) => {
    signal.throwIfAborted();
    const grouped = process.platform !== "win32";
    const args =
      shell === "bash" ? ["--noprofile", "--norc", "-e", "-o", "pipefail", "-c"] : ["-e", "-c"];
    const child = spawn(shell, [...args, script], {
      cwd,
      env,
      detached: grouped,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let failure: Error | undefined;
    let idle: ReturnType<typeof setTimeout> | undefined;
    function stop(reason: string) {
      failure ??= new Error(reason);
      if (!child.pid) return;
      try {
        if (grouped) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") reject(error);
      }
    }
    const onAbort = () => stop("Run interrupted.");
    const deadline = setTimeout(() => stop("Step timed out."), timeout);
    const resetIdle = () => {
      clearTimeout(idle);
      if (idleTimeout) idle = setTimeout(() => stop("Step stopped producing output."), idleTimeout);
    };
    resetIdle();
    signal.addEventListener("abort", onAbort, { once: true });
    for (const stream of [child.stdout, child.stderr]) {
      stream.setEncoding("utf8").on("data", (chunk: string) => {
        log(chunk);
        resetIdle();
      });
    }
    child.once("error", (error) => {
      failure ??= error;
    });
    child.once("close", (code, termination) => {
      clearTimeout(deadline);
      clearTimeout(idle);
      signal.removeEventListener("abort", onAbort);
      if (failure) reject(failure);
      else if (code !== 0) reject(new Error(`Step exited with ${termination ?? code}.`));
      else resolveRun();
    });
  });
}
