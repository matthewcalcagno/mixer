import { afterEach, describe, expect, test } from "vitest";
import { InMemoryFileSession } from "../../file/testing";
import { applyDocumentEdits, WorkspaceDocuments, type DocumentTextEdit } from "./documents";

const stores: WorkspaceDocuments[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.dispose();
});

function setup() {
  const session = new InMemoryFileSession();
  session.put("one.ts", "const one = 1;\n");
  session.put("two.ts", "one();\n");
  const store = new WorkspaceDocuments("/repo", session);
  stores.push(store);
  return { store, session };
}

function replace(start: number, end: number, newText: string): DocumentTextEdit {
  return {
    range: { start: { line: 0, character: start }, end: { line: 0, character: end } },
    newText,
  };
}

describe("workspace documents", () => {
  test("shares language modes without changing file contents, versions or undo history", async () => {
    const { store, session } = setup();
    const document = store.document("one.ts");
    await document.ready();
    const before = document.model.getSnapshot();
    store.setLanguageMode(document, "java");
    expect(store.document("/repo/one.ts").languageMode).toBe("java");
    expect(document.model.getSnapshot().content).toBe(before.content);
    expect(document.model.getSnapshot().version).toBe(before.version);
    expect(document.undo).toEqual([]);
    expect(session.text("one.ts")).toBe("const one = 1;\n");
    store.setLanguageMode(document, null);
    expect(document.languageMode).toBeNull();
  });
  test("evicts unused clean documents without evicting an open view", async () => {
    const { store, session } = setup();
    const open = store.document("one.ts");
    const release = open.acquire();
    await open.ready();
    for (let index = 0; index < 140; index += 1) {
      const path = `file-${index}.ts`;
      session.put(path, `export const value = ${index};\n`);
      await store.document(path).ready();
    }
    expect(store.find("/repo/file-0.ts")).toBeUndefined();
    expect(store.document("one.ts")).toBe(open);
    expect(store.document("file-139.ts").model.getSnapshot().content).toBe(
      "export const value = 139;\n",
    );
    release();
  });
  test("shares a buffer for relative and absolute paths, including unsaved edits", async () => {
    const { store, session } = setup();
    const first = store.document("one.ts");
    const second = store.document("/repo/one.ts");
    expect(second).toBe(first);
    await first.ready();
    expect(store.edit(first, "const one = 2;\n", first.model.getSnapshot().version, "left")).toBe(
      true,
    );
    expect(second.model.getSnapshot().content).toBe("const one = 2;\n");
    expect(session.text("one.ts")).toBe("const one = 1;\n");
  });

  test("rejects stale drafts even from the same view", async () => {
    const { store } = setup();
    const document = store.document("one.ts");
    await document.ready();
    const version = document.model.getSnapshot().version;
    expect(store.edit(document, "new", version, "left")).toBe(true);
    expect(store.edit(document, "stale", version, "left")).toBe(false);
    expect(document.model.getSnapshot().content).toBe("new");
  });

  test("accepts ordered unacknowledged view edits but rejects replays and competing drafts", async () => {
    const { store } = setup();
    const document = store.document("one.ts");
    await document.ready();
    const baseVersion = document.model.getSnapshot().version;
    const edit = (content: string, revision: number, actor = "left") =>
      store.editFromView({ document, content, baseVersion, revision, actor });
    expect(edit("one", 1)).toBe(true);
    expect(edit("one", 2)).toBe(true);
    expect(edit("two", 3)).toBe(true);
    expect(edit("stale", 2)).toBe(false);
    expect(edit("right stale", 1, "right")).toBe(false);
    expect(store.edit(document, "right", document.model.getSnapshot().version, "right")).toBe(true);
    expect(edit("left stale", 4)).toBe(false);
    expect(
      store.editFromView({
        document,
        content: "still stale",
        baseVersion: document.model.getSnapshot().version,
        actor: "left",
        revision: 5,
      }),
    ).toBe(false);
    expect(document.model.getSnapshot().content).toBe("right");
  });

  test("applies and undoes a refactor across unsaved buffers as one group", async () => {
    const { store, session } = setup();
    const first = store.document("one.ts");
    await first.ready();
    store.edit(first, "const one = 2;\n", first.model.getSnapshot().version, "left");
    const plan = await store.prepare("Rename one", [
      { path: "one.ts", edits: [replace(6, 9, "renamed")] },
      { path: "two.ts", edits: [replace(0, 3, "renamed")] },
    ]);
    await store.apply(plan);
    const second = store.document("two.ts");
    expect(first.model.getSnapshot().content).toBe("const renamed = 2;\n");
    expect(second.model.getSnapshot().content).toBe("renamed();\n");
    expect(session.writes).toEqual([]);
    expect(await store.undo(second)).toBe(true);
    expect(first.model.getSnapshot().content).toBe("const one = 2;\n");
    expect(second.model.getSnapshot().content).toBe("one();\n");
    expect(await store.undo(first, true)).toBe(true);
    expect(first.model.getSnapshot().content).toBe("const renamed = 2;\n");
    expect(second.model.getSnapshot().content).toBe("renamed();\n");
  });

  test("rejects an entire stale preview without changing another file", async () => {
    const { store } = setup();
    const plan = await store.prepare("Rename", [
      { path: "one.ts", edits: [replace(6, 9, "other")] },
      { path: "two.ts", edits: [replace(0, 3, "other")] },
    ]);
    const second = store.document("two.ts");
    store.edit(second, "newer();\n", second.model.getSnapshot().version, "right");
    await expect(store.apply(plan)).rejects.toThrow("changed during review");
    expect(store.document("one.ts").model.getSnapshot().content).toBe("const one = 1;\n");
    expect(second.model.getSnapshot().content).toBe("newer();\n");
  });

  test("requires newer typing to be undone before a grouped refactor", async () => {
    const { store } = setup();
    await store.apply(
      await store.prepare("Rename", [
        { path: "one.ts", edits: [replace(6, 9, "other")] },
        { path: "two.ts", edits: [replace(0, 3, "other")] },
      ]),
    );
    const first = store.document("one.ts");
    const second = store.document("two.ts");
    store.edit(second, "other(2);\n", second.model.getSnapshot().version, "right");
    await expect(store.undo(first)).rejects.toThrow("newer edits");
    expect(first.model.getSnapshot().content).toBe("const other = 1;\n");
    await store.undo(second);
    await store.undo(first);
    expect(second.model.getSnapshot().content).toBe("one();\n");
  });

  test("external reload invalidates history across every file in the group", async () => {
    const { store, session } = setup();
    await store.apply(
      await store.prepare("Rename", [
        { path: "one.ts", edits: [replace(6, 9, "other")] },
        { path: "two.ts", edits: [replace(0, 3, "other")] },
      ]),
    );
    const first = store.document("one.ts");
    session.put("one.ts", "external\n");
    await first.model.revert();
    expect(first.model.getSnapshot().content).toBe("external\n");
    expect(await store.undo(store.document("two.ts"))).toBe(false);
  });

  test("rejects loading waiters when their document is disposed", async () => {
    const { store } = setup();
    const pending = store.document("one.ts").ready();
    store.dispose();
    await expect(pending).rejects.toThrow("Document closed");
  });

  test("publishes a workspace edit only after every buffer has changed", async () => {
    const { store } = setup();
    const plan = await store.prepare("Rename", [
      { path: "one.ts", edits: [replace(6, 9, "other")] },
      { path: "two.ts", edits: [replace(0, 3, "other")] },
    ]);
    const observed: string[][] = [];
    store.subscribe(() =>
      observed.push([
        store.document("one.ts").model.getSnapshot().content,
        store.document("two.ts").model.getSnapshot().content,
      ]),
    );
    await store.apply(plan);
    expect(observed).toEqual([
      ["const other = 1;\n", "other();\n"],
      ["const other = 1;\n", "other();\n"],
    ]);
  });

  test("rejects a plan after its workspace closes", async () => {
    const { store } = setup();
    const plan = await store.prepare("Rename", [
      { path: "one.ts", edits: [replace(6, 9, "other")] },
    ]);
    store.dispose();
    await expect(store.apply(plan)).rejects.toThrow("Workspace documents closed");
  });

  test("autosaves all refactored buffers and keeps grouped undo after saving", async () => {
    const { store, session } = setup();
    await store.apply(
      await store.prepare("Rename", [
        { path: "one.ts", edits: [replace(6, 9, "other")] },
        { path: "two.ts", edits: [replace(0, 3, "other")] },
      ]),
    );
    const first = store.document("one.ts");
    const second = store.document("two.ts");
    await Promise.all([first.model.save(), second.model.save()]);
    expect(session.text("one.ts")).toBe("const other = 1;\n");
    expect(session.text("two.ts")).toBe("other();\n");
    await store.undo(first);
    await Promise.all([first.model.save(), second.model.save()]);
    expect(session.text("one.ts")).toBe("const one = 1;\n");
    expect(session.text("two.ts")).toBe("one();\n");
  });

  test("rejects file edits outside the workspace", () => {
    const { store } = setup();
    expect(() => store.document("../outside.ts")).toThrow("outside this workspace");
    expect(() => store.document("/other/file.ts")).toThrow("outside this workspace");
  });

  test("typing on either file clears the redo group for every affected file", async () => {
    const { store } = setup();
    await store.apply(
      await store.prepare("Rename", [
        { path: "one.ts", edits: [replace(6, 9, "other")] },
        { path: "two.ts", edits: [replace(0, 3, "other")] },
      ]),
    );
    const first = store.document("one.ts");
    const second = store.document("two.ts");
    await store.undo(first);
    store.edit(second, "newBranch();\n", second.model.getSnapshot().version, "right");
    expect(await store.undo(first, true)).toBe(false);
    expect(await store.undo(second, true)).toBe(false);
    expect(first.model.getSnapshot().content).toBe("const one = 1;\n");
    expect(second.model.getSnapshot().content).toBe("newBranch();\n");
  });

  test("stale concurrent refactors cannot both apply", async () => {
    const { store } = setup();
    const first = await store.prepare("First", [
      { path: "one.ts", edits: [replace(6, 9, "first")] },
    ]);
    const second = await store.prepare("Second", [
      { path: "one.ts", edits: [replace(6, 9, "second")] },
    ]);
    const outcomes = await Promise.allSettled([store.apply(first), store.apply(second)]);
    expect(outcomes.map((outcome) => outcome.status)).toEqual(["fulfilled", "rejected"]);
    expect(store.document("one.ts").model.getSnapshot().content).toBe("const first = 1;\n");
  });

  test("moves a shared unsaved buffer and undoes its import edits and path together", async () => {
    const { store, session } = setup();
    const source = store.document("one.ts");
    await source.ready();
    store.edit(source, "const one = 2;\n", source.model.getSnapshot().version, "left");
    const plan = await store.prepare("Move", [{ path: "two.ts", edits: [replace(0, 3, "moved")] }]);
    const snapshot = source.model.getSnapshot();
    plan.changes.push({
      document: source,
      version: snapshot.version,
      before: snapshot.content,
      after: snapshot.content,
    });
    const paths: string[][] = [];
    plan.move = {
      document: source,
      from: "/repo/one.ts",
      to: "/repo/moved.ts",
      async perform(from, to, expected) {
        const oldPath = from.slice("/repo/".length);
        const newPath = to.slice("/repo/".length);
        const disk = await session.read({ cwd: "/repo", path: oldPath });
        expect(disk.revision).toBe(expected.revision);
        session.put(newPath, disk.bytes);
        session.remove(oldPath);
        return session.read({ cwd: "/repo", path: newPath });
      },
      onMoved(from, to) {
        paths.push([from, to]);
      },
    };
    await store.apply(plan);
    expect(store.find("/repo/one.ts")).toBeUndefined();
    expect(store.document("moved.ts")).toBe(source);
    expect(source.model.getSnapshot().content).toBe("const one = 2;\n");
    await source.model.save();
    expect(session.text("moved.ts")).toBe("const one = 2;\n");
    expect(session.text("one.ts")).toBeNull();
    await store.undo(store.document("two.ts"));
    expect(store.document("one.ts")).toBe(source);
    expect(store.document("two.ts").model.getSnapshot().content).toBe("one();\n");
    expect(source.model.getSnapshot().content).toBe("const one = 2;\n");
    expect(paths).toEqual([
      ["/repo/one.ts", "/repo/moved.ts"],
      ["/repo/moved.ts", "/repo/one.ts"],
    ]);
    await store.undo(source, true);
    expect(store.document("moved.ts")).toBe(source);
    expect(store.document("two.ts").model.getSnapshot().content).toBe("moved();\n");
  });
  test("rolls a file move back if an import buffer changes during the filesystem operation", async () => {
    const { store, session } = setup();
    const source = store.document("one.ts");
    await source.ready();
    const plan = await store.prepare("Move", [{ path: "two.ts", edits: [replace(0, 3, "moved")] }]);
    const snapshot = source.model.getSnapshot();
    plan.changes.push({
      document: source,
      version: snapshot.version,
      before: snapshot.content,
      after: snapshot.content,
    });
    plan.move = {
      document: source,
      from: "/repo/one.ts",
      to: "/repo/moved.ts",
      async perform(from, to) {
        const oldPath = from.slice("/repo/".length);
        const newPath = to.slice("/repo/".length);
        const file = await session.read({ cwd: "/repo", path: oldPath });
        session.put(newPath, file.bytes);
        session.remove(oldPath);
        if (from === "/repo/one.ts") {
          session.put("two.ts", "external();\n");
          await store.document("two.ts").model.reload();
        }
        return session.read({ cwd: "/repo", path: newPath });
      },
      onMoved() {},
    };
    await expect(store.apply(plan)).rejects.toThrow("changed during review");
    expect(store.document("one.ts")).toBe(source);
    expect(session.text("one.ts")).toBe("const one = 1;\n");
    expect(session.text("moved.ts")).toBeNull();
    expect(store.document("two.ts").model.getSnapshot().content).toBe("external();\n");
    expect(await store.undo(source)).toBe(false);
  });
});

describe("document text edits", () => {
  test("uses UTF-16 positions and preserves CRLF", () => {
    expect(applyDocumentEdits("😀 one\r\nnext\r\n", [replace(3, 6, "two")])).toBe(
      "😀 two\r\nnext\r\n",
    );
  });
  test("normalizes inserted language-server newlines to the buffer's line separator", () => {
    expect(applyDocumentEdits("one\r\ntwo\r\n", [replace(0, 3, "first\nsecond")])).toBe(
      "first\r\nsecond\r\ntwo\r\n",
    );
  });
  test("rejects overlapping edits and out-of-range positions", () => {
    expect(() => applyDocumentEdits("abc", [replace(0, 2, "x"), replace(1, 3, "y")])).toThrow(
      "overlap",
    );
    expect(() => applyDocumentEdits("abc", [replace(0, 4, "x")])).toThrow("beyond the line");
  });
});
