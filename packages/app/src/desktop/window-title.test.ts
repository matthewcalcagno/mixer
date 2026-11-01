import { describe, expect, it } from "vitest";
import { formatDesktopWindowTitle } from "./window-title";

describe("desktop window title", () => {
  it.each([
    ["query-params.ts", "storeloyalty", "query-params.ts — storeloyalty"],
    ["Fix checkout", "storeloyalty", "Fix checkout — storeloyalty"],
    ["storeloyalty", "storeloyalty", "storeloyalty"],
    ["", "storeloyalty", "storeloyalty"],
    ["", "", "Mixer"],
  ])("formats %s in %s", (label, workspace, expected) => {
    expect(formatDesktopWindowTitle(label, workspace)).toBe(expected);
  });
});
