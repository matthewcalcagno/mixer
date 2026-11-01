// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { RootThemeColors } from "./root-theme-colors";

vi.mock("react-native-unistyles", () => ({ withUnistyles: (component: unknown) => component }));

it("updates global focus and native control colors when the theme accent changes", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  const root = createRoot(container);
  const style = document.documentElement.style;
  try {
    await act(async () => root.render(<RootThemeColors accent="#387bce" />));
    expect(style.getPropertyValue("--mixer-accent")).toBe("#387bce");

    await act(async () => root.render(<RootThemeColors accent="#cba6f7" />));
    expect(style.getPropertyValue("--mixer-accent")).toBe("#cba6f7");
  } finally {
    await act(async () => root.unmount());
    style.removeProperty("--mixer-accent");
    vi.unstubAllGlobals();
  }
});
