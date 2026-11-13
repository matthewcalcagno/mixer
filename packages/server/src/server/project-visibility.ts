import { join } from "node:path";
import { createRealpathAwarePathMatcher } from "../utils/path.js";

/** Automations owns this runtime project; it is not a user project or a background-work toggle. */
export function isUserProjectRoot(rootPath: string, mixerHome: string): boolean {
  return !createRealpathAwarePathMatcher(join(mixerHome, "automations"))(rootPath);
}
