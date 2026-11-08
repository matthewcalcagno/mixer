import { expect, test } from "../support/fixtures";
import type { Page } from "@playwright/test";
import { openAddProjectFlow, addProjectFlow } from "../support/helpers/add-project-flow";
import { installUsageReportsFixture } from "../support/helpers/usage-reports";
import {
  claudeAndCodexReports,
  expectPinnedUsage,
  openCompactSidebar,
  expectCompactSidebarOpen,
} from "../support/helpers/usage-sidebar-item";
import { gotoAppShell } from "../support/helpers/app";
import { seedWorkspace } from "../support/helpers/seed-client";
import { SHOWCASE_PLUGIN_ID, installSidebarPlugins } from "../support/helpers/plugin-sidebar-items";
import {
  expectFooterIconRow,
  expectFooterSeparator,
  expectFooterOrder,
  expectFooterSettingsKeys,
  expectSidebarItemHidden,
  expectSidebarNavSettingsOrder,
  expectSidebarNavSettingsRow,
  expectSidebarOrder,
  expectStoredSidebarNav,
  leaveSettings,
  moveFooterItemUp,
  moveSidebarNavItemUp,
  openSidebarNavSettings,
  seedSidebarFooterPreferences,
  seedSidebarNavPreferences,
  setFooterItemVisible,
  setSidebarNavItemVisible,
} from "../support/helpers/sidebar-nav-settings";

async function showDeveloperToast(page: Page): Promise<void> {
  await page.evaluate(() => {
    document.getElementById("error-toast")?.remove();
    const toast = document.createElement("div");
    toast.id = "error-toast";
    toast.style.cssText = "position:fixed;inset:0;z-index:2147483647;background:white";
    // Expo renders its unnamed dismiss button in an open shadow root.
    const button = document.createElement("button");
    button.style.cssText = "width:24px;height:24px";
    button.addEventListener("click", () => toast.remove());
    toast.attachShadow({ mode: "open" }).appendChild(button);
    document.body.appendChild(toast);
  });
}

async function resizeSidebarActions(page: Page, offset: number) {
  const handle = page
    .getByTestId("sidebar-actions-divider")
    .filter({ visible: true })
    .getByRole("separator");
  const bounds = await handle.boundingBox();
  if (!bounds) throw new Error("Missing sidebar section divider");
  const x = bounds.x + bounds.width / 2;
  const y = bounds.y + bounds.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x, y + offset, { steps: 10 });
  await page.mouse.up();
}

test("desktop-only home and settings omit mobile actions", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ colorScheme: "dark" });
  await gotoAppShell(page);
  await expect(page.getByTestId("open-project-submit")).toBeVisible();
  await expect(page.getByTestId("open-project-pair-device")).toHaveCount(0);
  const emptyProjects = page.getByTestId("sidebar-project-empty-state");
  await expect(
    emptyProjects.getByRole("button", { name: "Add project", exact: true }),
  ).toBeVisible();
  await expect(
    emptyProjects.getByRole("button", { name: "Import session", exact: true }),
  ).toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath("desktop-only-home.png") });
  await openSidebarNavSettings(page);
  await expect(page.getByTestId("settings-detail-pane")).toBeVisible();
  await expect(page.getByText("Pair device", { exact: true })).toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath("desktop-only-settings.png") });
});

test("Actions and Workspaces resize independently, persist the split, and include plugin action items", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ colorScheme: "dark" });
  const workspace = await seedWorkspace({ repoPrefix: "sidebar-section-resize-" });
  const plugins = await installSidebarPlugins();
  try {
    await gotoAppShell(page);
    const actions = page.getByTestId("sidebar-actions-scroll").filter({ visible: true });
    const workspaces = page.getByTestId("sidebar-workspaces-section").filter({ visible: true });
    const deploys = actions.getByTestId(`plugin-sidebar-${SHOWCASE_PLUGIN_ID}-deploys`);
    await expect(deploys).toBeAttached();
    await expect(actions.getByText("Bot 1", { exact: true })).toBeAttached();
    await expect(actions.getByText("Legacy entry", { exact: true })).toBeAttached();
    const footer = page
      .getByTestId(`plugin-sidebar-footer-${SHOWCASE_PLUGIN_ID}-sync`)
      .filter({ visible: true });
    await expect(footer).toBeVisible();
    const initialActions = await actions.boundingBox();
    const initialWorkspaces = await workspaces.boundingBox();
    if (!initialActions || !initialWorkspaces) throw new Error("Missing sidebar sections");
    await resizeSidebarActions(page, -100);
    await expect
      .poll(async () => (await actions.boundingBox())?.height ?? Infinity)
      .toBeLessThan(initialActions.height - 70);
    await expect
      .poll(async () => (await workspaces.boundingBox())?.height ?? 0)
      .toBeGreaterThan(initialWorkspaces.height + 70);
    expect(await actions.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(
      true,
    );
    await deploys.scrollIntoViewIfNeeded();
    await deploys.click();
    await expect(page.getByText("Deploys screen body", { exact: true })).toBeVisible();
    await expect
      .poll(() => page.evaluate(() => localStorage.getItem("sidebar-view")))
      .toContain('"actionsSectionRatio":');
    const savedHeight = (await actions.boundingBox())?.height;
    if (savedHeight === undefined) throw new Error("Missing resized Actions section");
    await page.reload();
    await expect(actions.getByText("Bot 1", { exact: true })).toBeAttached();
    await expect(footer).toBeVisible();
    await expect
      .poll(async () => (await actions.boundingBox())?.height ?? 0)
      .toBeCloseTo(savedHeight, 0);
    await resizeSidebarActions(page, 160);
    await expect
      .poll(async () => (await actions.boundingBox())?.height ?? 0)
      .toBeGreaterThan(savedHeight + 100);
    await page.mouse.move(700, 300);
    await page.screenshot({ path: test.info().outputPath("resizable-sidebar-plugin-actions.png") });
  } finally {
    await plugins.cleanup();
    await workspace.cleanup();
  }
});

test("developer toasts leave concurrent sidebar layout checks uninterrupted", async ({ page }) => {
  await gotoAppShell(page);
  await showDeveloperToast(page);
  await expectSidebarOrder(page, ["new-workspace", "history", "search"]);
  await expect(page.locator("#error-toast")).toBeHidden();
});

test("Usage belongs to the status bar and not the sidebar footer preferences", async ({ page }) => {
  await installUsageReportsFixture(page, { lists: [() => claudeAndCodexReports()] });
  await seedSidebarFooterPreferences(page, [{ key: "usage", visible: true }]);
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoAppShell(page);
  await expectPinnedUsage(page, ["31% 5h", "54% wk", "7% 5h", "12% wk"]);
  await expect(page.getByTestId("sidebar-footer").getByTestId("status-bar-usage")).toHaveCount(0);
  await openSidebarNavSettings(page);
  await expectFooterSettingsKeys(page, []);
  await leaveSettings(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await openCompactSidebar(page);
  await expect(page.locator('[data-testid="sidebar-add-project"]:visible')).toBeVisible();
  await expectFooterIconRow(page);
  await expectFooterSeparator(page, false);
  await openAddProjectFlow(page);
  await page.keyboard.press("Escape");
  await expect(addProjectFlow(page)).toBeHidden();
  await expectCompactSidebarOpen(page);
});

test.describe("Sidebar items in Appearance settings", () => {
  test("owner reorders and hides top-level sidebar items", async ({ page }) => {
    await gotoAppShell(page);

    await test.step("the sidebar starts in the default order", async () => {
      await expectSidebarOrder(page, ["new-workspace", "history", "search"]);
    });

    await test.step("the Sidebar section lists every item in the same order", async () => {
      await openSidebarNavSettings(page);
      // The section explains itself through the header's info tooltip, not a paragraph.
      await expect(page.getByTestId("sidebar-nav-section-header-info")).toHaveAccessibleName(
        "About Header",
      );
      await expectSidebarNavSettingsOrder(page, ["new-workspace", "history", "search"]);
      await expectSidebarNavSettingsRow(page, {
        key: "history",
        label: "History",
        visible: true,
      });
      await expect(page.getByTestId("sidebar-nav-item-schedules")).toHaveCount(0);
      await page.screenshot({ path: test.info().outputPath("sidebar-without-schedule.png") });
    });

    await test.step("moving Search up lifts it above History", async () => {
      await moveSidebarNavItemUp(page, "search");
      await expectSidebarNavSettingsOrder(page, ["new-workspace", "search", "history"]);

      await leaveSettings(page);
      await expectSidebarOrder(page, ["new-workspace", "search", "history"]);
    });

    await test.step("turning History off removes it from the sidebar", async () => {
      await openSidebarNavSettings(page);
      await setSidebarNavItemVisible(page, "history", false);
      await expectStoredSidebarNav(page, [
        { key: "new-workspace", visible: true },
        { key: "search", visible: true },
        { key: "history", visible: false },
      ]);

      await leaveSettings(page);
      await expectSidebarItemHidden(page, "history");
      await expectSidebarOrder(page, ["new-workspace", "search"]);
    });

    await test.step("the sidebar keeps that shape across a reload", async () => {
      await page.reload();
      await expectSidebarItemHidden(page, "history");
      await expectSidebarOrder(page, ["new-workspace", "search"]);
    });
  });

  test("renders no top-level items when every one is turned off", async ({ page }) => {
    await seedSidebarNavPreferences(page, [
      { key: "new-workspace", visible: false },
      { key: "history", visible: false },
      { key: "search", visible: false },
    ]);
    await gotoAppShell(page);

    // The sidebar itself still renders; only its top-level nav items are gone.
    await expect(page.locator('[data-testid="sidebar-settings"]:visible')).toBeVisible({
      timeout: 30_000,
    });
    await expectSidebarItemHidden(page, "new-workspace");
    await expectSidebarItemHidden(page, "history");
    await expectSidebarItemHidden(page, "search");
    await expectSidebarItemHidden(page, "search");
    await expect(page.getByTestId("sidebar-actions-divider")).toHaveCount(0);
    await page.setViewportSize({ width: 390, height: 844 });
    await openCompactSidebar(page);
    await expectCompactSidebarOpen(page);
    const close = page.getByTestId("sidebar-close").filter({ visible: true });
    await expect(close).toBeVisible();
    await close.click();
    await expect(close).not.toBeInViewport();
  });
});

test.describe("Sidebar footer rows in Appearance settings", () => {
  const syncKey = `plugin:${SHOWCASE_PLUGIN_ID}:sync`;
  const brokenKey = `plugin:${SHOWCASE_PLUGIN_ID}:broken`;
  let cleanup: () => Promise<void>;

  test.beforeEach(async () => {
    ({ cleanup } = await installSidebarPlugins());
  });

  test.afterEach(async () => {
    await cleanup();
  });

  test("owner reorders and hides footer rows; the icon row stays fixed", async ({ page }) => {
    test.setTimeout(120_000);
    // The Usage item shows only with summary data.
    await installUsageReportsFixture(page, { lists: [() => claudeAndCodexReports()] });
    // Keys for the fixed footer icon buttons are ignored.
    await seedSidebarFooterPreferences(page, [
      { key: "usage", visible: true },
      { key: "help", visible: false },
      { key: "hosts", visible: false },
      { key: "import", visible: false },
    ]);
    await gotoAppShell(page);

    await test.step("the Footer card lists only the footer rows", async () => {
      await openSidebarNavSettings(page);
      await expect(page.getByTestId("sidebar-nav-section-footer-info")).toHaveAccessibleName(
        "About Footer",
      );
      await expectFooterSettingsKeys(page, [syncKey, brokenKey]);
      await leaveSettings(page);
      await expectFooterOrder(page, [syncKey]);
      await expect(page.getByTestId("sidebar-hosts-trigger")).toBeVisible();
      await expectFooterSeparator(page, true);
    });

    await test.step("moving and hiding a plugin footer item leaves Usage untouched", async () => {
      await openSidebarNavSettings(page);
      await moveFooterItemUp(page, brokenKey);
      await setFooterItemVisible(page, brokenKey, false);
      await expectFooterSettingsKeys(page, [brokenKey, syncKey]);
      await leaveSettings(page);
      await expectPinnedUsage(page, ["31% 5h", "54% wk", "7% 5h", "12% wk"]);
      await expect(
        page.locator(`[data-testid="plugin-sidebar-footer-${SHOWCASE_PLUGIN_ID}-sync"]:visible`),
      ).toBeVisible();
      await expect(page.getByTestId("sidebar-hosts-trigger")).toBeVisible();
      await expectFooterSeparator(page, true);
    });

    await test.step("the rows keep that shape across a reload", async () => {
      await page.reload();
      await expect(
        page.locator(`[data-testid="plugin-sidebar-footer-${SHOWCASE_PLUGIN_ID}-sync"]:visible`),
      ).toBeVisible({ timeout: 30_000 });
      await expectPinnedUsage(page, ["31% 5h", "54% wk", "7% 5h", "12% wk"]);
      await expect(page.getByTestId("sidebar-hosts-trigger")).toBeVisible();
      await expectFooterSeparator(page, true);
      await openSidebarNavSettings(page);
      await expectFooterSettingsKeys(page, [brokenKey, syncKey]);
    });
  });
});
