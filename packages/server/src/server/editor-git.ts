import path from "node:path";
import { realpath, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { LRUCache } from "lru-cache";
import {
  gitObjectIdSchema,
  type EditorGitBlame,
  type EditorGitCommit,
  type EditorGitCommitDetails,
} from "@mixer/protocol/editor-git";
import { parseGitRemoteLocation } from "@mixer/protocol/git-remote";
import { createRunGitCommand, type GitCommandOptions } from "../utils/run-git-command.js";
import {
  defaultResolveRemoteUrl,
  ForgeAuthenticationError,
  ForgeCommandError,
} from "../services/forge-cli-command.js";
import type { ForgeResolution } from "../services/forge-resolver.js";
import { getEditorCommitAuthor } from "./editor-git-avatar.js";

const runGit = createRunGitCommand("editor-git-annotations");
function git(args: string[], options: GitCommandOptions) {
  return runGit(
    ["--no-optional-locks", "--no-pager", "-c", "core.fsmonitor=false", ...args],
    options,
  );
}
const blameCache = new LRUCache<string, Promise<EditorGitBlame>>({ max: 16, ttl: 5000 });
const detailsCache = new LRUCache<string, Promise<EditorGitCommitDetails>>({
  max: 64,
  ttl: 60_000,
});

async function disabledGitFilters(cwd: string): Promise<string[]> {
  const configured = await git(
    ["config", "--null", "--name-only", "--get-regexp", "^filter\\..*\\.(clean|process|required)$"],
    { cwd, acceptExitCodes: [0, 1], timeout: 10_000, maxOutputBytes: 64 * 1024 },
  );
  if (configured.truncated)
    throw new Error("Git filter configuration is too large to safely read line history");
  const prefixes = new Set<string>();
  for (const key of configured.stdout.split("\0")) {
    if (!key) continue;
    if (key.includes("=") || key.includes("\ufffd"))
      throw new Error("Git filter configuration cannot be safely overridden");
    prefixes.add(key.replace(/\.(clean|process|required)$/, ""));
  }
  if (prefixes.size > 128)
    throw new Error("Too many configured Git filters to safely read line history");
  return [...prefixes].flatMap((prefix) => [
    "-c",
    `${prefix}.clean=`,
    "-c",
    `${prefix}.process=`,
    "-c",
    `${prefix}.required=false`,
  ]);
}

async function scopedFile(root: string, filename: string) {
  if (path.isAbsolute(filename) || filename.includes("\0"))
    throw new Error("Git annotation paths must be workspace-relative");
  const canonicalRoot = await realpath(root);
  const file = await realpath(path.resolve(canonicalRoot, filename));
  const relative = path.relative(canonicalRoot, file);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
    throw new Error("Git annotation file is outside the workspace");
  const info = await stat(file);
  if (!info.isFile()) throw new Error("Git annotations require a file");
  return { root: canonicalRoot, file, size: info.size };
}

export function parseEditorBlame(output: string, head: string): EditorGitBlame {
  const commits = new Map<string, EditorGitCommit>();
  const lines: Extract<EditorGitBlame, { kind: "ready" }>["lines"] = [];
  let current: { sha: string; line: number; originalLine: number } | null = null;
  let author = "";
  let email = "";
  let authoredAt = 0;
  let summary = "";
  for (const value of output.split("\n")) {
    const header = /^(\^?[0-9a-f]{40}|[0-9a-f]{64}) (\d+) (\d+)(?: \d+)?$/.exec(value);
    if (header) {
      current = {
        sha: header[1].replace(/^\^/, ""),
        originalLine: Number(header[2]),
        line: Number(header[3]),
      };
      author = "";
      email = "";
      authoredAt = 0;
      summary = "";
    } else if (current && value.startsWith("\t")) {
      if (!commits.has(current.sha))
        commits.set(current.sha, { sha: current.sha, author, email, authoredAt, summary });
      lines.push(current);
      current = null;
    } else if (current) {
      if (value.startsWith("author ")) author = value.slice(7);
      else if (value.startsWith("author-mail ")) email = value.slice(12).replace(/^<|>$/g, "");
      else if (value.startsWith("author-time ")) authoredAt = Number(value.slice(12)) * 1000;
      else if (value.startsWith("summary ")) summary = value.slice(8);
    }
  }
  return { kind: "ready", head, commits: [...commits.values()], lines };
}

export async function getEditorFileBlame({
  root,
  filename,
  content,
}: {
  root: string;
  filename: string;
  content: string;
}): Promise<EditorGitBlame> {
  if (Buffer.byteLength(content) > 1024 * 1024 || content.split("\n").length > 20_000)
    return { kind: "unavailable", reason: "too_large" };
  const file = await scopedFile(root, filename);
  if (file.size > 1024 * 1024) return { kind: "unavailable", reason: "too_large" };
  const repository = await git(["rev-parse", "--show-toplevel"], {
    cwd: file.root,
    acceptExitCodes: [0, 128],
    timeout: 10_000,
  });
  if (repository.exitCode !== 0) {
    if (/not a git repository/i.test(repository.stderr))
      return { kind: "unavailable", reason: "not_git" };
    throw new Error(repository.stderr || "Unable to read Git repository");
  }
  const cwd = repository.stdout.trim();
  const relative = path.relative(cwd, file.file).split(path.sep).join("/");
  const head = await git(["rev-parse", "--verify", "HEAD"], {
    cwd,
    acceptExitCodes: [0, 128],
    timeout: 10_000,
  });
  if (head.exitCode !== 0) return { kind: "unavailable", reason: "unborn" };
  const sha = gitObjectIdSchema.parse(head.stdout.trim());
  const tracked = await git(["ls-files", "--error-unmatch", "--", relative], {
    cwd,
    acceptExitCodes: [0, 1],
    timeout: 10_000,
  });
  if (tracked.exitCode !== 0) return { kind: "unavailable", reason: "untracked" };
  const key = JSON.stringify([
    cwd,
    relative,
    sha,
    createHash("sha256").update(content).digest("hex"),
  ]);
  const cached = blameCache.get(key);
  if (cached) return cached;
  const pending = disabledGitFilters(cwd)
    .then((filters) =>
      git(
        [
          ...filters,
          "blame",
          "--line-porcelain",
          "--no-textconv",
          "--contents",
          "-",
          "--",
          relative,
        ],
        { cwd, input: content, timeout: 10_000, maxOutputBytes: 8 * 1024 * 1024 },
      ),
    )
    .then(async (result): Promise<EditorGitBlame> => {
      if (result.truncated) return { kind: "unavailable", reason: "too_large" };
      const currentHead = await git(["rev-parse", "--verify", "HEAD"], { cwd, timeout: 10_000 });
      if (currentHead.stdout.trim() !== sha)
        throw new Error(
          "Git HEAD changed while reading line history. Refresh Git history to try again.",
        );
      const blame = parseEditorBlame(result.stdout, sha);
      return Buffer.byteLength(JSON.stringify(blame)) > 4 * 1024 * 1024
        ? { kind: "unavailable", reason: "too_large" }
        : blame;
    });
  blameCache.set(key, pending);
  void pending.catch(() => {
    if (blameCache.get(key) === pending) blameCache.delete(key);
  });
  return pending;
}

function commitWebUrl(
  remote: string | null,
  forge: ForgeResolution | null,
  sha: string,
): string | null {
  if (!remote || !forge) return null;
  const location = parseGitRemoteLocation(remote);
  if (!location) return null;
  const protocol = location.transport === "http" ? "http" : "https";
  const port =
    (location.transport === "http" || location.transport === "https") && location.port
      ? `:${location.port}`
      : "";
  const base = `${protocol}://${forge.host}${port}/${location.path.split("/").map(encodeURIComponent).join("/")}`;
  if (forge.forge === "gitlab") return `${base}/-/commit/${sha}`;
  if (["github", "gitea", "forgejo", "codeberg"].includes(forge.forge))
    return `${base}/commit/${sha}`;
  return null;
}

export async function getEditorCommitDetails({
  root,
  filename,
  sha,
  resolveForge,
}: {
  root: string;
  filename: string;
  sha: string;
  resolveForge(cwd: string): Promise<ForgeResolution | null>;
}): Promise<EditorGitCommitDetails> {
  gitObjectIdSchema.parse(sha);
  if (/^0+$/.test(sha)) throw new Error("Uncommitted lines have no commit details");
  const file = await scopedFile(root, filename);
  const remote = await defaultResolveRemoteUrl(file.root);
  const key = JSON.stringify([file.root, file.file, sha, remote]);
  const previous = detailsCache.get(key);
  if (previous) return previous;
  const pending: Promise<EditorGitCommitDetails> = (async (): Promise<EditorGitCommitDetails> => {
    const result = await git(
      ["show", "-s", "--format=%H%x00%an%x00%ae%x00%at%x00%P%x00%B", sha, "--"],
      { cwd: file.root, timeout: 10_000, maxOutputBytes: 128 * 1024 },
    );
    const [oid, author, email, timestamp, parents, ...body] = result.stdout.split("\0");
    const message = body.join("\0").trim();
    const patch = await git(
      [
        "show",
        "--format=",
        "--no-ext-diff",
        "--no-textconv",
        "--unified=3",
        sha,
        "--",
        path.relative(file.root, file.file).split(path.sep).join("/"),
      ],
      { cwd: file.root, timeout: 10_000, maxOutputBytes: 64 * 1024 },
    );
    let url: string | null = null;
    let pullRequest: EditorGitCommitDetails["pullRequest"] = null;
    let pullRequestError: string | null = null;
    let authorProfile: Awaited<ReturnType<typeof getEditorCommitAuthor>> = {};
    try {
      const forge = await resolveForge(file.root);
      url = commitWebUrl(remote, forge, sha);
      if (forge) {
        const results = await Promise.all([
          forge.service.getPullRequestForCommit?.({ cwd: file.root, sha }) ?? null,
          getEditorCommitAuthor(forge, file.root, sha),
        ]);
        pullRequest = results[0];
        authorProfile = results[1];
      }
    } catch (error) {
      let reason = error instanceof Error ? error.message : "Unable to load pull request details";
      if (error instanceof ForgeCommandError || error instanceof ForgeAuthenticationError)
        reason = error.stderr || error.message;
      pullRequestError = reason.slice(0, 500);
    }
    return {
      commit: {
        sha: gitObjectIdSchema.parse(oid),
        author,
        email,
        authoredAt: Number(timestamp) * 1000,
        summary: message.split("\n")[0] ?? "",
      },
      message,
      parents: parents ? parents.split(" ") : [],
      patch: patch.stdout,
      url,
      pullRequest,
      pullRequestError,
      ...authorProfile,
    };
  })().then((details) => {
    if (details.pullRequestError && detailsCache.get(key) === pending) detailsCache.delete(key);
    return details;
  });
  detailsCache.set(key, pending);
  void pending.catch(() => {
    if (detailsCache.get(key) === pending) detailsCache.delete(key);
  });
  return pending;
}
