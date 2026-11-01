import { test } from "vitest";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, symlink, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git } from "../server/git.js";
import { document, saveDocument } from "../server/document.js";

test("side-by-side versions compare HEAD/index/worktree and save only the working file", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "mixer-editor-"));
  try {
    await git(cwd, ["init", "-b", "main"]);
    await git(cwd, ["config", "user.name", "Editor test"]);
    await git(cwd, ["config", "user.email", "editor@example.test"]);
    await git(cwd, ["config", "commit.gpgsign", "false"]);
    await writeFile(join(cwd, "file.txt"), "original\n");
    await git(cwd, ["add", "."]);
    await git(cwd, ["commit", "-m", "initial"]);
    await writeFile(join(cwd, "file.txt"), "staged\n");
    await git(cwd, ["add", "."]);
    await writeFile(join(cwd, "file.txt"), "working\n");
    const staged = await document(cwd, "file.txt", true);
    assert.equal(staged.original, "original\n");
    assert.equal(staged.modified, "staged\n");
    assert.equal(staged.editable, false);
    const working = await document(cwd, "file.txt", false);
    assert.equal(working.original, "staged\n");
    assert.equal(working.modified, "working\n");
    assert.equal(working.editable, true);
    await saveDocument(cwd, "file.txt", working.revision, "edited\n");
    assert.equal(await readFile(join(cwd, "file.txt"), "utf8"), "edited\n");
    assert.equal(await git(cwd, ["show", ":file.txt"]), "staged\n");
    await assert.rejects(
      saveDocument(cwd, "file.txt", working.revision, "stale draft\n"),
      /changed on disk/,
    );
    assert.equal(await readFile(join(cwd, "file.txt"), "utf8"), "edited\n");
    await writeFile(join(cwd, "new.txt"), "untracked");
    assert.equal((await document(cwd, "new.txt", false)).original, "");
    await writeFile(join(cwd, "binary.txt"), "binary\0data");
    await assert.rejects(document(cwd, "binary.txt", false), /UTF-8/);
    await symlink(join(cwd, "file.txt"), join(cwd, "link.txt"));
    await assert.rejects(document(cwd, "link.txt", false), /Symlink/);
    await assert.rejects(document(cwd, "../outside", false), /Invalid/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
