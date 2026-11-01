import { EditorState } from "@codemirror/state";
import { describe, expect, test } from "vitest";
import { foldByIndentation } from "./folding";

describe("indentation folding", () => {
  test("folds a JavaScript body without hiding its following sibling", () => {
    const state = EditorState.create({ doc: "function f() {\n  one();\n  two();\n}\nnext();" });
    expect(foldByIndentation(state, 0)).toEqual({ from: 14, to: 32 });
    expect(foldByIndentation(state, 33)).toBeNull();
  });
  test("supports tab-indented Python without grammar-specific providers", () => {
    const state = EditorState.create({ doc: "def f():\n\tone()\n\ttwo()\nnext()" });
    expect(foldByIndentation(state, 0)).toEqual({ from: 8, to: 22 });
  });
  test("does not offer folds for flat text or blank lines", () => {
    const state = EditorState.create({ doc: "one\n\ntwo\nthree" });
    expect(foldByIndentation(state, 0)).toBeNull();
    expect(foldByIndentation(state, 4)).toBeNull();
  });
  test("invalidates cached ranges after an edit", () => {
    const state = EditorState.create({ doc: "parent\n  child" });
    expect(foldByIndentation(state, 0)).toEqual({ from: 6, to: 14 });
    const edited = state.update({ changes: { from: 7, to: 9, insert: "" } }).state;
    expect(foldByIndentation(edited, 0)).toBeNull();
  });
});
