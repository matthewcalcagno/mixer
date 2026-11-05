// @vitest-environment jsdom
import React from "react";
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DesktopWindowTitlebar } from "./window-titlebar";

const route = vi.hoisted(() => ({ pathname: "/settings/about", title: "Mixer" }));
vi.mock("lucide-react-native", () => ({ Settings: () => null }));
vi.mock("expo-router", () => ({ usePathname: () => route.pathname, router: { push: vi.fn() } }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("react-native-unistyles", () => ({
  StyleSheet: { create: () => ({}) },
  withUnistyles: () => () => null,
}));
vi.mock("@/constants/layout", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/constants/layout")>()),
  useIsCompactFormFactor: () => false,
}));
vi.mock("@/constants/platform", () => ({ getIsElectron: () => true }));
vi.mock("@/desktop/window-title", () => ({ useDesktopWindowTitle: () => route.title }));
vi.mock("./titlebar-drag-region", () => ({
  TitlebarDragRegion: () => <div data-testid="drag-region" />,
}));
vi.mock("@/components/ui/pane-content-toolbar", () => ({
  ToolbarButton: () => <button type="button">Settings</button>,
}));
vi.mock("@/components/sidebar/sidebar-help-menu", () => ({
  ApplicationHelpMenu: () => <div data-testid="application-help-menu" />,
}));
vi.mock("@/hooks/use-shortcut-keys", () => ({ useShortcutKeys: () => [] }));
vi.mock("@/utils/desktop-window", () => ({
  useCustomDesktopWindowControls: () => ({ visible: false, mode: null }),
}));
afterEach(cleanup);
beforeEach(() => {
  route.title = "Mixer";
});

it("hides an unavailable workspace's empty title without removing window controls", () => {
  route.pathname = "/h/server/workspace/missing";
  route.title = "";
  const view = render(<DesktopWindowTitlebar visible />);
  expect(view.queryByTestId("desktop-window-title")).toBeNull();
  expect(view.getByTestId("drag-region")).toBeTruthy();
  expect(view.getByRole("button", { name: "Settings" })).toBeTruthy();
});

it.each(["/settings", "/settings/about", "/settings/host/server/agents", "/h/server/settings"])(
  "hides the centered title on %s without removing window chrome",
  (pathname) => {
    route.pathname = pathname;
    const view = render(<DesktopWindowTitlebar visible />);
    expect(view.queryByTestId("desktop-window-title")).toBeNull();
    expect(view.getByTestId("drag-region")).toBeTruthy();
    expect(view.getByRole("button", { name: "Settings" })).toBeTruthy();
  },
);

it("keeps the title on workspace routes", () => {
  route.pathname = "/h/server/workspace/one";
  const view = render(<DesktopWindowTitlebar visible />);
  expect(view.getByTestId("desktop-window-title").textContent).toBe("Mixer");
});

it("keeps the native Help menu registered when the compact window hides its titlebar", () => {
  const view = render(<DesktopWindowTitlebar visible={false} />);
  expect(view.queryByTestId("desktop-window-titlebar")).toBeNull();
  expect(view.getByTestId("application-help-menu")).toBeTruthy();
});
