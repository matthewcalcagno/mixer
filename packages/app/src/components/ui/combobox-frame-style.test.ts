import type { ViewStyle } from "react-native";
import { describe, expect, it } from "vitest";

import { buildDesktopFrameStyle } from "./combobox-frame-style";

function buildWidthStyle(input: {
  desktopMinWidth?: number;
  referenceWidth: number | null;
}): Pick<ViewStyle, "width" | "minWidth" | "maxWidth"> {
  const [frameStyle] = buildDesktopFrameStyle({
    desktopMinWidth: input.desktopMinWidth,
    desktopLockWidth: false,
    referenceWidth: input.referenceWidth,
    desktopFixedHeight: undefined,
    desktopPositionStyle: { left: 0, top: 0 },
    shouldHideDesktopContent: false,
    availableHeight: undefined,
  }) as ViewStyle[];

  return {
    width: frameStyle.width,
    minWidth: frameStyle.minWidth,
    maxWidth: frameStyle.maxWidth,
  };
}

describe("buildDesktopFrameStyle", () => {
  it("keeps a panel-scoped quick pick aligned with its tabs and centered inside the panel", () => {
    expect(
      buildDesktopFrameStyle({
        presentation: "quick-pick",
        viewport: { width: 1280, height: 720, top: 12 },
        quickPickBounds: { x: 320, y: 64, width: 800, height: 480 },
        desktopMinWidth: undefined,
        desktopLockWidth: false,
        referenceWidth: 100,
        desktopFixedHeight: undefined,
        desktopPositionStyle: { left: 1100, top: 690 },
        shouldHideDesktopContent: true,
        availableHeight: 50,
      }),
    ).toEqual({
      position: "absolute",
      top: 76,
      left: 420,
      width: 600,
      minWidth: 600,
      maxWidth: 600,
      maxHeight: 444,
    });
  });
  it("centers quick picks near the top instead of following the status-bar trigger", () => {
    expect(
      buildDesktopFrameStyle({
        presentation: "quick-pick",
        viewport: { width: 1280, height: 720, top: 12 },
        desktopMinWidth: undefined,
        desktopLockWidth: false,
        referenceWidth: 100,
        desktopFixedHeight: undefined,
        desktopPositionStyle: { left: 1100, top: 690 },
        shouldHideDesktopContent: true,
        availableHeight: 50,
      }),
    ).toEqual({
      position: "absolute",
      top: 12,
      left: 340,
      width: 600,
      minWidth: 600,
      maxWidth: 600,
      maxHeight: 560,
    });
  });
  it("lets a narrow trigger grow to the default desktop ceiling", () => {
    expect(buildWidthStyle({ referenceWidth: 120 })).toEqual({
      width: undefined,
      minWidth: 120,
      maxWidth: 400,
    });
  });

  it("keeps a wide trigger from being capped below its own width", () => {
    expect(buildWidthStyle({ referenceWidth: 470 })).toEqual({
      width: undefined,
      minWidth: 470,
      maxWidth: 470,
    });
  });

  it("uses desktopMinWidth as an explicit floor raiser", () => {
    expect(buildWidthStyle({ desktopMinWidth: 360, referenceWidth: 120 })).toEqual({
      width: undefined,
      minWidth: 360,
      maxWidth: 400,
    });
  });

  it("keeps the trigger as the floor when it is wider than desktopMinWidth", () => {
    expect(buildWidthStyle({ desktopMinWidth: 240, referenceWidth: 300 })).toEqual({
      width: undefined,
      minWidth: 300,
      maxWidth: 400,
    });
  });

  it("locks the frame to its opening floor when content must not resize it", () => {
    const [frameStyle] = buildDesktopFrameStyle({
      desktopMinWidth: 360,
      desktopLockWidth: true,
      referenceWidth: 120,
      desktopFixedHeight: undefined,
      desktopPositionStyle: { left: 0, top: 0 },
      shouldHideDesktopContent: false,
      availableHeight: undefined,
    }) as ViewStyle[];

    expect(frameStyle).toMatchObject({ width: 360, minWidth: 360, maxWidth: 360 });
  });
});
