import path from "node:path";

import { resolveMixerHome } from "../../../mixer-home.js";

const OPENCODE_HOME_DIRNAME = "opencode-home";

export function resolveOpenCodeHomeDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveMixerHome(env), OPENCODE_HOME_DIRNAME);
}
