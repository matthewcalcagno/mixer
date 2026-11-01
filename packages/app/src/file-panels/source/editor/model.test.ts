import { describe, expect, test } from "vitest";
import { FileHandle } from "../../file/handle";
import { InMemoryFileSession } from "../../file/testing";
import { FileEditorModel, getFileConflictCallout, type FileEditorClock } from "./model";
import { FileRecoveryJournal, type FileRecovery } from "./persistence";
import { InMemoryEditorStorage } from "./testing";

class TestClock implements FileEditorClock {
  private callback: (() => void) | null = null;

  setTimeout(callback: () => void): ReturnType<typeof setTimeout> {
    this.callback = callback;
    return 1 as unknown as ReturnType<typeof setTimeout>;
  }

  clearTimeout(): void {
    this.callback = null;
  }

  get scheduled(): boolean {
    return this.callback !== null;
  }

  fire(): void {
    const callback = this.callback;
    this.callback = null;
    callback?.();
  }
}

function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function openEditor(content: string | Uint8Array = "first\n", recovery?: FileRecovery) {
  const session = new InMemoryFileSession();
  session.put("source.ts", content);
  const handle = new FileHandle(session, { cwd: "/repo", path: "source.ts" }, "/repo/source.ts");
  handle.setObserving(true);
  await settle();
  const clock = new TestClock();
  const model = new FileEditorModel({ file: handle.file, clock, recovery });
  model.open();
  await settle();
  return { session, handle, clock, model, disk: () => session.text("source.ts") };
}

describe("FileEditorModel", () => {
  test("a pending reload cannot overwrite newer typing", async () => {
    const { model } = await openEditor();
    const reloading = model.reload();
    model.edit("typed during reload\n");
    await reloading;
    expect(model.getSnapshot()).toMatchObject({
      content: "typed during reload\n",
      modified: true,
      status: "dirty",
    });
  });
  test("restores an unsaved draft without autosaving until the user accepts it", async () => {
    const storage = new InMemoryEditorStorage();
    await new FileRecoveryJournal(storage, () => "source").checkpoint({
      base: "first\n",
      content: "recovered\n",
      lineSeparator: "\n",
    });
    const { model, clock, disk } = await openEditor(
      "first\n",
      new FileRecoveryJournal(storage, () => "source"),
    );
    expect(model.getSnapshot()).toMatchObject({
      content: "recovered\n",
      modified: true,
      recovered: true,
      status: "dirty",
    });
    expect(clock.scheduled).toBe(false);
    model.edit("recovered and edited\n");
    expect(clock.scheduled).toBe(false);
    expect(disk()).toBe("first\n");
    await model.save();
    await model.backup();
    expect(disk()).toBe("recovered and edited\n");
    expect(model.getSnapshot()).toMatchObject({
      recovered: false,
      modified: false,
      status: "clean",
    });
    expect(await storage.drafts("source")).toEqual([]);
  });

  test("recovered work conflicts with newer disk content and reload explicitly discards it", async () => {
    const storage = new InMemoryEditorStorage();
    await new FileRecoveryJournal(storage, () => "source").checkpoint({
      base: "old disk\n",
      content: "recovered\n",
      lineSeparator: "\r\n",
    });
    const { model, clock, disk, session } = await openEditor(
      "external\n",
      new FileRecoveryJournal(storage, () => "source"),
    );
    expect(model.getSnapshot()).toMatchObject({
      content: "recovered\n",
      modified: true,
      recovered: true,
      status: "conflict",
      conflict: "changed",
      lineSeparator: "\r\n",
    });
    expect(clock.scheduled).toBe(false);
    session.put("source.ts", "external\n");
    await settle();
    expect(model.getSnapshot()).toMatchObject({
      recovered: true,
      conflict: "changed",
      status: "conflict",
    });
    await model.save();
    expect(disk()).toBe("external\n");
    await model.reload();
    await model.backup();
    expect(model.getSnapshot()).toMatchObject({
      content: "external\n",
      recovered: false,
      modified: false,
    });
    expect(await storage.drafts("source")).toEqual([]);
  });

  test("reports failed local backups without losing text and can retry", async () => {
    const storage = new InMemoryEditorStorage();
    const { model, disk } = await openEditor(
      "first\n",
      new FileRecoveryJournal(storage, () => "source"),
    );
    storage.failWrites = true;
    model.edit("local\n");
    await model.backup();
    expect(model.getSnapshot()).toMatchObject({
      content: "local\n",
      modified: true,
      recoveryError: "Storage quota exceeded",
    });
    expect(disk()).toBe("first\n");
    storage.failWrites = false;
    await model.retryBackup();
    expect(model.getSnapshot().recoveryError).toBeNull();
    expect((await storage.drafts("source")).map((record) => record.content)).toEqual(["local\n"]);
  });
  test("loads the file clean", async () => {
    const { model } = await openEditor();

    expect(model.getSnapshot()).toMatchObject({
      status: "clean",
      content: "first\n",
      modified: false,
    });
  });

  test("reports a file it cannot read", async () => {
    const session = new InMemoryFileSession();
    const handle = new FileHandle(session, { cwd: "/repo", path: "gone.ts" }, "/repo/gone.ts");
    const model = new FileEditorModel({ file: handle.file });
    model.open();
    await settle();

    expect(model.getSnapshot()).toMatchObject({ status: "failed", error: "File not found" });
  });

  test("tracks whether the buffer differs from the file", async () => {
    const { model } = await openEditor();

    model.edit("second\n");
    expect(model.getSnapshot()).toMatchObject({ status: "dirty", modified: true });
    model.edit("first\n");
    expect(model.getSnapshot()).toMatchObject({ status: "clean", modified: false });
  });

  test("autosaves the latest edit after inactivity", async () => {
    const { model, clock, disk } = await openEditor();

    model.edit("draft\n");
    model.edit("latest\n");
    clock.fire();
    await settle();

    expect(disk()).toBe("latest\n");
    expect(model.getSnapshot()).toMatchObject({ status: "clean", modified: false });
  });

  test("keeps a newer edit modified when an older save finishes", async () => {
    const { model, disk } = await openEditor();

    model.edit("saved\n");
    const save = model.save();
    model.edit("newer\n");
    await save;

    expect(disk()).toBe("saved\n");
    expect(model.getSnapshot()).toMatchObject({ status: "dirty", modified: true });
  });

  test("keeps CRLF content and the byte order mark in file form", async () => {
    const { model, disk } = await openEditor(
      new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode("a\r\nb\n")]),
    );

    expect(model.getSnapshot()).toMatchObject({ content: "a\r\nb\n", lineSeparator: "\r\n" });
    model.edit("c\r\nd\r\n");
    await model.save();

    expect(disk()).toBe("﻿c\r\nd\r\n");
  });

  test("follows the disk while clean", async () => {
    const { session, model } = await openEditor();

    session.put("source.ts", "external\r\n");
    await settle();

    expect(model.getSnapshot()).toMatchObject({
      status: "clean",
      content: "external\r\n",
      lineSeparator: "\r\n",
    });
  });

  test("conflicts when the disk changes under a modified buffer, and overwrites", async () => {
    const { session, model, disk } = await openEditor();

    model.edit("local\n");
    session.put("source.ts", "external\n");
    await settle();
    expect(model.getSnapshot()).toMatchObject({ status: "conflict", content: "local\n" });
    expect(getFileConflictCallout(model.getSnapshot())).toEqual({
      kind: "changed",
      canOverwrite: true,
    });

    await model.overwrite();
    expect(disk()).toBe("local\n");
    expect(model.getSnapshot()).toMatchObject({ status: "clean", conflict: null });
  });

  test("reload discards a conflicted buffer for the disk", async () => {
    const { session, model } = await openEditor();

    model.edit("local\n");
    session.put("source.ts", "external\n");
    await settle();
    await model.reload();

    expect(model.getSnapshot()).toMatchObject({
      status: "clean",
      content: "external\n",
      modified: false,
    });
  });

  test("a save over an unobserved change conflicts instead of writing", async () => {
    const { session, handle, model, disk } = await openEditor();

    handle.setObserving(false);
    session.put("source.ts", "external\n");
    model.edit("local\n");
    await model.save();

    expect(disk()).toBe("external\n");
    expect(model.getSnapshot()).toMatchObject({ status: "conflict", conflict: "changed" });
  });

  test("stays clean when the disk changes back to its own content", async () => {
    const { session, model, clock } = await openEditor();

    model.edit("local\n");
    session.put("source.ts", "first\n");
    await settle();

    expect(model.getSnapshot()).toMatchObject({ status: "dirty", content: "local\n" });
    expect(clock.scheduled).toBe(true);
  });

  test("a deletion conflicts with local changes and stops autosave", async () => {
    const { session, model, clock } = await openEditor();

    model.edit("local\n");
    session.remove("source.ts");
    await settle();

    expect(getFileConflictCallout(model.getSnapshot())).toEqual({ kind: "deleted" });
    expect(clock.scheduled).toBe(false);
  });

  test("a save over a deletion it has not heard about shows the deleted notice", async () => {
    const { session, handle, model } = await openEditor();

    handle.setObserving(false);
    session.remove("source.ts");
    model.edit("local\n");
    await model.save();

    expect(getFileConflictCallout(model.getSnapshot())).toEqual({ kind: "deleted" });
    expect(model.getSnapshot().content).toBe("local\n");
  });

  test("an external change during a save is reconciled after it", async () => {
    const { session, handle, model } = await openEditor();

    model.edit("local\n");
    const resume = handle.holdWrites();
    const save = model.save();
    session.put("source.ts", "external\n");
    resume();
    await save;
    await settle();

    expect(model.getSnapshot()).toMatchObject({ status: "conflict", conflict: "changed" });
  });

  test("reports failed saves without losing the buffer", async () => {
    const { session, model } = await openEditor();

    session.failNextWrite("disk full");
    model.edit("local\n");
    await model.save();

    expect(model.getSnapshot()).toMatchObject({
      status: "error",
      content: "local\n",
      error: "disk full",
    });
  });

  test("flushes a modified buffer when disposed for another panel", async () => {
    const { model, disk } = await openEditor();

    model.edit("switching\n");
    model.dispose({ flush: true });
    await settle();

    expect(disk()).toBe("switching\n");
  });

  test("discards the buffer when the tab closes while holding writes", async () => {
    const { handle, model, disk } = await openEditor();

    model.edit("discarded\n");
    handle.holdWrites();
    model.dispose({ flush: true });
    handle.dispose();
    await settle();

    expect(disk()).toBe("first\n");
  });

  test("buffer versions advance only when text changes", async () => {
    const { model } = await openEditor();
    const initial = model.getSnapshot().version;
    model.edit("second\n");
    expect(model.getSnapshot().version).toBe(initial + 1);
    model.edit("second\n");
    await model.save();
    expect(model.getSnapshot().version).toBe(initial + 1);
    expect(model.editIfVersion("stale\n", initial)).toBe(false);
    expect(model.getSnapshot().content).toBe("second\n");
  });

  test("autosave holds are nested and release exactly once", async () => {
    const { model, clock, disk } = await openEditor();
    const releaseFirst = model.holdAutosave();
    const releaseSecond = model.holdAutosave();
    model.edit("held\n");
    await model.save();
    expect(disk()).toBe("first\n");
    expect(clock.scheduled).toBe(false);
    releaseFirst();
    releaseFirst();
    expect(clock.scheduled).toBe(false);
    releaseSecond();
    expect(clock.scheduled).toBe(true);
    clock.fire();
    await model.whenIdle();
    expect(disk()).toBe("held\n");
  });

  test("serializes saves without losing edits made during an in-flight write", async () => {
    const { model, handle, session, disk } = await openEditor();
    const release = handle.holdWrites();
    model.edit("first write\n");
    const first = model.save();
    await settle();
    model.edit("second write\n");
    const second = model.save();
    const duplicate = model.save();
    release();
    await Promise.all([first, second, duplicate]);
    expect(session.writes).toEqual(["first write\n", "second write\n"]);
    expect(disk()).toBe("second write\n");
    expect(model.getSnapshot()).toMatchObject({
      status: "clean",
      content: "second write\n",
      modified: false,
    });
  });
});
