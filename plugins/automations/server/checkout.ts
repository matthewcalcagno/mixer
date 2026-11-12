import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { repositorySlug } from "./definition.js";

const exec = promisify(execFile);
export const commitHash = /^[0-9a-f]{40}$/i;

// Use the configured base repository. An event cannot redirect credentials to its fork.
export async function checkoutRepository(
  path: string,
  repository: string,
  revision: string | undefined,
  signal: AbortSignal,
) {
  const slug = repositorySlug.parse(repository);
  const remote = `https://github.com/${slug}.git`;
  const env = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
  const git = (args: string[]) =>
    exec("git", ["-c", "core.hooksPath=/dev/null", ...args], {
      signal,
      env,
      timeout: 120_000,
      maxBuffer: 256 * 1024,
    });
  await git(["clone", "--no-checkout", "--depth=1", "--", remote, path]);
  if (revision) {
    if (!commitHash.test(revision)) throw new Error("Invalid GitHub commit revision.");
    await git(["-C", path, "fetch", "--depth=1", "origin", revision]);
  }
  const ref = revision ? "FETCH_HEAD" : "HEAD";
  await git(["-C", path, "checkout", "--detach", ref]);
  const head = (await git(["-C", path, "rev-parse", "HEAD"])).stdout.trim();
  if (revision && head !== revision.toLowerCase())
    throw new Error("Repository checkout did not match the event revision.");
  return head;
}
