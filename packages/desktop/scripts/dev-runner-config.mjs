import { spawnSync } from "node:child_process";

export function resolveDevBuildLabel(rootDir) {
  const result = spawnSync("git", ["branch", "--show-current"], {
    cwd: rootDir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  return result.status === 0 ? result.stdout.trim() : "";
}

export function createElectronSpawnOptions({ env, colorEnv, expoDevUrl, devBuildLabel }) {
  return {
    // Electron must stay in the runner's process group. Mixer workspace scripts
    // own the terminal process group, so detaching Electron lets it survive a
    // service stop with broken stdout/stderr pipes and block the next launch.
    detached: false,
    env: {
      ...env,
      ...colorEnv,
      EXPO_DEV_URL: expoDevUrl,
      ...(devBuildLabel ? { EXPO_PUBLIC_MIXER_DEV_BUILD_LABEL: devBuildLabel } : {}),
    },
  };
}

export function resolveChildKillTarget(pid, detached) {
  return detached ? -pid : pid;
}

export function registerDevRunnerShutdownSignals({ signalSource, stop }) {
  for (const signal of ["SIGHUP", "SIGINT", "SIGTERM"]) {
    signalSource.on(signal, () => stop("SIGTERM"));
  }
}
