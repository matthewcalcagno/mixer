import { expect, test } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import { seedSidebarFooterPreferences } from "../support/helpers/sidebar-nav-settings";
import { installUsageReportsFixture } from "../support/helpers/usage-reports";
import {
  claudeAndCodexReports,
  closeUsage,
  expectNoUsageItem,
  expectPinnedUsage,
  openUsageFromIcon,
  openUsageFromItem,
  openUsageOptions,
  closeUsageOptions,
  pinRow,
  showUsageAs,
  togglePin,
  usageItem,
  usageModal,
  installTallUsageSource,
  openCompactSidebar,
  scrollUsageToWindow,
} from "../support/helpers/usage-sidebar-item";

// Usage summaries belong to the desktop status bar, independently of retired sidebar preferences.
test("pins directly into the status bar and updates Used/Remaining immediately and after reload", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await installUsageReportsFixture(page, { lists: [() => claudeAndCodexReports()] });
  await seedSidebarFooterPreferences(page, [{ key: "usage", visible: false }]);
  await gotoAppShell(page);
  const bar = page.getByTestId("workspace-status-bar");
  await expectPinnedUsage(page, ["31% 5h", "54% wk", "7% 5h", "12% wk"]);
  await expect(bar.getByTestId("status-bar-usage")).toBeVisible();
  await expect(page.getByTestId("sidebar-footer").getByTestId("status-bar-usage")).toHaveCount(0);
  await expect(bar.getByTestId("sidebar-usage-icon")).toHaveCount(0);
  await openUsageFromItem(page);
  const modal = usageModal(page);
  await expect(pinRow(modal, "Claude", "Session")).toBeChecked();
  await togglePin(modal, "Claude", "Weekly");
  await expectPinnedUsage(page, ["31% 5h", "7% 5h", "12% wk"]);
  await openUsageOptions(page);
  await expect(page.getByTestId("usage-show-in-sidebar")).toHaveCount(0);
  await page.getByTestId("usage-display-remaining").click();
  await expect(page.getByTestId("usage-display-remaining")).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(page.getByTestId("usage-display-used")).toHaveAttribute("aria-selected", "false");
  await closeUsageOptions(page);
  await expectPinnedUsage(page, ["69% 5h", "93% 5h", "88% wk"]);
  await expect(pinRow(modal, "Claude", "Session")).toContainText("69% left");
  await closeUsage(page);
  await page.reload();
  await expectPinnedUsage(page, ["69% 5h", "93% 5h", "88% wk"]);
  await openUsageFromItem(page);
  await expect(pinRow(usageModal(page), "Claude", "Weekly")).not.toBeChecked();
  await togglePin(usageModal(page), "Claude", "Weekly");
  await expectPinnedUsage(page, ["69% 5h", "46% wk", "93% 5h", "88% wk"]);
  await showUsageAs(page, "used");
  await expectPinnedUsage(page, ["31% 5h", "54% wk", "7% 5h", "12% wk"]);
  await closeUsage(page);
  await page.screenshot({ path: test.info().outputPath("usage-status-bar.png") });
});

test("unpinning every window restores the status-bar icon and repinning needs no switch", async ({
  page,
}) => {
  await installUsageReportsFixture(page, { lists: [() => claudeAndCodexReports()] });
  await gotoAppShell(page);
  await openUsageFromItem(page);
  for (const [source, window] of [
    ["Claude", "Session"],
    ["Claude", "Weekly"],
    ["Codex", "Session"],
    ["Codex", "Weekly"],
  ]) {
    await togglePin(usageModal(page), source, window);
  }
  await expectNoUsageItem(page);
  await closeUsage(page);
  await page.reload();
  await expectNoUsageItem(page);
  await openUsageFromIcon(page);
  await togglePin(usageModal(page), "Codex", "Weekly");
  await expectPinnedUsage(page, ["12% wk"]);
  await closeUsage(page);
  await expect(
    page.getByTestId("workspace-status-bar").getByTestId("sidebar-usage-icon"),
  ).toHaveCount(0);
});

for (const width of [1440, 1000]) {
  test(`bounds many pinned accounts in the status bar at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const base = claudeAndCodexReports()[0];
    const reports = Array.from({ length: 30 }, (_, index) => ({
      ...base,
      id: `claude:account-${index}`,
      account: { label: `account-${index}@example.com` },
    }));
    await installUsageReportsFixture(page, { lists: [reports] });
    await gotoAppShell(page);
    await expect(usageItem(page)).toBeVisible();
    await expect(usageItem(page).getByTestId("status-bar-usage-overflow")).toHaveText("+56");
    const summary = await usageItem(page).boundingBox();
    const hosts = await page.getByTestId("sidebar-hosts-trigger").boundingBox();
    if (!summary || !hosts) throw new Error("Status actions must be visible");
    expect(summary.width).toBeLessThanOrEqual(360);
    expect(summary.x + summary.width).toBeLessThanOrEqual(hosts.x);
    await expect(page.getByTestId("sidebar-hosts-trigger")).toBeInViewport();
    await openUsageFromItem(page);
    await expect(usageModal(page).getByRole("checkbox")).toHaveCount(60);
  });
}

test("no available report leaves a working status-bar Usage icon", async ({ page }) => {
  await installUsageReportsFixture(page, { lists: [[]] });
  await gotoAppShell(page);
  await expectNoUsageItem(page);
  await openUsageFromIcon(page);
  await expect(usageModal(page)).toBeVisible();
});

test("released hosts retain source logos in pinned status-bar summaries", async ({ page }) => {
  await installUsageReportsFixture(page, {
    lists: [() => claudeAndCodexReports()],
    providerUsageListOnly: true,
  });
  await gotoAppShell(page);
  await expectPinnedUsage(page, ["31% 5h", "54% wk", "7% 5h", "12% wk"]);
  const iconPath = /<path[^>]* d="([^"]+)"/.exec(claudeAndCodexReports()[0].icon!)![1];
  await expect(
    usageItem(page).getByTestId("status-bar-usage-source").first().locator("svg path").first(),
  ).toHaveAttribute("d", iconPath);
});

test("opens Usage over the workspace and returns without navigation", async ({
  page,
  withWorkspace,
}) => {
  await installUsageReportsFixture(page, { lists: [() => claudeAndCodexReports()] });
  const workspace = await withWorkspace({ prefix: "usage-status-workspace-" });
  await workspace.navigateTo();
  const url = page.url();
  await expectPinnedUsage(page, ["31% 5h", "54% wk", "7% 5h", "12% wk"]);
  await openUsageFromItem(page);
  await expect(page).toHaveURL(url);
  await page.keyboard.press("Escape");
  await expect(usageModal(page)).toHaveCount(0);
  await expect(page).toHaveURL(url);
});

for (const width of [1440, 390]) {
  test(`long Usage reports remain scrollable at ${width}px`, async ({ page }) => {
    const source = await installTallUsageSource();
    try {
      await page.setViewportSize({ width, height: 900 });
      await gotoAppShell(page);
      if (width === 390) await openCompactSidebar(page);
      await openUsageFromIcon(page);
      const last = usageModal(page).getByText("Window 20", { exact: true });
      await expect(last).not.toBeInViewport();
      await scrollUsageToWindow(page, "Window 20");
      await expect(last).toBeInViewport();
      await scrollUsageToWindow(page, "Window 1");
      await expect(last).not.toBeInViewport();
    } finally {
      await source.cleanup();
    }
  });
}
