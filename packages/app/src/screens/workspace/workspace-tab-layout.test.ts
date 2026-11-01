import { describe, expect, it } from "vitest";
import { resolveWorkspaceTabChipBackdrop } from "@/screens/workspace/workspace-tab-chip-backdrop";
import { darkPureBlackTheme, darkTheme, lightTheme } from "@/styles/theme";
import { usesFileTabLabel } from "@/workspace-tabs/file-label";
import {
  computeWorkspaceTabLayout,
  retainWorkspaceTabMeasuredWidth,
} from "@/screens/workspace/workspace-tab-layout";

const metrics = {
  rowHorizontalInset: 0,
  actionsReservedWidth: 120,
  rowPaddingHorizontal: 8,
  tabGap: 4,
  minTabWidth: 64,
  maxTabWidth: 160,
  tabIconWidth: 14,
  tabContentGap: 4,
  tabHorizontalPadding: 8,
  closeButtonWidth: 0,
};

describe("computeWorkspaceTabLayout", () => {
  it("uses filename styling for Files and Source Control comparisons, not general plugin panels", () => {
    expect(usesFileTabLabel({ kind: "file", path: "locale-provider.tsx" })).toBe(true);
    expect(
      usesFileTabLabel({
        kind: "plugin",
        pluginId: "source-control",
        panelId: "file-diff-123",
        context: "workspace",
      }),
    ).toBe(true);
    expect(
      usesFileTabLabel({
        kind: "plugin",
        pluginId: "source-control",
        panelId: "diff-slot-1",
        context: "workspace",
      }),
    ).toBe(true);
    expect(
      usesFileTabLabel({
        kind: "plugin",
        pluginId: "source-control",
        panelId: "source-control",
        context: "workspace",
      }),
    ).toBe(false);
    expect(
      usesFileTabLabel({
        kind: "plugin",
        pluginId: "other",
        panelId: "details",
        context: "workspace",
      }),
    ).toBe(false);
    expect(usesFileTabLabel({ kind: "agent", agentId: "agent-1" })).toBe(false);
  });
  it("scrolls desktop tabs at natural widths when shrinking is disabled", () => {
    const result = computeWorkspaceTabLayout({
      viewportWidth: 460,
      tabLabelWidths: [168, 84, 56],
      metrics,
      compact: false,
      shrinkToFit: false,
    });
    expect(result.items.map((item) => item.width)).toEqual([160, 118, 90]);
    expect(result.requiresHorizontalScrollFallback).toBe(true);
  });
  it("keeps file names at content width while other tabs can shrink", () => {
    const result = computeWorkspaceTabLayout({
      viewportWidth: 460,
      tabLabelWidths: [190, 84],
      tabSizing: [{ kind: "fit", maxWidth: 360, trailingWidth: 24 }, { kind: "shrink" }],
      metrics,
      compact: false,
    });
    expect(result.items.map((item) => item.width)).toEqual([248, 72]);
    expect(result.requiresHorizontalScrollFallback).toBe(false);
  });

  it("scrolls full file labels instead of squeezing them into ellipses", () => {
    const result = computeWorkspaceTabLayout({
      viewportWidth: 460,
      tabLabelWidths: [190, 210],
      tabSizing: [
        { kind: "fit", maxWidth: 360, trailingWidth: 24 },
        { kind: "fit", maxWidth: 360, trailingWidth: 24 },
      ],
      metrics,
      compact: false,
    });
    expect(result.items.map((item) => item.width)).toEqual([248, 268]);
    expect(result.requiresHorizontalScrollFallback).toBe(true);
  });

  it("bounds exceptionally long file labels without changing the cap on other tab types", () => {
    const result = computeWorkspaceTabLayout({
      viewportWidth: 1200,
      tabLabelWidths: [900, 900],
      tabSizing: [{ kind: "fit", maxWidth: 360, trailingWidth: 24 }, { kind: "shrink" }],
      metrics,
      compact: false,
    });
    expect(result.items.map((item) => item.width)).toEqual([360, 160]);
  });

  it("keeps each tab at its natural content width when space is available", () => {
    const result = computeWorkspaceTabLayout({
      viewportWidth: 1200,
      tabLabelWidths: [56, 70, 49],
      metrics,
      compact: false,
    });

    expect(result.closeButtonPolicy).toBe("all");
    expect(result.requiresHorizontalScrollFallback).toBe(false);
    expect(result.items).toHaveLength(3);
    expect(result.items.every((item) => item.showLabel)).toBe(true);
    expect(result.items.map((item) => item.width)).toEqual([90, 104, 83]);
  });

  it("lets short labels use their content width below the old 96px floor", () => {
    const result = computeWorkspaceTabLayout({
      viewportWidth: 300,
      tabLabelWidths: [29, 52],
      metrics: { ...metrics, actionsReservedWidth: 36 },
      compact: false,
    });
    expect(result.items).toEqual([
      { width: 64, showLabel: true },
      { width: 86, showLabel: true },
    ]);
    expect(result.requiresHorizontalScrollFallback).toBe(false);
  });

  it("sizes a single tab between the minimum and maximum from its content", () => {
    const result = computeWorkspaceTabLayout({
      viewportWidth: 1200,
      tabLabelWidths: [105],
      metrics,
      compact: false,
    });

    expect(result.requiresHorizontalScrollFallback).toBe(false);
    expect(result.items.map((item) => item.width)).toEqual([139]);
  });

  it("shrinks natural widths proportionally without crossing the clickable minimum", () => {
    const result = computeWorkspaceTabLayout({
      viewportWidth: 460,
      tabLabelWidths: [168, 84, 56],
      metrics,
      compact: false,
    });

    expect(result.closeButtonPolicy).toBe("all");
    expect(result.requiresHorizontalScrollFallback).toBe(false);
    expect(result.items.map((item) => item.width)).toEqual([132, 102, 82]);
    expect(result.items.every((item) => item.showLabel)).toBe(true);
  });

  it("caps long tabs at the maximum width", () => {
    const result = computeWorkspaceTabLayout({
      viewportWidth: 1004,
      tabLabelWidths: [280, 280, 280, 280],
      metrics: {
        ...metrics,
        actionsReservedWidth: 44,
        rowPaddingHorizontal: 0,
        tabGap: 0,
      },
      compact: false,
    });

    expect(result.closeButtonPolicy).toBe("all");
    expect(result.requiresHorizontalScrollFallback).toBe(false);
    expect(result.items.map((item) => item.width)).toEqual([160, 160, 160, 160]);
  });

  it("keeps every tab at the clickable minimum at the exact fit boundary", () => {
    const result = computeWorkspaceTabLayout({
      viewportWidth: 404,
      tabLabelWidths: [98, 98, 98, 98],
      metrics,
      compact: false,
    });

    expect(result.closeButtonPolicy).toBe("all");
    expect(result.requiresHorizontalScrollFallback).toBe(false);
    expect(result.items.map((item) => item.width)).toEqual([64, 64, 64, 64]);
    expect(result.items.every((item) => item.showLabel)).toBe(true);
  });

  it("scrolls at natural widths rather than shrinking below the clickable minimum", () => {
    const result = computeWorkspaceTabLayout({
      viewportWidth: 403,
      tabLabelWidths: [98, 98, 98, 98],
      metrics,
      compact: false,
    });

    expect(result.closeButtonPolicy).toBe("all");
    expect(result.requiresHorizontalScrollFallback).toBe(true);
    expect(result.items.map((item) => item.width)).toEqual([132, 132, 132, 132]);
    expect(result.items.every((item) => item.showLabel)).toBe(true);
  });

  it("keeps natural widths and no inline close on compact layouts while the tabs fit", () => {
    const result = computeWorkspaceTabLayout({
      viewportWidth: 600,
      tabLabelWidths: [56, 70, 49],
      metrics,
      compact: true,
    });

    expect(result.closeButtonPolicy).toBe("none");
    expect(result.requiresHorizontalScrollFallback).toBe(false);
    expect(result.items.map((item) => item.width)).toEqual([90, 104, 83]);
  });

  it("scrolls compact layouts as soon as natural widths overflow instead of squeezing labels", () => {
    const result = computeWorkspaceTabLayout({
      viewportWidth: 460,
      tabLabelWidths: [168, 84, 56],
      metrics,
      compact: true,
    });

    expect(result.requiresHorizontalScrollFallback).toBe(true);
    expect(result.items.map((item) => item.width)).toEqual([160, 118, 90]);
    expect(result.items.every((item) => item.showLabel)).toBe(true);
  });

  it("returns empty layout details when there are no tabs", () => {
    const result = computeWorkspaceTabLayout({
      viewportWidth: 1200,
      tabLabelWidths: [],
      metrics,
      compact: false,
    });

    expect(result.closeButtonPolicy).toBe("all");
    expect(result.requiresHorizontalScrollFallback).toBe(false);
    expect(result.items).toEqual([]);
  });

  it("uses rendered label width rather than character count", () => {
    const result = computeWorkspaceTabLayout({
      viewportWidth: 1200,
      tabLabelWidths: [68, 104],
      metrics,
      compact: false,
    });

    expect(result.items.map((item) => item.width)).toEqual([102, 138]);
  });
});

describe("retainWorkspaceTabMeasuredWidth", () => {
  it("retains the last usable width while a retained panel is hidden", () => {
    expect(retainWorkspaceTabMeasuredWidth(720, 0)).toBe(720);
  });

  it("accepts the next usable layout width", () => {
    expect(retainWorkspaceTabMeasuredWidth(720, 640)).toBe(640);
  });
});

describe("resolveWorkspaceTabChipBackdrop", () => {
  const themes = { light: lightTheme, dark: darkTheme, pureBlack: darkPureBlackTheme };
  const rails = {
    sidebar: "surfaceSidebar",
    surface: "surface0",
  } as const;

  it("paints the active chip in a colour the rail does not already use, in every theme", () => {
    for (const [, theme] of Object.entries(themes)) {
      for (const [rail, resting] of Object.entries(rails) as Array<
        [keyof typeof rails, (typeof rails)[keyof typeof rails]]
      >) {
        const active = resolveWorkspaceTabChipBackdrop({
          rail,
          isActiveFocused: true,
          isFilled: true,
        });
        const filled = resolveWorkspaceTabChipBackdrop({
          rail,
          isActiveFocused: false,
          isFilled: true,
        });
        expect(theme.colors[active]).not.toBe(theme.colors[resting]);
        expect(theme.colors[filled]).not.toBe(theme.colors[resting]);
        expect(theme.colors[active]).not.toBe(theme.colors[filled]);
      }
    }
  });

  it("rests on the rail surface when the chip is neither active nor hovered", () => {
    expect(
      resolveWorkspaceTabChipBackdrop({ rail: "sidebar", isActiveFocused: false, isFilled: false }),
    ).toBe("surfaceSidebar");
    expect(
      resolveWorkspaceTabChipBackdrop({ rail: "surface", isActiveFocused: false, isFilled: false }),
    ).toBe("surface0");
  });
});
