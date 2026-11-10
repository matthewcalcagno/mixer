import { primaryRemoteAction } from "../client/primary-remote-action.js";
import { test } from "vitest";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git, status, diff, selectHunk, validatePaths, parseFiles } from "../server/git.js";
import { optimisticStatus } from "../shared/optimistic.js";
import { getFileIconSvg } from "../client/vendor/file-icon-svg.js";
import { executeGitAction } from "../server/action.js";
import { statusRpc, actionRpc, documentRpc } from "../shared/git.js";
import {
  conflictLabel,
  resourceGroups,
  resourceTree,
  visibleResources,
} from "../shared/resources.js";
import {
  actionResources,
  emptySelection,
  resourceKey,
  retainSelection,
  selectAllResources,
  selectResource,
  visibleResourceItems,
  type ResourceItem,
} from "../shared/selection.js";

test("SCM selection supports toggle and anchored ranges in displayed order", () => {
  const order = ["c", "a", "b", "d"];
  const first = selectResource({
    selection: emptySelection(),
    key: "a",
    order,
    gesture: "replace",
  });
  const range = selectResource({ selection: first, key: "d", order, gesture: "range" });
  assert.deepEqual([...range.keys], ["a", "b", "d"]);
  const reduced = selectResource({ selection: range, key: "b", order, gesture: "range" });
  assert.deepEqual([...reduced.keys], ["a", "b"]);
  const toggled = selectResource({ selection: reduced, key: "a", order, gesture: "toggle" });
  assert.deepEqual([...toggled.keys], ["b"]);
  const additive = selectResource({ selection: toggled, key: "c", order, gesture: "add-range" });
  assert.deepEqual([...additive.keys], ["b", "c", "a"]);
  assert.equal(additive.focus, "c");
  const all = selectAllResources(order, reduced);
  assert.deepEqual([...all.keys], ["c", "a", "b", "d"]);
  assert.equal(all.focus, "b");
  assert.equal(all.anchor, "a");
});

test("SCM selection separates partial staging sides and limits each batch to compatible resources", () => {
  const partial = { path: "partial.ts", index: "M", worktree: "M", head: "M" };
  const resources: ResourceItem[] = [
    { group: "staged", file: partial },
    { group: "changes", file: partial },
    { group: "changes", file: { path: "new.ts", index: "?", worktree: "?", head: "?" } },
    { group: "merge", file: { path: "conflict.ts", index: "U", worktree: "U", head: "U" } },
  ];
  const selection = selectAllResources(
    resources.map((item) => resourceKey(item.group, item.file.path)),
  );
  assert.equal(selection.keys.size, 4);
  assert.deepEqual(
    actionResources({ selection, resources, operation: "stage" }).map((item) => item.file.path),
    ["partial.ts", "new.ts", "conflict.ts"],
  );
  assert.deepEqual(
    actionResources({ selection, resources, operation: "unstage" }).map((item) => item.file.path),
    ["partial.ts"],
  );
  assert.deepEqual(
    actionResources({ selection, resources, operation: "discard" }).map((item) => item.file.path),
    ["partial.ts"],
  );
  const unselected: ResourceItem = {
    group: "changes",
    file: { path: "only-this.ts", index: " ", worktree: "M", head: "M" },
  };
  assert.deepEqual(
    actionResources({ selection, resources, context: unselected, operation: "stage" }).map(
      (item) => item.file.path,
    ),
    ["only-this.ts"],
  );
});

test("SCM selection removes hidden or refreshed resources without retaining a stale range anchor", () => {
  const selection = selectAllResources(["visible", "filtered", "removed"]);
  const selected = selectResource({
    selection,
    key: "removed",
    order: ["visible", "filtered", "removed"],
    gesture: "toggle",
  });
  const kept = retainSelection(selected, new Set(["visible"]));
  assert.deepEqual([...kept.keys], ["visible"]);
  assert.equal(kept.anchor, null);
  assert.equal(kept.focus, null);
  assert.equal(retainSelection(kept, new Set(["visible"])), kept);
});

test("SCM tree selection follows rendered folders and excludes collapsed descendants", () => {
  const files = [
    { path: "src/z.ts", index: " ", worktree: "M", head: "M" },
    { path: "root.ts", index: " ", worktree: "M", head: "M" },
    { path: "src/nested/a.ts", index: " ", worktree: "M", head: "M" },
  ];
  const nodes = resourceTree(files);
  assert.deepEqual(
    visibleResourceItems({ nodes, group: "changes", collapsedFolders: new Set() }).map(
      (item) => item.file.path,
    ),
    ["src/nested/a.ts", "src/z.ts", "root.ts"],
  );
  assert.deepEqual(
    visibleResourceItems({
      nodes,
      group: "changes",
      collapsedFolders: new Set([resourceKey("changes", "src/")]),
    }).map((item) => item.file.path),
    ["root.ts"],
  );
});

test("SCM selected batch staging and unstaging changes only the chosen paths", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "mixer-scm-batch-"));
  try {
    await git(cwd, ["init", "-b", "main"]);
    await git(cwd, ["config", "user.name", "SCM test"]);
    await git(cwd, ["config", "user.email", "scm@example.test"]);
    await git(cwd, ["config", "commit.gpgsign", "false"]);
    for (const file of ["a.txt", "b with spaces.txt", "untouched.txt"])
      await writeFile(join(cwd, file), "base\n");
    await git(cwd, ["add", "."]);
    await git(cwd, ["commit", "-m", "base"]);
    for (const file of ["a.txt", "b with spaces.txt", "untouched.txt"])
      await writeFile(join(cwd, file), "modified\n");
    const paths = ["a.txt", "b with spaces.txt"];
    await executeGitAction({
      cwd,
      revision: (await status(cwd)).revision,
      action: { kind: "stage", paths },
    });
    assert.deepEqual(
      resourceGroups((await status(cwd)).files).staged.map((file) => file.path),
      paths,
    );
    assert.deepEqual(
      resourceGroups((await status(cwd)).files).changes.map((file) => file.path),
      ["untouched.txt"],
    );
    await executeGitAction({
      cwd,
      revision: (await status(cwd)).revision,
      action: { kind: "unstage", paths },
    });
    assert.deepEqual(resourceGroups((await status(cwd)).files).staged, []);
    for (const file of [...paths, "untouched.txt"])
      assert.equal(await readFile(join(cwd, file), "utf8"), "modified\n");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("SCM contracts support project scope while retaining workspace callers", () => {
  assert.deepEqual(statusRpc.input.parse({ projectId: "project-a" }), { projectId: "project-a" });
  assert.deepEqual(statusRpc.input.parse({ workspaceId: "workspace-a" }), {
    workspaceId: "workspace-a",
  });
  const input = {
    projectId: "project-a",
    revision: "revision-a",
    action: { kind: "stage", paths: ["file.ts"] },
  };
  assert.deepEqual(actionRpc.input.parse(input), input);
  assert.deepEqual(
    documentRpc.input.parse({ projectId: "project-a", path: "file.ts", staged: false }),
    { projectId: "project-a", path: "file.ts", staged: false },
  );
  assert.throws(() => statusRpc.input.parse({}));
});

test("SCM combines tracked and untracked changes while separating conflicts and staging", () => {
  const files = [
    { path: "conflict.ts", index: "U", worktree: "U", head: "U" },
    { path: "partial.ts", index: "M", worktree: "M", head: "M" },
    { path: "new.ts", index: "?", worktree: "?", head: "?" },
  ];
  const groups = resourceGroups(files);
  assert.deepEqual(
    groups.merge.map((file) => file.path),
    ["conflict.ts"],
  );
  assert.deepEqual(
    groups.staged.map((file) => file.path),
    ["partial.ts"],
  );
  assert.deepEqual(
    groups.changes.map((file) => file.path),
    ["partial.ts", "new.ts"],
  );
  assert.deepEqual(Object.keys(groups), ["merge", "staged", "changes"]);
  assert.equal(conflictLabel(files[0]), "Both modified");
  for (const pair of ["DD", "AU", "UD", "UA", "DU", "AA", "UU"]) {
    assert.equal(
      resourceGroups([{ path: "file", index: pair[0], worktree: pair[1], head: "U" }]).staged
        .length,
      0,
    );
  }
});

test("SCM refuses conflicted commits and stale actions, then commits an explicitly staged resolution", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "mixer-scm-conflict-"));
  try {
    await git(cwd, ["init", "-b", "main"]);
    await git(cwd, ["config", "user.name", "SCM test"]);
    await git(cwd, ["config", "user.email", "scm@example.test"]);
    await git(cwd, ["config", "commit.gpgsign", "false"]);
    await writeFile(join(cwd, "file.txt"), "base\n");
    await git(cwd, ["add", "."]);
    await git(cwd, ["commit", "-m", "base"]);
    await git(cwd, ["checkout", "-b", "other"]);
    await writeFile(join(cwd, "file.txt"), "theirs\n");
    await git(cwd, ["commit", "-am", "theirs"]);
    await git(cwd, ["checkout", "main"]);
    await writeFile(join(cwd, "file.txt"), "ours\n");
    await git(cwd, ["commit", "-am", "ours"]);
    await assert.rejects(git(cwd, ["merge", "other"]));
    const conflicted = await status(cwd);
    assert.deepEqual(
      resourceGroups(conflicted.files).merge.map((file) => file.path),
      ["file.txt"],
    );
    await assert.rejects(
      executeGitAction({
        cwd,
        revision: conflicted.revision,
        action: { kind: "commit", message: "unsafe" },
      }),
      /Resolve merge conflicts/,
    );
    await writeFile(join(cwd, "file.txt"), "resolved\n");
    await assert.rejects(
      executeGitAction({
        cwd,
        revision: conflicted.revision,
        action: { kind: "stage", paths: ["file.txt"] },
      }),
      /Files changed/,
    );
    await executeGitAction({
      cwd,
      revision: (await status(cwd)).revision,
      action: { kind: "stage", paths: ["file.txt"] },
    });
    await executeGitAction({
      cwd,
      revision: (await status(cwd)).revision,
      action: { kind: "commit", message: "resolved merge" },
    });
    assert.equal((await git(cwd, ["log", "-1", "--format=%s"])).trim(), "resolved merge");
    assert.deepEqual((await status(cwd)).files, []);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("SCM filtering and sorting leave cached resources unchanged; tree folders own descendant paths", () => {
  const files = [
    { path: "src/z.ts", index: " ", worktree: "M", head: "M" },
    { path: "docs/a.md", index: " ", worktree: "D", head: "D" },
    { path: "src/nested/a.ts", index: "?", worktree: "?", head: "?" },
  ];
  assert.deepEqual(
    visibleResources(files, "SRC/", "name", false).map((file) => file.path),
    ["src/nested/a.ts", "src/z.ts"],
  );
  assert.deepEqual(visibleResources(files, "absent", "path", false), []);
  assert.equal(files[0].path, "src/z.ts");
  const tree = resourceTree(files);
  assert.deepEqual(
    tree.map((node) => (node.kind === "folder" ? node.name : node.file.path)),
    ["docs", "src"],
  );
  const folder = tree[1];
  assert.equal(folder.kind, "folder");
  if (folder.kind !== "folder") throw new Error("Expected source folder");
  assert.deepEqual(
    folder.files.map((file) => file.path),
    ["src/z.ts", "src/nested/a.ts"],
  );
});

test("file staging, partial staging, unstaging, discard, and exact commit messages", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "mixer-source-control-"));
  try {
    await git(cwd, ["init", "-b", "main"]);
    await git(cwd, ["config", "user.name", "Plugin test"]);
    await git(cwd, ["config", "user.email", "plugin@example.test"]);
    await git(cwd, ["config", "commit.gpgsign", "false"]);
    const original = Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n") + "\n";
    await writeFile(join(cwd, "sample.txt"), original);
    assert.equal((await status(cwd)).files[0]?.index, "?");
    await git(cwd, ["add", "--", "sample.txt"]);
    assert.equal((await status(cwd)).files[0]?.index, "A");
    await git(cwd, ["commit", "-m", "initial"]);
    await writeFile(
      join(cwd, "sample.txt"),
      original.replace("line 1\n", "first change\n").replace("line 28\n", "second change\n"),
    );
    const patch = await diff(cwd, "sample.txt", false);
    const first = selectHunk(patch, 0);
    await git(cwd, ["apply", "--cached", "--check", "-"], first);
    await git(cwd, ["apply", "--cached", "-"], first);
    const staged = await diff(cwd, "sample.txt", true);
    assert.match(staged, /first change/);
    assert.doesNotMatch(staged, /second change/);
    assert.match(await diff(cwd, "sample.txt", false), /second change/);
    await git(cwd, ["apply", "--cached", "--reverse", "-"], selectHunk(staged, 0));
    assert.equal(await diff(cwd, "sample.txt", true), "");
    await git(cwd, ["add", "--", "sample.txt"]);
    await git(cwd, ["restore", "--staged", "--", "sample.txt"]);
    assert.equal(await diff(cwd, "sample.txt", true), "");
    await git(
      cwd,
      ["apply", "--reverse", "-"],
      selectHunk(await diff(cwd, "sample.txt", false), 0),
    );
    assert.doesNotMatch(await diff(cwd, "sample.txt", false), /first change/);
    await git(cwd, ["add", "--", "sample.txt"]);
    await git(cwd, ["commit", "-m", "fix: exact custom message"]);
    assert.equal(
      (await git(cwd, ["log", "-1", "--format=%s"])).trim(),
      "fix: exact custom message",
    );
    assert.deepEqual((await status(cwd)).files, []);
    const before = (await status(cwd)).revision;
    await writeFile(join(cwd, "new.txt"), "first");
    const after = (await status(cwd)).revision;
    await writeFile(join(cwd, "new.txt"), "second");
    assert.notEqual(before, after);
    assert.notEqual(after, (await status(cwd)).revision);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("remote fetch, fast-forward pull, and push use a local bare remote", async () => {
  const root = await mkdtemp(join(tmpdir(), "mixer-source-control-remote-"));
  try {
    const remote = join(root, "remote.git");
    const cwd = join(root, "checkout");
    await mkdir(cwd);
    await git(root, ["init", "--bare", remote]);
    await git(cwd, ["init", "-b", "main"]);
    await git(cwd, ["config", "user.name", "Plugin test"]);
    await git(cwd, ["config", "user.email", "plugin@example.test"]);
    await git(cwd, ["config", "commit.gpgsign", "false"]);
    await writeFile(join(cwd, "file.txt"), "hello");
    await git(cwd, ["add", "."]);
    await git(cwd, ["commit", "-m", "initial"]);
    await git(cwd, ["remote", "add", "origin", remote]);
    const unpublished = await status(cwd);
    await executeGitAction({ cwd, revision: unpublished.revision, action: { kind: "publish" } });
    assert.equal((await status(cwd)).upstream, "origin/main");
    const published = await status(cwd);
    await assert.rejects(
      executeGitAction({ cwd, revision: published.revision, action: { kind: "publish" } }),
      /already has an upstream/,
    );
    await git(cwd, ["fetch"]);
    await git(cwd, ["pull", "--ff-only"]);
    await git(cwd, ["push"]);
    const result = await status(cwd);
    assert.equal(result.upstream, "origin/main");
    assert.equal(result.ahead, 0);
    assert.equal(result.behind, 0);
    const other = join(root, "other");
    await git(root, ["clone", "--branch", "main", remote, other]);
    await git(other, ["config", "user.name", "Remote test"]);
    await git(other, ["config", "user.email", "remote@example.test"]);
    await git(other, ["config", "commit.gpgsign", "false"]);
    await writeFile(join(other, "remote.txt"), "incoming");
    await git(other, ["add", "."]);
    await git(other, ["commit", "-m", "incoming change"]);
    await git(other, ["push"]);
    assert.equal((await status(cwd)).behind, 0, "counts remain stale until a fetch");
    await git(cwd, ["fetch", "--all", "--quiet"]);
    assert.equal((await status(cwd)).behind, 1);
    await git(cwd, ["pull", "--ff-only"]);
    assert.equal((await status(cwd)).behind, 0);
    await writeFile(join(cwd, "outgoing.txt"), "outgoing");
    await git(cwd, ["add", "."]);
    await git(cwd, ["commit", "-m", "outgoing change"]);
    assert.equal((await status(cwd)).ahead, 1);
    await git(other, ["commit", "--allow-empty", "-m", "divergent change"]);
    await git(other, ["push"]);
    await git(cwd, ["fetch"]);
    assert.equal((await status(cwd)).ahead, 1);
    assert.equal((await status(cwd)).behind, 1);
    await assert.rejects(git(cwd, ["pull", "--ff-only"]));
    const divergent = await status(cwd);
    await executeGitAction({ cwd, revision: divergent.revision, action: { kind: "sync" } });
    assert.equal((await status(cwd)).ahead, 0);
    assert.equal((await status(cwd)).behind, 0);
    assert.equal(await readFile(join(cwd, "remote.txt"), "utf8"), "incoming");
    assert.equal(
      await git(remote, ["rev-parse", "refs/heads/main"]),
      await git(cwd, ["rev-parse", "HEAD"]),
    );

    await git(other, ["pull", "--ff-only"]);
    await git(cwd, ["config", "pull.rebase", "true"]);
    await writeFile(join(cwd, "rebased.txt"), "local rebase commit");
    await git(cwd, ["add", "."]);
    await git(cwd, ["commit", "-m", "rebase local"]);
    await git(other, ["commit", "--allow-empty", "-m", "rebase remote"]);
    await git(other, ["push"]);
    const stale = await status(cwd);
    assert.equal(stale.behind, 0, "Sync must fetch even when the cached remote appears current");
    await executeGitAction({ cwd, revision: stale.revision, action: { kind: "sync" } });
    assert.equal(
      (await git(cwd, ["show", "-s", "--format=%P", "HEAD"])).trim().split(" ").length,
      1,
      "Configured rebase must not create a merge commit",
    );
    assert.equal(
      await git(remote, ["rev-parse", "refs/heads/main"]),
      await git(cwd, ["rev-parse", "HEAD"]),
    );

    await git(other, ["pull", "--ff-only"]);
    await writeFile(join(other, "file.txt"), "remote conflict");
    await git(other, ["add", "."]);
    await git(other, ["commit", "-m", "remote conflict"]);
    await git(other, ["push"]);
    const remoteTip = await git(remote, ["rev-parse", "refs/heads/main"]);
    await writeFile(join(cwd, "file.txt"), "local conflict");
    await git(cwd, ["add", "."]);
    await git(cwd, ["commit", "-m", "local conflict"]);
    const conflict = await status(cwd);
    await assert.rejects(
      executeGitAction({ cwd, revision: conflict.revision, action: { kind: "sync" } }),
    );
    assert.equal(
      await git(remote, ["rev-parse", "refs/heads/main"]),
      remoteTip,
      "A conflicting sync must not push",
    );
    assert.ok(
      (await status(cwd)).files.some((file) => file.index === "U" || file.worktree === "U"),
      "Conflicts must remain available for resolution",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);

test("optimistic file moves match real Git for partial changes, new files, deletions, and cancellation", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "mixer-source-control-optimistic-"));
  try {
    await git(cwd, ["init", "-b", "main"]);
    await git(cwd, ["config", "user.name", "Plugin test"]);
    await git(cwd, ["config", "user.email", "plugin@example.test"]);
    await git(cwd, ["config", "commit.gpgsign", "false"]);
    await writeFile(join(cwd, "tracked.txt"), "original\n");
    await git(cwd, ["add", "."]);
    await git(cwd, ["commit", "-m", "initial"]);
    async function check(kind: "stage" | "unstage" | "discard", path: string) {
      const before = await status(cwd);
      const expected = optimisticStatus(before, { kind, paths: [path] });
      assert.equal(expected.revision, before.revision, "optimism must not invent a Git revision");
      const command = {
        stage: ["add", "--", path],
        unstage: ["restore", "--staged", "--", path],
        discard: ["restore", "--worktree", "--", path],
      };
      await git(cwd, command[kind]);
      const actual = await status(cwd);
      assert.deepEqual(
        expected.files.map(({ head: _head, ...file }) => file),
        actual.files.map(({ head: _head, ...file }) => file),
      );
    }
    await writeFile(join(cwd, "tracked.txt"), "staged version\n");
    await check("stage", "tracked.txt");
    await writeFile(join(cwd, "tracked.txt"), "working version\n");
    await check("unstage", "tracked.txt");
    await check("discard", "tracked.txt");
    await writeFile(join(cwd, "tracked.txt"), "staged version\n");
    await check("stage", "tracked.txt");
    await writeFile(join(cwd, "tracked.txt"), "discard this working version\n");
    await check("discard", "tracked.txt");
    assert.equal(await readFile(join(cwd, "tracked.txt"), "utf8"), "staged version\n");
    await check("stage", "tracked.txt");
    await writeFile(join(cwd, "tracked.txt"), "original\n");
    await check("stage", "tracked.txt");
    await writeFile(join(cwd, "new.txt"), "new file\n");
    await check("stage", "new.txt");
    await check("unstage", "new.txt");
    await rm(join(cwd, "tracked.txt"));
    await check("stage", "tracked.txt");
    await check("unstage", "tracked.txt");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("optimistic discard removes unstaged-only rows but preserves staged changes and unrelated files", () => {
  const current = {
    branch: "main",
    upstream: "",
    ahead: 0,
    behind: 0,
    hasRemote: false,
    revision: "before",
    files: [
      { path: "unstaged.ts", index: " ", worktree: "M", head: "M" },
      { path: "staged.ts", index: "M", worktree: "M", head: "M" },
      { path: "untouched.ts", index: " ", worktree: "M", head: "M" },
      { path: "new.ts", index: "?", worktree: "?", head: "?" },
    ],
  };
  const result = optimisticStatus(current, {
    kind: "discard",
    paths: ["unstaged.ts", "staged.ts"],
  });
  assert.equal(result.revision, "before");
  assert.deepEqual(result.files, [
    { path: "staged.ts", index: "M", worktree: " ", head: "M" },
    { path: "untouched.ts", index: " ", worktree: "M", head: "M" },
    { path: "new.ts", index: "?", worktree: "?", head: "?" },
  ]);
  assert.equal(current.files.length, 4, "rollback data must not be mutated");
});

test("Mixer's icon lookup distinguishes YAML, Markdown, and React TypeScript", () => {
  assert.match(getFileIconSvg("workflow.yml"), /<svg/);
  assert.equal(getFileIconSvg("workflow.yml"), getFileIconSvg("other.yaml"));
  assert.notEqual(getFileIconSvg("workflow.yml"), getFileIconSvg("README.md"));
  assert.notEqual(getFileIconSvg("price.tsx"), getFileIconSvg("price.ts"));
});

test("paths and porcelain status preserve unusual filenames", () => {
  assert.deepEqual(parseFiles(" M file with spaces\0?? line\nbreak\0"), [
    { path: "file with spaces", index: " ", worktree: "M" },
    { path: "line\nbreak", index: "?", worktree: "?" },
  ]);
  assert.throws(() => validatePaths("/repo", ["../outside"]));
  assert.throws(() => validatePaths("/repo", [".git/config"]));
  assert.doesNotThrow(() => validatePaths("/repo", ["file with spaces"]));
  assert.throws(() => selectHunk("binary diff", 0));
});

test("primary action offers pull for incoming commits and commit for changed files", () => {
  const snapshot = {
    branch: "develop",
    upstream: "origin/develop",
    ahead: 0,
    behind: 14,
    hasRemote: true,
    files: [],
    revision: "test",
  };
  const input = { status: snapshot, commitFlowPending: false, pushing: false };
  assert.deepEqual(primaryRemoteAction(input), {
    kind: "pull",
    label: "Pull 14↓",
    icon: "ArrowDown",
    accessibilityLabel: "Pull incoming commits",
  });
  assert.equal(
    primaryRemoteAction({
      ...input,
      status: { ...snapshot, files: [{ path: "file.txt", index: " ", worktree: "M", head: "M" }] },
    }),
    null,
  );
  assert.equal(primaryRemoteAction({ ...input, status: { ...snapshot, behind: 0 } }), null);
  assert.equal(
    primaryRemoteAction({ ...input, status: { ...snapshot, ahead: 2, behind: 0 } })?.kind,
    "sync",
  );
  assert.deepEqual(
    primaryRemoteAction({ ...input, status: { ...snapshot, ahead: 2, behind: 3 } }),
    {
      kind: "sync",
      label: "Sync Changes 3↓ 2↑",
      icon: "RefreshCw",
      accessibilityLabel: "Sync changes",
    },
  );
  assert.equal(
    primaryRemoteAction({ ...input, status: { ...snapshot, upstream: "", behind: 0 } })?.kind,
    "publish",
  );
});

test("explorer decorations scope Git paths and distinguish tracked, staged, and untracked files", async () => {
  const root = await mkdtemp(join(tmpdir(), "mixer-decorations-"));
  try {
    await git(root, ["init", "--quiet"]);
    await git(root, ["config", "user.email", "test@example.com"]);
    await git(root, ["config", "user.name", "Test"]);
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src", "tracked.ts"), "before");
    await writeFile(join(root, ".gitignore"), "ignored.txt\n");
    await git(root, ["add", "."]);
    await git(root, ["commit", "-qm", "initial"]);
    await writeFile(join(root, "src", "tracked.ts"), "after");
    await writeFile(join(root, "src", "new\nfile.ts"), "new");
    await writeFile(join(root, "ignored.txt"), "ignored");
    const { decorations } = await import("../server/git.js");
    assert.deepEqual(await decorations(join(root, "src")), [
      { path: "tracked.ts", index: " ", worktree: "M" },
      { path: "new\nfile.ts", index: "?", worktree: "?" },
    ]);
    await git(root, ["add", "src/tracked.ts"]);
    assert.equal(
      (await decorations(root)).find((file) => file.path === "src/tracked.ts")?.index,
      "M",
    );
    await git(root, ["checkout", "HEAD", "--", "src/tracked.ts"]);
    assert.equal(
      (await decorations(root)).some((file) => file.path === "src/tracked.ts"),
      false,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Trash preparation accepts only reviewed untracked files and rejects tracked or stale requests", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "scm-trash-"));
  try {
    await git(cwd, ["init", "-q"]);
    await writeFile(join(cwd, "tracked.txt"), "tracked");
    await git(cwd, ["add", "."]);
    await git(cwd, [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "-qm",
      "initial",
    ]);
    await writeFile(join(cwd, "new.txt"), "new");
    const { prepareTrash } = await import("../server/action.js");
    const snapshot = await status(cwd);
    assert.deepEqual(await prepareTrash(cwd, ["new.txt"], snapshot.revision), [
      join(cwd, "new.txt"),
    ]);
    assert.equal(await readFile(join(cwd, "new.txt"), "utf8"), "new");
    await assert.rejects(
      prepareTrash(cwd, ["tracked.txt"], snapshot.revision),
      /Only untracked files/,
    );
    await writeFile(join(cwd, "new.txt"), "changed since review");
    await assert.rejects(prepareTrash(cwd, ["new.txt"], snapshot.revision), /Files changed/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

async function conflictedRepository(
  kind: "merge" | "rebase" | "cherry-pick" | "revert",
  linked = false,
) {
  const root = await mkdtemp(join(tmpdir(), "mixer-scm-operation-"));
  const repository = join(root, "repo");
  await mkdir(repository);
  await git(repository, ["init", "-b", "main"]);
  await git(repository, ["config", "user.name", "SCM test"]);
  await git(repository, ["config", "user.email", "scm@example.test"]);
  await git(repository, ["config", "commit.gpgsign", "false"]);
  await writeFile(join(repository, "file.txt"), "base\n");
  await git(repository, ["add", "."]);
  await git(repository, ["commit", "-m", "base"]);
  await git(repository, ["checkout", "-b", "incoming"]);
  await writeFile(join(repository, "file.txt"), "theirs\n");
  await git(repository, ["commit", "-am", "Incoming change"]);
  const incoming = (await git(repository, ["rev-parse", "HEAD"])).trim();
  await git(repository, ["checkout", "main"]);
  await writeFile(join(repository, "file.txt"), "ours\n");
  await git(repository, ["commit", "-am", "Current change"]);
  let cwd = repository;
  if (linked) {
    cwd = join(root, "linked");
    await git(repository, ["worktree", "add", "-b", "linked", cwd]);
  }
  const head = (await git(cwd, ["rev-parse", "HEAD"])).trim();
  const target = kind === "merge" || kind === "rebase" ? "incoming" : incoming;
  await assert.rejects(git(cwd, [kind, target], undefined, { GIT_EDITOR: "true" }));
  return { root, cwd, head };
}

for (const kind of ["merge", "rebase", "cherry-pick", "revert"] as const) {
  test(`SCM continues ${kind} with the prepared message and a reviewed resolution`, async () => {
    const { root, cwd } = await conflictedRepository(kind, kind === "merge");
    try {
      const before = await status(cwd);
      assert.equal(before.operation?.kind, kind);
      assert.ok(before.operation?.message);
      assert.ok(!before.operation?.message.includes("# Conflicts:"));
      if (kind === "merge")
        assert.match(before.operation!.message, /Merge branch 'incoming' into linked/);
      await assert.rejects(
        executeGitAction({
          cwd,
          revision: before.revision,
          action: { kind: "continue", message: "unsafe" },
        }),
        /Resolve merge conflicts/,
      );
      await assert.rejects(
        executeGitAction({
          cwd,
          revision: before.revision,
          action: { kind: "stage", paths: ["file.txt"] },
        }),
        /Resolve conflict markers/,
      );
      await writeFile(join(cwd, "file.txt"), "resolved\n");
      await executeGitAction({
        cwd,
        revision: (await status(cwd)).revision,
        action: { kind: "stage", paths: ["file.txt"] },
      });
      const ready = await status(cwd);
      await executeGitAction({
        cwd,
        revision: ready.revision,
        action: { kind: "continue", message: `Resolved ${kind}` },
      });
      assert.equal((await status(cwd)).operation, null);
      assert.equal((await git(cwd, ["log", "-1", "--format=%s"])).trim(), `Resolved ${kind}`);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  test(`SCM aborts ${kind} without leaving operation state`, async () => {
    const { root, cwd, head } = await conflictedRepository(kind);
    try {
      await executeGitAction({
        cwd,
        revision: (await status(cwd)).revision,
        action: { kind: "abort" },
      });
      assert.equal((await status(cwd)).operation, null);
      assert.equal((await git(cwd, ["rev-parse", "HEAD"])).trim(), head);
      assert.equal(await readFile(join(cwd, "file.txt"), "utf8"), "ours\n");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}
