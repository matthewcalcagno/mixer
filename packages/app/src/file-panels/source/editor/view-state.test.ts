import { afterEach, describe, expect, test, vi } from "vitest";
import { WorkspaceDocuments } from "./documents";
import { InMemoryFileSession } from "../../file/testing";
import { InMemoryEditorStorage } from "./testing";
import { EditorViewSession } from "./view-state";
import type { EditorViewState } from "./persistence";

const stores: WorkspaceDocuments[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.dispose();
});
const first: EditorViewState = {
  kind: "codemirror",
  length: 10,
  ranges: [{ anchor: 2, head: 5 }],
  mainIndex: 0,
  scrollTop: 140,
  scrollLeft: 20,
  folds: [{ from: 6, to: 9 }],
};
const second: EditorViewState = { ...first, ranges: [{ anchor: 7, head: 8 }], scrollTop: 300 };

describe("editor view continuity", () => {
  test("restored tab hints do not override the saved caret, but fresh navigation does", () => {
    const store = new WorkspaceDocuments("/repo", new InMemoryFileSession());
    stores.push(store);
    const session = new EditorViewSession({
      document: store.document("source.ts"),
      viewId: "view",
      serverId: "host",
      storage: null,
      onError() {},
    });
    expect(session.shouldReveal(0, true)).toBe(false);
    expect(session.shouldReveal(0, false)).toBe(true);
    expect(session.shouldReveal(1, true)).toBe(true);
    session.navigated(1);
    expect(session.shouldReveal(1, true)).toBe(false);
    expect(session.shouldReveal(2, true)).toBe(true);
    session.navigated(2);
    session.navigated(1);
    expect(session.shouldReveal(2, true)).toBe(false);
  });
  test("restores independent views of the same document without losing selections or folds", async () => {
    const storage = new InMemoryEditorStorage();
    const store = new WorkspaceDocuments("/repo", new InMemoryFileSession());
    stores.push(store);
    const document = store.document("source.ts");
    const left = new EditorViewSession({
      document,
      viewId: "left",
      serverId: "host",
      storage,
      onError() {},
    });
    const right = new EditorViewSession({
      document,
      viewId: "right",
      serverId: "host",
      storage,
      onError() {},
    });
    left.save(first);
    left.flush();
    right.save(second);
    right.flush();
    await vi.waitFor(() => expect(storage.views.size).toBe(2));
    document.viewStates.clear();
    expect(await left.load()).toEqual(first);
    expect(await right.load()).toEqual(second);
  });

  test("keeps view state out of document content and isolates hosts", async () => {
    const storage = new InMemoryEditorStorage();
    const store = new WorkspaceDocuments("/repo", new InMemoryFileSession());
    stores.push(store);
    const document = store.document("source.ts");
    const session = new EditorViewSession({
      document,
      viewId: "view",
      serverId: "one",
      storage,
      onError() {},
    });
    session.save(first);
    session.flush();
    await vi.waitFor(() => expect(storage.views.size).toBe(1));
    document.viewStates.clear();
    expect(
      await new EditorViewSession({
        document,
        viewId: "view",
        serverId: "two",
        storage,
        onError() {},
      }).load(),
    ).toBeNull();
    expect(document.model.getSnapshot().content).toBe("");
    expect(document.model.getSnapshot().modified).toBe(false);
  });
});
