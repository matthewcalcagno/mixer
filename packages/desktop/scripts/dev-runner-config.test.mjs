import { describe, expect, test } from "vitest";
import { mkdtempSync, readFileSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createElectronSpawnOptions,
  registerDevRunnerShutdownSignals,
  resolveChildKillTarget,
  resolveDevBuildLabel,
} from "./dev-runner-config.mjs";

describe("desktop dev process ownership", () => {
  test.skipIf(process.platform === "win32")(
    "rebuilds the daemon and built-in plugins before launching Electron",
    () => {
      const root = mkdtempSync(path.join(tmpdir(), "mixer-dev-build-"));
      try {
        const desktop = path.join(root, "packages/desktop");
        const scripts = path.join(desktop, "scripts");
        const bin = path.join(root, "node_modules/.bin");
        const log = path.join(root, "commands.log");
        mkdirSync(scripts, { recursive: true });
        mkdirSync(bin, { recursive: true });
        mkdirSync(path.join(root, "scripts"));
        writeFileSync(
          path.join(scripts, "dev.sh"),
          readFileSync(new URL("./dev.sh", import.meta.url)),
        );
        writeFileSync(
          path.join(root, "scripts/dev-home.sh"),
          `
configure_dev_mixer_home() { :; }
default_dev_mixer_root() { echo "$ROOT_DIR"; }
resolve_dev_daemon_endpoint() { echo localhost:6768; }
`,
        );
        const runtime = JSON.stringify({
          electronFlags: "",
          userDataDir: path.join(root, "user-data"),
        });
        writeFileSync(
          path.join(bin, "node"),
          `#!/usr/bin/env bash
if [[ "$1" == *dev-runtime.mjs ]]; then
  printf '%s\\n' "$DEV_RUNTIME_JSON"
elif [[ "$1" == *dev-runner.mjs ]]; then
  echo runner >> "$BUILD_LOG"
else
  exec "$REAL_NODE" "$@"
fi
`,
          { mode: 0o755 },
        );
        writeFileSync(
          path.join(bin, "npm"),
          `#!/usr/bin/env bash
echo "$*" >> "$BUILD_LOG"
if [[ "$*" == *build:server && "$FAIL_DAEMON_BUILD" == 1 ]]; then exit 17; fi
`,
          { mode: 0o755 },
        );
        const env = {
          ...process.env,
          DEV_RUNTIME_JSON: runtime,
          REAL_NODE: process.execPath,
          BUILD_LOG: log,
          EXPO_PORT: "8082",
          MIXER_HOME: path.join(root, "home"),
          MIXER_DEV_ROOT: root,
        };
        execFileSync("bash", [path.join(scripts, "dev.sh")], { env });
        expect(readFileSync(log, "utf8").trim().split("\n")).toEqual([
          `--prefix ${root} run build:server`,
          `--prefix ${desktop} run build:main`,
          "runner",
        ]);
        writeFileSync(log, "");
        let failedStatus = null;
        try {
          execFileSync("bash", [path.join(scripts, "dev.sh")], {
            env: { ...env, FAIL_DAEMON_BUILD: "1" },
          });
        } catch (error) {
          failedStatus = error.status;
        }
        expect(failedStatus).toBe(17);
        expect(readFileSync(log, "utf8").trim().split("\n")).toEqual([
          `--prefix ${root} run build:server`,
        ]);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
  test("omits the build label outside a Git repository", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "mixer-dev-label-"));
    try {
      expect(resolveDevBuildLabel(directory)).toBe("");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("uses the local branch as the build label without a GitHub remote", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "mixer-dev-label-"));
    try {
      execFileSync("git", ["init", "--initial-branch=desktop-dev", directory]);
      expect(resolveDevBuildLabel(directory)).toBe("desktop-dev");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("makes the signal-handling runner the workspace terminal process", () => {
    const mixerConfig = JSON.parse(
      readFileSync(new URL("../../../mixer.json", import.meta.url), "utf8"),
    );
    const devScript = readFileSync(new URL("./dev.sh", import.meta.url), "utf8");

    expect(mixerConfig.scripts.desktop.command).toContain("exec ./packages/desktop/scripts/dev.sh");
    expect(devScript).toContain('npm --prefix "$DESKTOP_DIR" run build:main');
    expect(devScript).toContain('exec node "$SCRIPT_DIR/dev-runner.mjs"');
  });

  test("keeps Electron in the runner process group", () => {
    const options = createElectronSpawnOptions({
      env: { PATH: "/usr/bin" },
      colorEnv: { FORCE_COLOR: "1" },
      expoDevUrl: "http://localhost:8082",
    });

    expect(options).toMatchObject({
      detached: false,
      env: {
        PATH: "/usr/bin",
        FORCE_COLOR: "1",
        EXPO_DEV_URL: "http://localhost:8082",
      },
    });
  });

  test("targets the whole process group for detached child trees", () => {
    expect(resolveChildKillTarget(42, true)).toBe(-42);
    expect(resolveChildKillTarget(42, false)).toBe(42);
  });

  test("stops children when the owning terminal hangs up", () => {
    const listeners = new Map();
    const receivedSignals = [];

    registerDevRunnerShutdownSignals({
      signalSource: {
        on(signal, listener) {
          listeners.set(signal, listener);
        },
      },
      stop(signal) {
        receivedSignals.push(signal);
      },
    });

    expect(Array.from(listeners.keys())).toEqual(["SIGHUP", "SIGINT", "SIGTERM"]);
    listeners.get("SIGHUP")();
    expect(receivedSignals).toEqual(["SIGTERM"]);
  });
});
