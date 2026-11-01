import { describe, expect, it } from "vitest";
import { resolveDesktopViewportInset, resolveKeyboardLift } from "./policy";

describe("desktop viewport insets", () => {
  it("leaves a normal Electron window unchanged", () => {
    expect(
      resolveDesktopViewportInset({
        windowHeight: 900,
        viewportHeight: 900,
        viewportTop: 0,
        scale: 1,
      }),
    ).toBe(0);
  });
  it("accounts for an occluded visual viewport", () => {
    expect(
      resolveDesktopViewportInset({
        windowHeight: 900,
        viewportHeight: 600,
        viewportTop: 10,
        scale: 1,
      }),
    ).toBe(290);
  });
  it("does not mistake pinch zoom for viewport occlusion", () => {
    expect(
      resolveDesktopViewportInset({
        windowHeight: 900,
        viewportHeight: 450,
        viewportTop: 0,
        scale: 2,
      }),
    ).toBe(0);
  });
  it("never returns a negative inset", () => {
    expect(
      resolveDesktopViewportInset({
        windowHeight: 900,
        viewportHeight: 950,
        viewportTop: 0,
        scale: 1,
      }),
    ).toBe(0);
  });
  it("respects disabled translation and existing clearance", () => {
    expect(resolveKeyboardLift({ shift: 200, enabled: true, bottomClearance: 20 })).toBe(180);
    expect(resolveKeyboardLift({ shift: 200, enabled: false, bottomClearance: 20 })).toBe(0);
  });
});
