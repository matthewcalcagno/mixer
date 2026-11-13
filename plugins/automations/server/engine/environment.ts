import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export function configureEmbeddedEnvironment(home: string, sdkRoot: string) {
  const identity = existsSync(home) ? realpathSync(home) : path.resolve(home);
  const hash = createHash("sha256").update(identity).digest("hex").slice(0, 24);
  let socket: string;
  if (process.platform === "win32") socket = `\\\\.\\pipe\\mixer-automations-${hash}`;
  else {
    const parent = Buffer.byteLength(os.tmpdir()) > 45 ? "/tmp" : os.tmpdir();
    const directory = path.join(parent, `mixer-automations-${process.getuid?.() ?? "user"}`);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const stat = lstatSync(directory);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      stat.uid !== process.getuid?.() ||
      (stat.mode & 0o077) !== 0
    )
      throw new Error(
        "Mixer Automations control directory must be private and owned by the current user.",
      );
    socket = path.join(directory, `${hash}.sock`);
  }
  process.env.MIXER_AUTOMATIONS_EMBEDDED = "1";
  process.env.MIXER_AUTOMATIONS_HOME = home;
  process.env.MIXER_AUTOMATIONS_SDK_ROOT = sdkRoot;
  process.env.MIXER_AUTOMATIONS_CONTROL_SOCKET = socket;
}
