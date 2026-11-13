import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { defineExtension, type MixerAutomationsAPI, type Workspace, type WorkspaceArtifact, type WorkspaceArtifactFile, type WorkspaceContext } from "@mixer/automations-sdk";

const configSchema = z.object({
  git: z.string().default("git"),
  cloneBaseUrl: z.string().url().default("https://github.com"),
  cloneToken: z.string().min(1).optional(),
  cleanup: z.boolean().default(true),
});

interface FileInfo {
  sha256: string;
  mode: string;
  size: number;
  type: "file" | "symlink";
}

interface WorktreeMetadata {
  cache: string;
  repository: string;
  remote: string;
  baseRevision: string;
  gitConfigHash: string;
  baseFiles: Record<string, FileInfo>;
}

const cacheLocks = new Map<string, Promise<void>>();

async function withCacheLock<T>(cache: string, operation: () => Promise<T>): Promise<T> {
  const previous = cacheLocks.get(cache) ?? Promise.resolve();
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const tail = previous.then(() => held);
  cacheLocks.set(cache, tail);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (cacheLocks.get(cache) === tail) cacheLocks.delete(cache);
  }
}

function digest(value: string | Buffer): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function relative(root: string, item: string): string {
  return path.relative(root, item).split(path.sep).join("/");
}

function files(root: string): Map<string, FileInfo & { content: Buffer }> {
  const result = new Map<string, FileInfo & { content: Buffer }>();
  const visit = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = path.join(directory, entry.name);
      if (entry.name === ".git") continue;
      const stat = fs.lstatSync(absolute);
      if (stat.isDirectory()) visit(absolute);
      else if (stat.isSymbolicLink()) {
        const content = Buffer.from(fs.readlinkSync(absolute));
        result.set(relative(root, absolute), {
          sha256: digest(content), mode: "120000", size: content.length, type: "symlink", content,
        });
      } else if (stat.isFile()) {
        const content = fs.readFileSync(absolute);
        result.set(relative(root, absolute), {
          sha256: digest(content), mode: (stat.mode & 0o777).toString(8), size: stat.size, type: "file", content,
        });
      } else {
        throw new Error(`Workspace artifact rejects special file: ${relative(root, absolute)}`);
      }
    }
  };
  visit(root);
  return result;
}

function baseline(value: Map<string, FileInfo & { content: Buffer }>): Record<string, FileInfo> {
  return Object.fromEntries([...value.entries()].map(([name, item]) => [name, {
    sha256: item.sha256, mode: item.mode, size: item.size, type: item.type,
  }]));
}

function artifactFor(workspace: string, metadata: WorktreeMetadata): WorkspaceArtifact {
  const current = files(workspace);
  const changed: WorkspaceArtifactFile[] = [];
  for (const [name, item] of current) {
    const old = metadata.baseFiles[name];
    if (item.type === "symlink" || old?.type === "symlink") {
      if (old?.type !== "symlink" || item.type !== "symlink" || old.sha256 !== item.sha256) {
        throw new Error(`Workspace artifact rejects changed symlink: ${name}`);
      }
      continue;
    }
    if (!old || old.sha256 !== item.sha256 || old.mode !== item.mode) {
      changed.push({
        path: name, operation: old ? "update" : "add", mode: item.mode, size: item.size,
        sha256: item.sha256, content: item.content.toString("base64"),
      });
    }
  }
  for (const name of Object.keys(metadata.baseFiles).sort()) {
    if (!current.has(name)) {
      if (metadata.baseFiles[name]!.type === "symlink") throw new Error(`Workspace artifact rejects changed symlink: ${name}`);
      changed.push({ path: name, operation: "delete", mode: metadata.baseFiles[name]!.mode, size: 0 });
    }
  }
  changed.sort((a, b) => a.path.localeCompare(b.path));
  const unsigned = { version: 1 as const, baseRevision: metadata.baseRevision, files: changed };
  return { ...unsigned, hash: digest(stable(unsigned)) };
}

async function command(api: MixerAutomationsAPI, git: string, args: string[], signal?: AbortSignal): Promise<string> {
  const result = await api.process.run({ command: git, args, signal });
  if (result.exitCode !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr || result.stdout}`);
  return result.stdout.trim();
}

export default defineExtension({
  name: "worktree",
  version: "0.2.0",
  setup(api) {
    const config = configSchema.parse(api.config.get());
    const cloneOrigin = new URL(config.cloneBaseUrl).origin;
    // The trusted workspace provider may reuse the same PAT as the GitHub
    // extension. It is injected only into the git subprocess and never into
    // the agent execution environment.
    const cloneToken = config.cloneToken ?? process.env.GITHUB_TOKEN;
    const cloneAuth = cloneToken ? {
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: `http.${cloneOrigin}/.extraheader`,
      GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`x-access-token:${cloneToken}`).toString("base64")}`,
    } : undefined;
    const createWorkspace = async (context: WorkspaceContext): Promise<Workspace> => {
      if (!context.repository) throw new Error("worktree requires a repository");
      const source = context.source?.repository ?? context.repository;
      const cacheRoot = path.join(api.paths.workspaces, ".cache");
      const cache = path.join(cacheRoot, `${source.replace("/", "--")}.git`);
      const target = path.join(api.paths.workspaces, context.run.id);
      const remote = `${config.cloneBaseUrl.replace(/\/$/, "")}/${source}.git`;
      const revision = context.source?.revision;
      if (revision && !/^[0-9a-f]{40}$/.test(revision)) throw new Error("Workspace source revision must be a full lowercase commit SHA");
      fs.mkdirSync(cacheRoot, { recursive: true });

      const cloneMirror = async (destination: string): Promise<void> => {
        const clone = await api.process.run({
          command: config.git,
          args: ["clone", "--mirror", remote, destination],
          env: cloneAuth,
          signal: context.signal,
        });
        if (clone.exitCode !== 0) {
          if (fs.existsSync(destination)) fs.rmSync(destination, { recursive: true, force: true });
          throw new Error(`git clone failed: ${clone.stderr || clone.stdout}`);
        }
      };
      const checkout = async (mirror: string): Promise<string> => {
        if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true });
        const clone = await api.process.run({ command: config.git, args: ["clone", "--no-hardlinks", "--no-checkout", mirror, target], signal: context.signal });
        if (clone.exitCode !== 0) throw new Error(`git workspace clone failed: ${clone.stderr || clone.stdout}`);
        await command(api, config.git, ["-C", target, "checkout", "--detach", revision ?? "HEAD"], context.signal);
        const actualRevision = await command(api, config.git, ["-C", target, "rev-parse", "HEAD"], context.signal);
        if (revision && actualRevision !== revision) throw new Error("Workspace checkout did not reach the requested revision");
        return actualRevision;
      };
      const replaceCache = (replacement: string): void => {
        const backup = `${cache}.replaced-${context.run.id}-${crypto.randomUUID()}`;
        fs.renameSync(cache, backup);
        try {
          fs.renameSync(replacement, cache);
        } catch (error) {
          fs.renameSync(backup, cache);
          throw error;
        }
        try {
          fs.rmSync(backup, { recursive: true, force: true });
        } catch (error) {
          context.logger.warn({ repository: source, error: error instanceof Error ? error.message : String(error) }, "Replaced Git mirror cache backup could not be removed");
        }
      };

      let actualRevision: string;
      try {
        actualRevision = await withCacheLock(cache, async () => {
          const hadCache = fs.existsSync(cache);
          if (!hadCache) {
            await cloneMirror(cache);
            return checkout(cache);
          }
          try {
            const fetch = await api.process.run({ command: config.git, args: ["--git-dir", cache, "fetch", "--prune"], env: cloneAuth, signal: context.signal });
            if (fetch.exitCode !== 0) throw new Error(`git fetch failed: ${fetch.stderr || fetch.stdout}`);
            return await checkout(cache);
          } catch (error) {
            if (context.signal.aborted) throw error;
            const initial = error instanceof Error ? error.message : String(error);
            const replacement = `${cache}.rebuild-${context.run.id}-${crypto.randomUUID()}`;
            context.logger.warn({ repository: source, error: initial }, "Rebuilding unusable Git mirror cache");
            try {
              await cloneMirror(replacement);
              const checkedOutRevision = await checkout(replacement);
              replaceCache(replacement);
              return checkedOutRevision;
            } catch (rebuildError) {
              const rebuilt = rebuildError instanceof Error ? rebuildError.message : String(rebuildError);
              throw new Error(`Git workspace preparation failed using cached mirror: ${initial}; mirror rebuild failed: ${rebuilt}`);
            } finally {
              if (fs.existsSync(replacement)) fs.rmSync(replacement, { recursive: true, force: true });
            }
          }
        });

        // Give the harness the same normal Git/GitHub remote it would have in a
        // manually cloned checkout. Authentication remains the user's Git/gh setup.
        await command(api, config.git, ["-C", target, "remote", "set-url", "origin", remote], context.signal);
        await api.process.run({ command: config.git, args: ["-C", target, "config", "--local", "--unset-all", "core.hooksPath"], signal: context.signal });
        const gitConfig = path.join(target, ".git", "config");
        const metadata: WorktreeMetadata = { cache, repository: source, remote, baseRevision: actualRevision, gitConfigHash: digest(fs.readFileSync(gitConfig)), baseFiles: baseline(files(target)) };
        return { path: target, metadata: metadata as unknown as import("@mixer/automations-sdk").JsonValue };
      } catch (error) {
        if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true });
        throw error;
      }
    };
    api.workspaces.register("worktree", {
      create: createWorkspace,
      async attest(context, workspace) {
        const root = fs.realpathSync(workspace.path);
        const workspaces = fs.realpathSync(api.paths.workspaces);
        const relativePath = path.relative(workspaces, root);
        if (!relativePath || relativePath.startsWith("..") || path.isAbsolute(relativePath) || relativePath !== context.run.id) {
          throw new Error("Workspace path is not the run's disposable checkout");
        }
        const metadata = workspace.metadata as unknown as WorktreeMetadata | undefined;
        if (!metadata?.baseRevision || !metadata.repository || !metadata.remote || !metadata.gitConfigHash) throw new Error("Workspace provenance is missing");
        const topLevel = fs.realpathSync(await command(api, config.git, ["-C", root, "rev-parse", "--show-toplevel"], context.signal));
        if (topLevel !== root) throw new Error("Workspace Git root does not match its effective path");
        const configPath = path.join(root, ".git", "config");
        if (!fs.existsSync(configPath)) throw new Error("Workspace Git configuration is missing");
        const remote = await command(api, config.git, ["-C", root, "remote", "get-url", "origin"], context.signal);
        if (remote !== metadata.remote) throw new Error("Workspace origin does not match the activated repository");
        const revision = await command(api, config.git, ["-C", root, "rev-parse", "HEAD"], context.signal);
        const status = await command(api, config.git, ["-C", root, "status", "--porcelain=v1", "--untracked-files=all"], context.signal);
        const branchResult = await api.process.run({
          command: config.git, args: ["-C", root, "symbolic-ref", "--quiet", "--short", "HEAD"], signal: context.signal,
        });
        return {
          version: 1 as const,
          path: root,
          repository: metadata.repository,
          revision,
          ...(branchResult.exitCode === 0 && branchResult.stdout.trim() ? { branch: branchResult.stdout.trim() } : {}),
          remote,
          clean: status.length === 0,
          verifiedAt: new Date().toISOString(),
        };
      },
      reset: (context) => createWorkspace(context),
      async collect(context, workspace) {
        const metadata = workspace.metadata as unknown as WorktreeMetadata | undefined;
        if (!metadata?.baseRevision || !metadata.gitConfigHash || !metadata.baseFiles) throw new Error("Worktree provenance is missing");
        const configPath = path.join(workspace.path, ".git", "config");
        if (!fs.existsSync(configPath) || digest(fs.readFileSync(configPath)) !== metadata.gitConfigHash) throw new Error("Workspace Git configuration was modified");
        const artifact = artifactFor(workspace.path, metadata);
        context.logger.info({ hash: artifact.hash, files: artifact.files.length }, "Workspace artifact collected");
        return artifact;
      },
      async cleanup(_context, workspace) {
        if (config.cleanup && fs.existsSync(workspace.path)) fs.rmSync(workspace.path, { recursive: true, force: true });
      },
    });
  },
});
