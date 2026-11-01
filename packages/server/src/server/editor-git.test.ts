import {
  access,
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createRunGitCommand } from "../utils/run-git-command.js";
import { createGitHubService } from "../services/github-service.js";
import { getEditorFileBlame, getEditorCommitDetails } from "./editor-git.js";
import { getEditorCommitAuthor } from "./editor-git-avatar.js";

const git = createRunGitCommand("editor-git-test");
const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

it("loads the commit author's avatar through GitHub and returns bounded inline image data", async () => {
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aYZkAAAAASUVORK5CYII=",
    "base64",
  );
  const fetchImage = vi.fn(
    async () => new Response(png, { headers: { "content-type": "image/png" } }),
  );
  vi.stubGlobal("fetch", fetchImage);
  const calls: string[][] = [];
  const service = createGitHubService({
    resolveGhPath: async () => "/test/gh",
    resolveRepoHost: async () => "github.example.test",
    resolveRepoSlug: async () => "org/repo",
    runner: async (args) => {
      calls.push(args);
      return {
        stdout: JSON.stringify({
          data: {
            repository: {
              object: {
                author: {
                  avatarUrl: "https://avatars.githubusercontent.com/u/123?s=64",
                  user: { url: "https://github.example.test/alice" },
                },
              },
            },
          },
        }),
        stderr: "",
      };
    },
  });
  expect(
    await getEditorCommitAuthor(
      { forge: "github", host: "github.example.test", service },
      "/test/repo",
      "a".repeat(40),
    ),
  ).toEqual({
    authorAvatar: `data:image/png;base64,${png.toString("base64")}`,
    authorProfileUrl: "https://github.example.test/alice",
  });
  expect(calls[0]).toContain(`sha=${"a".repeat(40)}`);
  expect(fetchImage).toHaveBeenCalledOnce();
});

it.each([
  "http://avatars.githubusercontent.com/u/1",
  "https://evil.example/track",
  "https://avatars.githubusercontent.com:8443/u/1",
])("does not fetch an unsafe avatar URL %s", async (avatarUrl) => {
  const fetchImage = vi.fn();
  vi.stubGlobal("fetch", fetchImage);
  const service = createGitHubService({
    resolveGhPath: async () => "/test/gh",
    resolveRepoHost: async () => null,
    resolveRepoSlug: async () => "org/repo",
    runner: async () => ({
      stdout: JSON.stringify({
        data: { repository: { object: { author: { avatarUrl, user: null } } } },
      }),
      stderr: "",
    }),
  });
  expect(
    await getEditorCommitAuthor(
      { forge: "github", host: "github.com", service },
      "/test/repo",
      "a".repeat(40),
    ),
  ).toEqual({});
  expect(fetchImage).not.toHaveBeenCalled();
});

it.each([
  ["image/svg+xml", "<svg onload='alert(1)'/>"],
  ["image/png", "not an image"],
  ["image/png", "x".repeat(128 * 1024 + 1)],
])("does not return unsafe or oversized %s avatar content", async (type, body) => {
  vi.stubGlobal("fetch", async () => new Response(body, { headers: { "content-type": type } }));
  const service = createGitHubService({
    resolveGhPath: async () => "/test/gh",
    resolveRepoHost: async () => null,
    resolveRepoSlug: async () => "org/repo",
    runner: async () => ({
      stdout: JSON.stringify({
        data: {
          repository: {
            object: {
              author: { avatarUrl: "https://avatars.githubusercontent.com/u/123", user: null },
            },
          },
        },
      }),
      stderr: "",
    }),
  });
  expect(
    (
      await getEditorCommitAuthor(
        { forge: "github", host: "github.com", service },
        "/test/repo",
        "a".repeat(40),
      )
    ).authorAvatar,
  ).toBeUndefined();
});
async function repository() {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "mixer-editor-git-")));
  roots.push(root);
  await git(["init", "-b", "main"], { cwd: root });
  await git(["config", "user.name", "Alice"], { cwd: root });
  await git(["config", "user.email", "alice@example.test"], { cwd: root });
  await git(["config", "commit.gpgsign", "false"], { cwd: root });
  await git(["config", "maintenance.auto", "false"], { cwd: root });
  await git(["config", "gc.auto", "0"], { cwd: root });
  return root;
}
async function commit(root: string, message: string) {
  await git(["add", "--all"], { cwd: root });
  await git(["commit", "-m", message], { cwd: root });
  return (await git(["rev-parse", "HEAD"], { cwd: root })).stdout.trim();
}

it("attributes the editor's unsaved contents, including inserted lines, without writing the working tree", async () => {
  const root = await repository();
  await writeFile(path.join(root, "file.ts"), "first\nsecond\nthird\n");
  const first = await commit(root, "Initial implementation");
  await git(["config", "user.name", "Bob"], { cwd: root });
  await git(["config", "user.email", "bob@example.test"], { cwd: root });
  await writeFile(path.join(root, "file.ts"), "first\nchanged\nthird\n");
  const second = await commit(root, "Change the second line");
  const result = await getEditorFileBlame({
    root,
    filename: "file.ts",
    content: "inserted\nfirst\nchanged\nthird\n",
  });
  if (result.kind !== "ready") throw new Error("Expected file blame");
  expect(result.head).toBe(second);
  expect(result.lines.map((line) => [line.line, line.originalLine, line.sha])).toEqual([
    [1, 1, "0".repeat(40)],
    [2, 1, first],
    [3, 2, second],
    [4, 3, first],
  ]);
  expect(result.commits.find((entry) => entry.sha === first)?.author).toBe("Alice");
  expect(result.commits.find((entry) => entry.sha === second)?.author).toBe("Bob");
  expect(await readFile(path.join(root, "file.ts"), "utf8")).toBe("first\nchanged\nthird\n");
});

it("handles non-repositories, unborn branches, untracked files, and large buffers without fabricated authors", async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "mixer-editor-no-git-")));
  roots.push(root);
  await writeFile(path.join(root, "file.ts"), "text\n");
  expect(await getEditorFileBlame({ root, filename: "file.ts", content: "text\n" })).toEqual({
    kind: "unavailable",
    reason: "not_git",
  });
  const repo = await repository();
  await writeFile(path.join(repo, "file.ts"), "text\n");
  expect(await getEditorFileBlame({ root: repo, filename: "file.ts", content: "text\n" })).toEqual({
    kind: "unavailable",
    reason: "unborn",
  });
  await commit(repo, "Track file");
  await writeFile(path.join(repo, "new.ts"), "new\n");
  expect(await getEditorFileBlame({ root: repo, filename: "new.ts", content: "new\n" })).toEqual({
    kind: "unavailable",
    reason: "untracked",
  });
  expect(
    await getEditorFileBlame({ root: repo, filename: "file.ts", content: "\n".repeat(20_001) }),
  ).toEqual({ kind: "unavailable", reason: "too_large" });
});

it("invalidates cached authorship when HEAD changes even if the buffer is identical", async () => {
  const root = await repository();
  const content = "const value = 1;\n";
  await writeFile(path.join(root, "file.ts"), content);
  await commit(root, "Original author");
  const first = await getEditorFileBlame({ root, filename: "file.ts", content });
  await git(
    [
      "-c",
      "user.name=Bob",
      "-c",
      "user.email=bob@example.test",
      "commit",
      "--amend",
      "--no-edit",
      "--reset-author",
    ],
    { cwd: root },
  );
  const second = await getEditorFileBlame({ root, filename: "file.ts", content });
  if (first.kind !== "ready" || second.kind !== "ready") throw new Error("Expected file blame");
  expect(second.head).not.toBe(first.head);
  expect(second.commits.map((entry) => entry.author)).toEqual(["Bob"]);
});

it("does not execute repository filters or fsmonitor helpers while blaming editor contents", async () => {
  const root = await repository();
  const content = "const value = 1;\n";
  await writeFile(path.join(root, "file.ts"), content);
  await commit(root, "Read-only history");
  const marker = path.join(root, "filter-executed");
  await writeFile(path.join(root, ".gitattributes"), "file.ts filter=probe\n");
  await git(["config", "filter.probe.clean", `touch "${marker}"; cat`], { cwd: root });
  await git(["config", "filter.probe.process", `touch "${marker}"; exit 1`], { cwd: root });
  await git(["config", "filter.probe.required", "true"], { cwd: root });
  await git(["config", "core.fsmonitor", `touch "${marker}"`], { cwd: root });
  const result = await getEditorFileBlame({ root, filename: "file.ts", content });
  if (result.kind !== "ready") throw new Error("Expected file blame");
  expect(result.commits.map((entry) => entry.author)).toEqual(["Alice"]);
  await expect(access(marker)).rejects.toThrow();
});

it("keeps local commit details available when forge enrichment fails", async () => {
  const root = await repository();
  await writeFile(path.join(root, "file.ts"), "const value = 1;\n");
  const sha = await commit(root, "Local history survives");
  const details = await getEditorCommitDetails({
    root,
    filename: "file.ts",
    sha,
    resolveForge: async () => {
      throw new Error("Forge temporarily unavailable");
    },
  });
  expect(details.commit.author).toBe("Alice");
  expect(details.message).toBe("Local history survives");
  expect(details.patch).toContain("+const value = 1;");
  expect(details.pullRequest).toBeNull();
  expect(details.pullRequestError).toBe("Forge temporarily unavailable");
  const retried = await getEditorCommitDetails({
    root,
    filename: "file.ts",
    sha,
    resolveForge: async () => null,
  });
  expect(retried.pullRequestError).toBeNull();
  expect(retried.commit.author).toBe("Alice");
});

it("supports Unicode and spaced paths and rejects files outside the workspace", async () => {
  const root = await repository();
  await mkdir(path.join(root, "fólder"));
  const filename = "fólder/file with spaces.ts";
  await writeFile(path.join(root, filename), "const value = 1;\n");
  await commit(root, "Unicode path");
  const result = await getEditorFileBlame({ root, filename, content: "const value = 1;\n" });
  expect(result.kind).toBe("ready");
  const outside = await realpath(await mkdtemp(path.join(tmpdir(), "mixer-git-outside-")));
  roots.push(outside);
  await writeFile(path.join(outside, "secret.ts"), "private\n");
  await symlink(outside, path.join(root, "escape"), "junction");
  await expect(
    getEditorFileBlame({ root, filename: "escape/secret.ts", content: "private\n" }),
  ).rejects.toThrow("outside the workspace");
  await expect(
    getEditorFileBlame({ root, filename: path.join(outside, "secret.ts"), content: "private\n" }),
  ).rejects.toThrow("workspace-relative");
});

it("returns full commit details and a commit-associated PR through the configured forge adapter", async () => {
  const root = await repository();
  await writeFile(path.join(root, "file.ts"), "const value = 1;\n");
  const sha = await commit(
    root,
    "Implement value (#113)\n\nCo-authored-by: Bob <bob@example.test>",
  );
  await git(["remote", "add", "origin", "git@github.com:example/project.git"], { cwd: root });
  const calls: string[][] = [];
  const service = createGitHubService({
    resolveGhPath: async () => "/test/gh",
    resolveRepoHost: async () => null,
    resolveRepoSlug: async () => "example/project",
    runner: async (args) => {
      calls.push(args);
      return {
        stdout: JSON.stringify({
          data: {
            repository: {
              object: {
                associatedPullRequests: {
                  nodes: [
                    {
                      number: 113,
                      title: "Implement value",
                      url: "https://github.com/example/project/pull/113",
                      state: "MERGED",
                    },
                  ],
                },
              },
            },
          },
        }),
        stderr: "",
      };
    },
  });
  const details = await getEditorCommitDetails({
    root,
    filename: "file.ts",
    sha,
    resolveForge: async () => ({ forge: "github", host: "github.com", service }),
  });
  expect(details.commit.author).toBe("Alice");
  expect(details.message).toBe("Implement value (#113)\n\nCo-authored-by: Bob <bob@example.test>");
  expect(details.patch).toContain("+const value = 1;");
  expect(details.url).toBe(`https://github.com/example/project/commit/${sha}`);
  expect(details.pullRequest).toEqual({
    number: 113,
    title: "Implement value",
    url: "https://github.com/example/project/pull/113",
    state: "MERGED",
  });
  expect(calls[0]).toContain(`sha=${sha}`);
});
