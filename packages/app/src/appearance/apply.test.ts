import { beforeEach, describe, expect, it, vi } from "vitest";
import { darkHighlightColors, resolveSyntaxColors } from "@mixer/highlight";
import { DEFAULT_UI_FONT_STACK, REGISTERED_THEMES, darkTheme } from "@/styles/theme";
import { applyAppearance, type AppearanceInput } from "./apply";
import { sidebarTypography } from "@/components/sidebar/typography";
import { sidebarSpacing } from "@/components/sidebar/spacing";

// Override the global react-native-unistyles mock (vitest.setup.ts) so that
// UnistylesRuntime.updateTheme is a spy that records (themeName, updater) calls.
const { runtime, updateTheme } = vi.hoisted(() => {
  const updateThemeSpy = vi.fn();
  return {
    runtime: { themeName: undefined as string | undefined, updateTheme: updateThemeSpy },
    updateTheme: updateThemeSpy,
  };
});
vi.mock("react-native-unistyles", () => ({ UnistylesRuntime: runtime }));

const ALL_THEME_KEYS = Object.keys(REGISTERED_THEMES);

// The signature of the updater passed to UnistylesRuntime.updateTheme.
type ThemeUpdater = (theme: FakeTheme) => FakeTheme;

// The subset of the theme shape the updater reads / spreads. The real Theme type
// is a frozen `as const` literal; the updater only touches these fields. Casting a
// fake of this shape through `unknown` to ThemeUpdater's param is test-only.
interface FakeTheme {
  colorScheme: "light" | "dark";
  fontFamily: { ui: string; mono: string };
  fontSize: {
    chrome: number;
    code: number;
    content: number;
    xs: number;
    sm: number;
    base: number;
    lg: number;
    xl: number;
    "2xl": number;
    "3xl": number;
    "4xl": number;
  };
  lineHeight: { diff: number };
  contentMaxWidth: number;
  colors: { foreground: string; syntax: Record<string, string> };
}

function makeFakeTheme(): FakeTheme {
  return {
    colorScheme: "dark",
    fontFamily: { ui: "seed-ui-stack", mono: "seed-mono-stack" },
    fontSize: {
      chrome: 13,
      code: 12,
      content: 15,
      xs: 11,
      sm: 12,
      base: 14,
      lg: 16,
      xl: 18,
      "2xl": 20,
      "3xl": 22,
      "4xl": 26,
    },
    lineHeight: { diff: 22 },
    contentMaxWidth: 820,
    colors: { foreground: "#fff", syntax: {} },
  };
}

function makeInput(overrides: Partial<AppearanceInput> = {}): AppearanceInput {
  return {
    uiFontFamily: "",
    monoFontFamily: "",
    uiBaseFontSize: 14,
    contentFontSize: 15,
    codeFontSize: 12,
    contentMaxWidth: 820,
    syntaxTheme: "one",
    ...overrides,
  };
}

// Run a single captured updater (default the first) against a fresh fake theme.
function runCapturedUpdater(call = 0): FakeTheme {
  const updater = updateTheme.mock.calls[call]?.[1] as unknown as ThemeUpdater;
  return updater(makeFakeTheme());
}

describe("applyAppearance", () => {
  it("keeps sidebar rows on one spacing rhythm without shrinking compact touch targets", () => {
    const spacing = sidebarSpacing(darkTheme);
    expect(spacing.row).toEqual({
      minHeight: { xs: 44, md: 28 },
      paddingVertical: { xs: 8, md: 4 },
      paddingLeft: 8,
      paddingRight: { xs: 12, md: 8 },
      marginBottom: 2,
    });
    expect(spacing.groupHeader.paddingRight).toBe(8);
    expect(spacing.indent).toEqual({ xs: 16, md: 12 });
    expect(spacing.groupEnd).toEqual({ paddingBottom: { xs: 12, md: 6 } });
    expect(spacing.titleMetadata).toEqual({ gap: 2 });
  });
  it("keeps sidebar titles and metadata on separate aligned text roles", () => {
    expect(sidebarTypography(makeFakeTheme())).toEqual({
      primary: { fontSize: 13, lineHeight: 20 },
      secondary: { fontSize: 12, lineHeight: 16 },
      workspaceTitle: { fontSize: { xs: 13, md: 12 }, lineHeight: { xs: 20, md: 18 } },
      workspaceMetadata: { fontSize: { xs: 12, md: 11 }, lineHeight: { xs: 16, md: 15 } },
      trailing: { fontSize: { xs: 12, md: 11 }, lineHeight: { xs: 20, md: 18 } },
    });
  });

  it("scales sidebar line heights with the user's interface size", () => {
    const theme = makeFakeTheme();
    theme.fontSize.chrome = 18;
    theme.fontSize.sm = 16;
    theme.fontSize.xs = 15;
    expect(sidebarTypography(theme)).toEqual({
      primary: { fontSize: 18, lineHeight: 27 },
      secondary: { fontSize: 16, lineHeight: 21 },
      workspaceTitle: { fontSize: { xs: 18, md: 16 }, lineHeight: { xs: 27, md: 24 } },
      workspaceMetadata: { fontSize: { xs: 16, md: 15 }, lineHeight: { xs: 21, md: 20 } },
      trailing: { fontSize: { xs: 16, md: 15 }, lineHeight: { xs: 27, md: 24 } },
    });
  });
  beforeEach(() => {
    updateTheme.mockClear();
    runtime.themeName = undefined;
  });

  it("patches every registered Unistyles theme exactly once", () => {
    applyAppearance(makeInput());

    expect(updateTheme).toHaveBeenCalledTimes(ALL_THEME_KEYS.length);
    expect(updateTheme.mock.calls.map((call) => call[0])).toEqual([...ALL_THEME_KEYS]);
  });

  it("patches the active theme before inactive registry entries", () => {
    runtime.themeName = "darkPureBlack";

    applyAppearance(makeInput({ uiBaseFontSize: 15 }));

    expect(updateTheme.mock.calls.map((call) => call[0])).toEqual([
      "darkPureBlack",
      ...ALL_THEME_KEYS.filter((key) => key !== "darkPureBlack"),
    ]);
  });

  it("patches the content max width into the theme", () => {
    applyAppearance(makeInput({ contentMaxWidth: 1600 }));

    expect(runCapturedUpdater().contentMaxWidth).toBe(1600);
  });

  it("resolves an empty UI font family to the default stack", () => {
    applyAppearance(makeInput({ uiFontFamily: "" }));

    expect(runCapturedUpdater().fontFamily.ui).toBe(DEFAULT_UI_FONT_STACK);
  });

  it("passes a non-empty UI font family through trimmed", () => {
    applyAppearance(makeInput({ uiFontFamily: "  Menlo  " }));

    expect(runCapturedUpdater().fontFamily.ui).toBe("Menlo");
  });

  it("scales the whole UI ramp proportionally while preserving ratios", () => {
    applyAppearance(makeInput({ uiBaseFontSize: 15 }));

    const { fontSize } = runCapturedUpdater();
    expect(fontSize.base).toBe(15);
    expect(fontSize.sm).toBe(13);
    expect(fontSize.xs).toBe(12);
    expect(fontSize.lg).toBe(17);
    expect(fontSize.xl).toBe(19);
    expect(fontSize["4xl"]).toBe(28);
  });

  it("derives the UI ramp from the canonical sizes, not the live theme (no compounding)", () => {
    applyAppearance(makeInput({ uiBaseFontSize: 15 }));

    // Simulate a theme whose fontSize was already scaled by a prior apply; the
    // updater must ignore it and rebuild from the authored FONT_SIZE ramp.
    const updater = updateTheme.mock.calls[0]?.[1] as unknown as ThemeUpdater;
    const alreadyScaled = makeFakeTheme();
    alreadyScaled.fontSize = {
      chrome: 4,
      code: 4,
      content: 4,
      xs: 4,
      sm: 4,
      base: 4,
      lg: 4,
      xl: 4,
      "2xl": 4,
      "3xl": 4,
      "4xl": 4,
    };

    const { fontSize } = updater(alreadyScaled);
    expect(fontSize.base).toBe(15); // rebuilt from FONT_SIZE, not the live value of 4
    expect(fontSize.lg).toBe(17);
  });

  it("leaves the UI ramp at authored sizes when only the code size changes", () => {
    applyAppearance(makeInput({ uiBaseFontSize: 14, codeFontSize: 10 }));

    const { fontSize } = runCapturedUpdater();
    expect(fontSize.base).toBe(14);
    expect(fontSize.lg).toBe(16);
    expect(fontSize.sm).toBe(12);
    expect(fontSize.code).toBe(10);
  });

  it("sets content size independently of the interface and code sizes", () => {
    applyAppearance(makeInput({ uiBaseFontSize: 14, contentFontSize: 19, codeFontSize: 10 }));

    const { fontSize } = runCapturedUpdater();
    expect(fontSize.base).toBe(14);
    expect(fontSize.content).toBe(19);
    expect(fontSize.code).toBe(10);
  });

  it("keeps desktop chrome at VS Code's size without shrinking chat or code", () => {
    applyAppearance(makeInput({ uiBaseFontSize: 14, contentFontSize: 19, codeFontSize: 17 }));
    const { fontSize } = runCapturedUpdater();
    expect(fontSize.chrome).toBe(13);
    expect(fontSize.base).toBe(14);
    expect(fontSize.content).toBe(19);
    expect(fontSize.code).toBe(17);
    expect(fontSize.sm).toBe(12);
  });

  it("sets fontSize.code to codeFontSize regardless of the UI font size", () => {
    applyAppearance(makeInput({ uiBaseFontSize: 14, codeFontSize: 18 }));

    expect(runCapturedUpdater().fontSize.code).toBe(18);
  });

  it("couples lineHeight.diff to the code font size", () => {
    applyAppearance(makeInput({ codeFontSize: 18 }));

    expect(runCapturedUpdater().lineHeight.diff).toBe(Math.round(18 * 1.5)); // 27
  });

  it("swaps colors.syntax to the resolved palette for the named theme", () => {
    applyAppearance(makeInput({ syntaxTheme: "dracula" }));

    const { colors } = runCapturedUpdater();
    expect(colors.syntax).toEqual(resolveSyntaxColors("dracula", "dark"));
  });

  it("resolves a syntax theme using the theme's own color scheme", () => {
    applyAppearance(makeInput({ syntaxTheme: "github" }));

    // makeFakeTheme().colorScheme === "dark" -> github resolves to the dark palette.
    expect(runCapturedUpdater().colors.syntax).toEqual(darkHighlightColors);
    expect(runCapturedUpdater().colors.syntax).toEqual(resolveSyntaxColors("github", "dark"));
  });
});
