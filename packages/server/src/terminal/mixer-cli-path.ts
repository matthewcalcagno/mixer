import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve as resolvePath } from "node:path";

// Where the Mixer CLI lives, for the PATH entry and MIXER_HOOK_CLI every terminal gets. Kept
// apart from terminal.ts so the daemon can resolve it without loading node-pty.

const require = createRequire(import.meta.url);
const MIXER_CLI_BIN_ENTRY = "@mixer/cli/bin/mixer";

export function resolveExternalProcessPath(filePath: string): string {
  return filePath.replace(/\.asar(?=[/\\]|$)/, ".asar.unpacked");
}

export function resolveMixerCliBinDir(): string | null {
  const cliExecutable = resolveMixerCliExecutablePath();
  return cliExecutable ? dirname(cliExecutable) : null;
}

export function resolveMixerCliExecutablePath(): string | null {
  const configuredCli = process.env.MIXER_CLI?.trim();
  if (configuredCli) {
    return resolvePath(configuredCli);
  }

  const cliEntrypoint = resolveMixerCliBinEntrypoint();
  if (!cliEntrypoint) {
    return null;
  }

  const externalCliEntrypoint = resolveExternalProcessPath(cliEntrypoint);
  const npmBinDir = findNpmBinDir(dirname(externalCliEntrypoint));
  if (npmBinDir) {
    const shim = resolveMixerCliShim(npmBinDir);
    if (shim) {
      return shim;
    }
  }

  return externalCliEntrypoint;
}

function resolveMixerCliBinEntrypoint(): string | null {
  try {
    return require.resolve(MIXER_CLI_BIN_ENTRY);
  } catch {
    return null;
  }
}

function findNpmBinDir(startPath: string): string | null {
  let current = startPath;
  while (true) {
    const candidate = join(current, "node_modules", ".bin");
    if (hasMixerCliShim(candidate)) {
      return candidate;
    }

    const parent = dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

function hasMixerCliShim(binDir: string): boolean {
  return resolveMixerCliShim(binDir) !== null;
}

function resolveMixerCliShim(binDir: string): string | null {
  for (const name of mixerCliShimNames()) {
    const candidate = join(binDir, name);
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

function mixerCliShimNames(): string[] {
  return process.platform === "win32" ? ["mixer.cmd", "mixer.exe", "mixer"] : ["mixer"];
}
