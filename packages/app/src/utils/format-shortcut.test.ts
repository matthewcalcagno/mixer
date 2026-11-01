import { describe, expect, it } from "vitest";

import { electronAccelerator, formatShortcut } from "./format-shortcut";

describe("formatShortcut", () => {
  it("uses symbols on macOS", () => {
    expect(formatShortcut(["mod", "B"], "mac")).toBe("⌘B");
    expect(formatShortcut(["mod", "E"], "mac")).toBe("⌘E");
  });

  it("uses the Shift symbol on macOS and spells it out elsewhere", () => {
    expect(formatShortcut(["shift", "Tab"], "mac")).toBe("⇧Tab");
    expect(formatShortcut(["mod", "shift", "P"], "mac")).toBe("⇧⌘P");
    expect(formatShortcut(["shift", "Tab"], "non-mac")).toBe("Shift+Tab");
  });

  it("uses Ctrl+ on non-mac platforms", () => {
    expect(formatShortcut(["mod", "B"], "non-mac")).toBe("Ctrl+B");
    expect(formatShortcut(["mod", "E"], "non-mac")).toBe("Ctrl+E");
  });
});

describe("native menu shortcut labels", () => {
  it("maps app modifiers and special keys to Electron accelerators", () => {
    expect(electronAccelerator(["mod", "shift", "Backspace"], "mac")).toBe(
      "Command+Shift+Backspace",
    );
    expect(electronAccelerator(["mod", "P"], "non-mac")).toBe("Control+P");
    expect(electronAccelerator(["meta", "F12"], "non-mac")).toBe("Super+F12");
    expect(electronAccelerator(["ctrl", "+"], "mac")).toBe("Control+Plus");
  });
  it("does not pass sequences or unknown keys to the OS menu parser", () => {
    expect(electronAccelerator(["mod", "K", "P"], "mac")).toBeUndefined();
    expect(electronAccelerator(["mod", "Digit[1-9]"], "mac")).toBeUndefined();
    expect(electronAccelerator(["mod", "toString"], "mac")).toBeUndefined();
  });
});
