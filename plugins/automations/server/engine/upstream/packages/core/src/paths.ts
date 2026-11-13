import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import type { PathsAPI } from "@mixer/automations-sdk";

export function resolvePaths(home = process.env.MIXER_AUTOMATIONS_HOME ?? path.join(os.homedir(), ".roboplane")): PathsAPI {
  const embedded = process.env.MIXER_AUTOMATIONS_EMBEDDED === "1";
  const internal = path.resolve(home, embedded ? ".mixer-automations" : ".roboplane");
  return {
    home: path.resolve(home),
    config: embedded ? path.join(home, "automations", "config.json") : path.join(internal, "config.json"),
    cases: path.join(internal, "cases"),
    workflows: path.resolve(home, "automations"),
    extensions: embedded ? path.join(internal, "extensions") : path.resolve(home, "extensions"),
    state: path.join(internal, "state"),
    logs: path.join(internal, "logs"),
    workspaces: path.join(internal, "workspaces"),
  };
}

export function ensureHome(paths: PathsAPI): void {
  for (const directory of [paths.home, paths.workflows, paths.cases, paths.extensions, paths.state, paths.logs, paths.workspaces]) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
}

export function ensureHomeIgnore(paths: PathsAPI): void {
  const file = path.join(paths.home, ".gitignore");
  const contents = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  if (contents.split(/\r?\n/).some((line) => line === ".roboplane/" || line === "/.roboplane/")) return;
  fs.appendFileSync(file, `${contents && !contents.endsWith("\n") ? "\n" : ""}/.roboplane/\n`, { mode: 0o644 });
}
