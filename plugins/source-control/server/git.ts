/// <reference types="node" />
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { readOperation } from "./operation.js";
import { resolve, relative, isAbsolute } from "node:path";

export function git(
  cwd: string,
  args: string[],
  input?: string,
  env?: NodeJS.ProcessEnv,
): Promise<string> {
  return new Promise((accept, reject) => {
    const process = spawn("git", ["--no-pager", ...args], {
      cwd,
      env: {
        ...globalThis.process.env,
        GIT_TERMINAL_PROMPT: "0",
        GIT_LITERAL_PATHSPECS: "1",
        ...env,
      },
      stdio: "pipe",
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      process.kill("SIGTERM");
    }, 120_000);
    process.stdout.on("data", (data: Buffer) => {
      stdout += data.toString();
    });
    process.stderr.on("data", (data: Buffer) => {
      stderr += data.toString();
    });
    let spawnError: Error | null = null;
    process.on("error", (error) => {
      spawnError = error;
    });
    process.on("close", (code) => {
      clearTimeout(timer);
      if (spawnError) reject(spawnError);
      else if (code === 0) accept(stdout);
      else
        reject(
          new Error(
            [stderr.trim(), stdout.trim()].filter(Boolean).join("\n") || `Git exited with ${code}`,
          ),
        );
    });
    process.stdin.on("error", () => {});
    process.stdin.end(input);
  });
}

export function parseFiles(raw: string) {
  const entries = raw.split("\0");
  const files: { path: string; index: string; worktree: string }[] = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (!entry) continue;
    const index = entry.charAt(0);
    const worktree = entry.charAt(1);
    files.push({ path: entry.slice(3), index, worktree });
    if (index === "R" || index === "C" || worktree === "R" || worktree === "C") i++;
  }
  return files;
}

export async function decorations(cwd: string) {
  const prefix = await git(cwd, ["rev-parse", "--show-prefix"]).catch(() => null);
  if (prefix === null) return [];
  const base = prefix.trimEnd();
  const files = parseFiles(
    await git(cwd, [
      "status",
      "--porcelain=v1",
      "--no-renames",
      "-z",
      "--untracked-files=all",
      "--",
      ".",
    ]),
  );
  return files
    .filter((file) => file.path.startsWith(base))
    .map((file) => ({
      index: file.index,
      worktree: file.worktree,
      path: file.path.slice(base.length),
    }));
}

export async function status(cwd: string) {
  const entries = parseFiles(
    await git(cwd, ["status", "--porcelain=v1", "--no-renames", "-z", "--untracked-files=all"]),
  );
  const headChanges = (
    await git(cwd, ["diff", "--no-ext-diff", "--no-renames", "--name-status", "-z", "HEAD"]).catch(
      () => Promise.resolve(""),
    )
  ).split("\0");
  const headStatuses = new Map<string, string>();
  for (let i = 0; i + 1 < headChanges.length; i += 2) {
    const path = headChanges[i + 1];
    const change = headChanges[i];
    if (path && change) headStatuses.set(path, change);
  }
  const files = entries.map((file) => ({
    path: file.path,
    index: file.index,
    worktree: file.worktree,
    head:
      file.index === "?" ? "?" : (headStatuses.get(file.path) ?? (file.index === "A" ? "A" : " ")),
  }));
  const branch = (
    await git(cwd, ["symbolic-ref", "--short", "-q", "HEAD"]).catch(() =>
      Promise.resolve("Detached HEAD"),
    )
  ).trim();
  const upstream = (
    await git(cwd, ["rev-parse", "--abbrev-ref", "@{upstream}"]).catch(() => Promise.resolve(""))
  ).trim();
  const counts = upstream
    ? (await git(cwd, ["rev-list", "--left-right", "--count", "HEAD...@{upstream}"]))
        .trim()
        .split(/\s+/)
        .map(Number)
    : [0, 0];
  const hash = createHash("sha256");
  hash.update(
    await git(cwd, ["diff", "--no-ext-diff", "--binary", "HEAD"]).catch(() =>
      git(cwd, ["diff", "--no-ext-diff", "--binary", "--cached"]),
    ),
  );
  hash.update(await git(cwd, ["diff", "--no-ext-diff", "--binary", "--cached"]));
  hash.update(JSON.stringify(files));
  hash.update(branch);
  hash.update(upstream);
  hash.update(await git(cwd, ["rev-parse", "HEAD"]).catch(() => Promise.resolve("unborn")));
  for (const file of files)
    if (file.index === "?") hash.update(await readFile(resolve(cwd, file.path)));
  const operation = await readOperation(cwd);
  hash.update(JSON.stringify(operation));
  const hasRemote = (await git(cwd, ["remote"])).trim().length > 0;
  return {
    branch,
    upstream,
    hasRemote,
    operation,
    ahead: counts[0] ?? 0,
    behind: counts[1] ?? 0,
    files,
    revision: hash.digest("hex"),
  };
}

export function validatePaths(cwd: string, paths: string[]) {
  for (const path of paths) {
    const local = relative(cwd, resolve(cwd, path));
    if (
      !local ||
      local.startsWith("../") ||
      isAbsolute(local) ||
      local === ".git" ||
      local.startsWith(".git/")
    )
      throw new Error("Invalid repository path");
  }
}

export async function diff(cwd: string, path: string, staged: boolean) {
  validatePaths(cwd, [path]);
  const files = parseFiles(
    await git(cwd, ["status", "--porcelain=v1", "--no-renames", "-z", "--untracked-files=all"]),
  );
  if (files.some((file) => file.path === path && file.index === "?")) {
    const content = await readFile(resolve(cwd, path), "utf8");
    return `Untracked file: ${path}\n\n${content}`;
  }
  return git(cwd, [
    "diff",
    "--no-ext-diff",
    "--no-textconv",
    "--no-color",
    "--no-renames",
    ...(staged ? ["--cached"] : []),
    "--",
    path,
  ]);
}

export function selectHunk(patch: string, index: number) {
  const parts = patch.split(/(?=^@@ )/m);
  const header = parts.shift();
  const hunk = parts[index];
  if (!header || !hunk || !hunk.startsWith("@@ "))
    throw new Error("This diff does not support hunk operations");
  return header + hunk;
}
