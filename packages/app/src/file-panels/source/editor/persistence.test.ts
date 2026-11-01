import { describe, expect, test } from "vitest";
import { FileRecoveryJournal } from "./persistence";
import { InMemoryEditorStorage } from "./testing";

describe("working-copy backups", () => {
  test("restores the latest committed draft without mixing host or file identities", async () => {
    const storage = new InMemoryEditorStorage();
    await new FileRecoveryJournal(storage, () => "host-a/file.ts").checkpoint({
      base: "base",
      content: "unsaved",
      lineSeparator: "\n",
    });
    expect(await new FileRecoveryJournal(storage, () => "host-b/file.ts").load()).toBeNull();
    expect(await new FileRecoveryJournal(storage, () => "host-a/file.ts").load()).toMatchObject({
      base: "base",
      content: "unsaved",
      lineSeparator: "\n",
    });
  });

  test("does not erase a sibling window's newer draft when resolving a recovered copy", async () => {
    const storage = new InMemoryEditorStorage();
    const first = new FileRecoveryJournal(storage, () => "file");
    await first.checkpoint({ base: "base", content: "first", lineSeparator: "\n" });
    const second = new FileRecoveryJournal(storage, () => "file");
    await second.load();
    await first.checkpoint({ base: "base", content: "newer", lineSeparator: "\n" });
    await second.checkpoint(null);
    expect((await storage.drafts("file")).map((record) => record.content)).toEqual(["newer"]);
  });

  test("coalesces queued edits and commits cleanup after the last backup write", async () => {
    const storage = new InMemoryEditorStorage();
    const journal = new FileRecoveryJournal(storage, () => "file");
    await Promise.all([
      journal.checkpoint({ base: "base", content: "one", lineSeparator: "\n" }),
      journal.checkpoint({ base: "base", content: "two", lineSeparator: "\n" }),
    ]);
    expect((await storage.drafts("file")).map((record) => record.content)).toEqual(["two"]);
    await journal.checkpoint(null);
    expect(await storage.drafts("file")).toEqual([]);
  });

  test("retargets a draft's recovery identity after a move", async () => {
    const storage = new InMemoryEditorStorage();
    let path = "before.ts";
    const journal = new FileRecoveryJournal(storage, () => path);
    await journal.checkpoint({ base: "base", content: "draft", lineSeparator: "\n" });
    path = "after.ts";
    await journal.checkpoint({ base: "base", content: "draft", lineSeparator: "\n" });
    expect(await storage.drafts("before.ts")).toEqual([]);
    expect((await storage.drafts("after.ts")).map((record) => record.content)).toEqual(["draft"]);
  });
});
