import { test, expect } from "../../app/e2e/support/fixtures";
import { gotoAppShell, openSettings } from "../../app/e2e/support/helpers/app";

test.describe("Settings sidebar scrolling", () => {
  test.use({ viewport: { width: 900, height: 260 } });

  test("desktop drag region does not cover the scroll body", async ({ page }) => {
    await page.addInitScript(() => {
      window.mixerDesktop = {
        platform: "darwin",
        events: { on: () => () => {} },
        invoke: async (command: string) => {
          if (command === "get_desktop_settings") {
            return {
              releaseChannel: "stable",
              daemon: { manageBuiltInDaemon: true, keepRunningAfterQuit: true },
            };
          }
          return null;
        },
      };
    });

    await gotoAppShell(page);
    const statusActions = page
      .getByTestId("workspace-status-bar")
      .getByTestId("status-bar-global-actions");
    await expect(statusActions).toBeVisible();
    for (const testId of ["sidebar-add-project", "sidebar-usage-icon", "sidebar-hosts-trigger"]) {
      await expect(statusActions.getByTestId(testId)).toBeVisible();
      await expect(page.getByTestId("sidebar-footer").getByTestId(testId)).toHaveCount(0);
    }
    const actionsBounds = await statusActions.boundingBox();
    if (!actionsBounds) throw new Error("Missing status bar actions geometry");
    expect(actionsBounds.x).toBeGreaterThan(450);
    await statusActions.getByTestId("sidebar-hosts-trigger").click();
    await expect(page.getByTestId("sidebar-host-add")).toBeVisible();
    await page.keyboard.press("Escape");
    const titlebar = page.getByTestId("desktop-window-titlebar");
    const settingsButton = titlebar.getByRole("button", { name: "Settings", exact: true });
    await expect(settingsButton).toBeVisible();
    const helpButton = titlebar.getByRole("button", { name: "Help and support", exact: true });
    await expect(helpButton).toBeVisible();
    await expect(page.getByTestId("sidebar-footer").getByTestId("sidebar-help")).toHaveCount(0);
    await expect(
      page.getByTestId("sidebar-footer").getByRole("button", { name: "Settings", exact: true }),
    ).toHaveCount(0);
    const headerBounds = await titlebar.boundingBox();
    const buttonBounds = await settingsButton.boundingBox();
    if (!headerBounds || !buttonBounds) throw new Error("Missing titlebar settings geometry");
    const helpBounds = await helpButton.boundingBox();
    if (!helpBounds) throw new Error("Missing titlebar help geometry");
    expect(helpBounds.x + helpBounds.width).toBeLessThan(buttonBounds.x);
    expect(helpBounds.y + helpBounds.height / 2).toBe(buttonBounds.y + buttonBounds.height / 2);
    expect(
      Math.abs(buttonBounds.y + buttonBounds.height / 2 - headerBounds.y - headerBounds.height / 2),
    ).toBeLessThan(1);
    const iconBounds = await settingsButton.locator("svg").boundingBox();
    if (!iconBounds) throw new Error("Missing settings icon geometry");
    expect(headerBounds.x + headerBounds.width - iconBounds.x - iconBounds.width).toBe(16);
    await helpButton.click();
    await expect(page.getByTestId("sidebar-help-menu")).toBeVisible();
    await page.keyboard.press("Escape");
    await openSettings(page);

    const sidebar = page.getByTestId("settings-sidebar");
    const scrollBody = page.getByTestId("settings-sidebar-scroll-body");
    await expect(sidebar).toBeVisible();
    await expect(scrollBody).toBeVisible();

    const geometry = await sidebar.evaluate((node) => {
      const scrollBodyElement = node.querySelector<HTMLElement>(
        '[data-testid="settings-sidebar-scroll-body"]',
      );
      if (!scrollBodyElement) return null;

      const scrollerRect = scrollBodyElement.getBoundingClientRect();
      const dragRegions = [];
      for (const element of node.querySelectorAll<HTMLElement>("*")) {
        if (getComputedStyle(element).getPropertyValue("-webkit-app-region") === "drag") {
          const rect = element.getBoundingClientRect();
          dragRegions.push({ bottom: rect.bottom });
        }
      }

      return {
        scrollBodyTop: scrollerRect.top,
        dragRegions,
      };
    });

    expect(geometry).not.toBeNull();
    expect(geometry!.dragRegions).not.toEqual([]);
    for (const dragRegion of geometry!.dragRegions) {
      expect(dragRegion.bottom).toBeLessThanOrEqual(geometry!.scrollBodyTop + 1);
    }
  });
});
