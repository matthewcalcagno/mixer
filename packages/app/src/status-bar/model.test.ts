import { describe, expect, it } from "vitest";
import { uniqueStatusChoices, updateHiddenStatusItems } from "./model";
import { openLanguagePicker } from "./language-picker-model";
import { editorStatus } from "@/file-panels/source/editor/status";
import type { LanguageMode } from "@/file-panels/source/editor/language-modes";
const modes: LanguageMode[] = [
  {
    id: "java",
    label: "Java",
    monacoId: "java",
    grammar: "java",
    extensions: [".java"],
    filenames: [],
  },
];
describe("status bar visibility preferences", () => {
  it("selects a document mode and keeps file association changes as a separate explicit action", () => {
    const picker = openLanguagePicker("src/file.ts", modes);
    expect(picker.choose("language:java")).toEqual({ kind: "language", mode: "java" });
    expect(picker.choose("auto")).toEqual({ kind: "language", mode: null });
    expect(picker.choose("association")).toBeNull();
    expect(picker.getSnapshot().phase).toBe("association");
    expect(picker.choose("language:java")).toEqual({
      kind: "association",
      pattern: ".ts",
      mode: "java",
    });
    expect(picker.choose("clear")).toEqual({ kind: "association", pattern: ".ts", mode: null });
    expect(picker.choose("back")).toBeNull();
    expect(picker.getSnapshot().phase).toBe("language");
  });
  it("does not let a disposed editor clear its replacement's status", () => {
    const key = editorStatus.key("host", "workspace", "tab");
    const controls = { filename: "Main.java", selectLanguage() {}, focus() {} };
    const previous = editorStatus.register(key, controls);
    previous.publish({ id: "plaintext", modes });
    const current = editorStatus.register(key, controls);
    try {
      expect(editorStatus.getSnapshot().has(key)).toBe(false);
      current.publish({ id: "java", modes });
      previous.dispose();
      expect(editorStatus.getSnapshot().get(key)?.id).toBe("java");
    } finally {
      previous.dispose();
      current.dispose();
    }
    expect(editorStatus.getSnapshot().has(key)).toBe(false);
  });
  it("keeps stable hidden keys across updates and restores items without duplicates", () => {
    const hidden = updateHiddenStatusItems([], "plugin:a:status", false);
    expect(updateHiddenStatusItems(hidden, "plugin:a:status", false)).toEqual(["plugin:a:status"]);
    expect(updateHiddenStatusItems(hidden, "plugin:b:status", false)).toEqual([
      "plugin:a:status",
      "plugin:b:status",
    ]);
    expect(updateHiddenStatusItems(hidden, "plugin:a:status", true)).toEqual([]);
    expect(hidden).toEqual(["plugin:a:status"]);
  });
  it("lists hidden items once, even when a plugin uses one ID in multiple scopes", () => {
    expect(
      uniqueStatusChoices([
        { id: "one", label: "One", checked: false },
        { id: "one", label: "One", checked: false },
      ]),
    ).toEqual([{ id: "one", label: "One", checked: false }]);
  });
});
