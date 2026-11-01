import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolveRipgrepPath } from "@mixer/plugin/server";
import { searchWorkspace, MAX_RESULTS } from "./search.js";
import { splitGlobs, searchRpc, searchScopeKey, type SearchOptions } from "../shared/search.js";

const execute = promisify(execFile);
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })),
  );
});
const defaults: SearchOptions = {
  query: "needle",
  caseSensitive: false,
  regex: false,
  wholeWord: false,
  includes: "",
  excludes: "",
  respectIgnore: true,
};
it("accepts registered project search scope without inventing a workspace ID", () => {
  const identity = {
    channelId: "00000000-0000-4000-8000-000000000001",
    requestId: "00000000-0000-4000-8000-000000000002",
    options: defaults,
  };
  expect(searchRpc.input.parse({ ...identity, projectId: "project-a" })).toEqual({
    ...identity,
    projectId: "project-a",
  });
  expect(searchRpc.input.parse({ ...identity, workspaceId: "workspace-a" })).toEqual({
    ...identity,
    workspaceId: "workspace-a",
  });
  expect(searchScopeKey({ projectId: "same" })).toBe("project:same");
  expect(searchScopeKey({ workspaceId: "same" })).toBe("workspace:same");
  expect(() => searchRpc.input.parse(identity)).toThrow();
});
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "mixer-search-"));
  roots.push(root);
  await execute("git", ["init", "--quiet", root]);
  await mkdir(path.join(root, "src"));
  await mkdir(path.join(root, "node_modules"));
  await Promise.all([
    writeFile(path.join(root, ".gitignore"), "node_modules/\nignored.txt\n"),
    writeFile(path.join(root, "main.ts"), "needle Needle needles\nsecond needle\n"),
    writeFile(path.join(root, "component.tsx"), "needle\n"),
    writeFile(path.join(root, "src/unicode.ts"), "é🐈 needle\n"),
    writeFile(path.join(root, ".hidden.txt"), "needle\n"),
    writeFile(path.join(root, "ignored.txt"), "needle\n"),
    writeFile(path.join(root, "node_modules/dependency.txt"), "needle\n"),
    writeFile(path.join(root, ".git/private.txt"), "needle\n"),
    writeFile(path.join(root, "binary.bin"), Buffer.from([0, 0, 110, 101, 101, 100, 108, 101])),
  ]);
  const ripgrepPath = await resolveRipgrepPath();
  return {
    root,
    run: (options: Partial<SearchOptions> = {}, signal = new AbortController().signal) =>
      searchWorkspace({ root, ripgrepPath, options: { ...defaults, ...options }, signal }),
  };
}
describe("bundled workspace text search", () => {
  it("respects ignores, includes dotfiles, skips binaries and Git internals", async () => {
    const { run } = await fixture();
    const result = await run();
    expect(result.files.map((file) => file.path)).toEqual([
      ".hidden.txt",
      "component.tsx",
      "main.ts",
      "src/unicode.ts",
    ]);
    expect(result.count).toBe(7);
    expect(result.limited).toBe(false);
    expect(result.status).toBe("complete");
  });
  it("supports case, whole word, regex, and literal metacharacters", async () => {
    const { root, run } = await fixture();
    expect((await run({ includes: "main.ts", caseSensitive: true })).count).toBe(3);
    expect((await run({ includes: "main.ts", caseSensitive: true, wholeWord: true })).count).toBe(
      2,
    );
    expect(
      (await run({ includes: "main.ts", query: "needl(e|es)", regex: true, caseSensitive: true }))
        .count,
    ).toBe(3);
    expect((await run({ query: "(" })).count).toBe(0);
    await expect(run({ query: "(", regex: true })).rejects.toThrow(/regex parse error/);
    await writeFile(path.join(root, "--example.txt"), "--help\n");
    expect((await run({ query: "--help", includes: "--example.txt" })).count).toBe(1);
  });
  it("combines include and exclude globs without splitting brace expressions", async () => {
    const { run } = await fixture();
    expect(splitGlobs("src/**, **/*.{ts,tsx}")).toEqual(["src/**", "**/*.{ts,tsx}"]);
    expect(
      (await run({ includes: "**/*.{ts,tsx}", excludes: "src/**" })).files.map((file) => file.path),
    ).toEqual(["component.tsx", "main.ts"]);
    expect(() => splitGlobs("*.{ts,tsx")).toThrow("Unbalanced braces");
  });
  it("can include ignored files but never allows a filter to include .git metadata", async () => {
    const { run } = await fixture();
    expect((await run({ includes: "**/*.txt" })).files.map((file) => file.path)).toEqual([
      ".hidden.txt",
    ]);
    const result = await run({ respectIgnore: false, includes: "**/*.txt" });
    expect(result.files.map((file) => file.path)).toEqual([
      ".hidden.txt",
      "ignored.txt",
      "node_modules/dependency.txt",
    ]);
  });
  it("converts ripgrep's UTF-8 offsets to editor columns and bounded highlighted previews", async () => {
    const { run } = await fixture();
    const result = await run({ includes: "src/unicode.ts" });
    expect(result.files).toEqual([
      {
        path: "src/unicode.ts",
        matches: [{ line: 1, column: 5, preview: "é🐈 needle", start: 4, end: 10 }],
      },
    ]);
  });
  it("terminates cancelled searches and caps large result sets", async () => {
    const { root, run } = await fixture();
    await writeFile(path.join(root, "many.txt"), "needle\n".repeat(MAX_RESULTS + 50));
    const controller = new AbortController();
    const pending = run({}, controller.signal);
    controller.abort();
    expect((await pending).status).toBe("cancelled");
    const result = await run({ includes: "many.txt" });
    expect(result.count).toBe(MAX_RESULTS);
    expect(result.limited).toBe(true);
    expect(result.limitReason).toBe("results");
  });
  it("skips files over the size budget", async () => {
    const { root, run } = await fixture();
    await writeFile(path.join(root, "large.txt"), "needle\n".repeat(310_000));
    expect((await run({ includes: "large.txt" })).count).toBe(0);
  });
  it("honors .gitignore in folders without a Git repository", async () => {
    const { root, run } = await fixture();
    await rm(path.join(root, ".git"), { recursive: true, force: true });
    const result = await run();
    expect(result.files.map((file) => file.path)).not.toContain("node_modules/dependency.txt");
    expect(result.files.map((file) => file.path)).not.toContain("ignored.txt");
  });
  it.skipIf(process.platform === "win32")(
    "does not traverse symlinks outside the workspace",
    async () => {
      const { root, run } = await fixture();
      const outside = await mkdtemp(path.join(tmpdir(), "mixer-search-outside-"));
      roots.push(outside);
      await writeFile(path.join(outside, "outside.txt"), "private-needle\n");
      await symlink(outside, path.join(root, "outside"));
      expect((await run({ query: "private-needle", respectIgnore: false })).count).toBe(0);
    },
  );
});
