import { expect, type Locator, type Page } from "@playwright/test";
import { test } from "../support/fixtures";
import { runWorkspaceActionFromCommandCenter } from "../support/helpers/command-center-workspace-actions";
import { clickNewChat, gotoWorkspace } from "../support/helpers/launcher";
import { seedWorkspace } from "../support/helpers/seed-client";
import { waitForWorkspaceTabsVisible } from "../support/helpers/workspace-tabs";
import { readFile, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { openFileExplorer, openFileFromExplorer } from "../support/helpers/file-explorer";

function visibleNewTabPanel(page: Page): Locator {
  return page.getByTestId("workspace-new-tab-panel").filter({ visible: true });
}

function paneBounds(elements: Element[]) {
  return elements.map((element) => {
    const bounds = element.getBoundingClientRect();
    return { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height };
  });
}

async function expectLauncherSelection(launcher: Locator, name: string): Promise<void> {
  await expect(launcher.getByRole("button", { name, exact: true })).toBeFocused();
}

async function openExplorerWithKeyboard(page: Page): Promise<Locator> {
  const modifier = process.platform === "darwin" ? "Meta" : "Control";
  await page.keyboard.press(`${modifier}+B`);
  const explorer = page.getByTestId("workspace-explorer-sidebar").filter({ visible: true });
  await expect(explorer).toBeVisible({ timeout: 30_000 });
  return explorer;
}

test.describe("New tab keyboard launcher", () => {
  test("desktop layout defaults toggle both sidebars, open New tab, and split from editor focus", async ({
    page,
  }) => {
    test.skip(process.env.MIXER_WEB_PLATFORM !== "electron", "Uses the desktop Monaco renderer");
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    const workspace = await seedWorkspace({ repoPrefix: "explorer-keyboard-" });
    const modifier = process.platform === "darwin" ? "Meta" : "Control";
    try {
      await writeFile(path.join(workspace.repoPath, "shortcut.ts"), "export const value = 1;\n");
      await gotoWorkspace(page, workspace.workspaceId);
      await waitForWorkspaceTabsVisible(page);
      await openFileExplorer(page);
      await openFileFromExplorer(page, "shortcut.ts");
      const editor = page
        .getByTestId("file-source-editor")
        .filter({ visible: true })
        .frameLocator("iframe");
      const input = editor.getByRole("textbox");
      await input.focus();
      await page.keyboard.press(`${modifier}+b`);
      await expect(
        page.getByTestId("workspace-explorer-sidebar").filter({ visible: true }),
      ).toHaveCount(0);
      await input.focus();
      const explorer = await openExplorerWithKeyboard(page);
      await expect(explorer.getByTestId("file-explorer-tree-scroll")).toBeVisible();
      await input.focus();
      await page.keyboard.press(`${modifier}+Alt+b`);
      await expect(
        page.getByTestId("sidebar-global-new-workspace").filter({ visible: true }),
      ).toHaveCount(0);
      await input.focus();
      await page.keyboard.press(`${modifier}+Alt+b`);
      await expect(
        page.getByTestId("sidebar-global-new-workspace").filter({ visible: true }),
      ).toBeVisible();
      await input.focus();
      await page.keyboard.press(`${modifier}+n`);
      await expect(visibleNewTabPanel(page)).toHaveCount(1);
      const fileTab = page.getByTestId("workspace-tab-file_shortcut.ts").filter({ visible: true });
      await fileTab.click();
      await input.focus();
      await page.keyboard.press(`${modifier}+d`);
      const panes = page.locator('[data-editor-pane="true"]').filter({ visible: true });
      await expect(panes).toHaveCount(2);
      const rightSplit = await panes.evaluateAll(paneBounds);
      expect(rightSplit[1].x).toBeGreaterThan(rightSplit[0].x);
      expect(rightSplit[1].y).toBeCloseTo(rightSplit[0].y, 0);
      await fileTab.click();
      await input.focus();
      await page.keyboard.press(`${modifier}+Shift+d`);
      await expect(panes).toHaveCount(3);
      const downSplit = await panes.evaluateAll(paneBounds);
      expect(downSplit[1].x).toBeCloseTo(downSplit[0].x, 0);
      expect(downSplit[1].y).toBeGreaterThan(downSplit[0].y);
      for (const count of [2, 1]) {
        const emptyPane = panes.filter({ has: page.getByTestId("workspace-new-tab-panel") }).last();
        await emptyPane.locator('[data-testid^="workspace-tab-"]').first().hover();
        await emptyPane.getByRole("button", { name: "Close", exact: true }).click();
        await expect(panes).toHaveCount(count);
      }
      await fileTab.hover();
      await panes.getByRole("button", { name: "Close", exact: true }).click();
      await expect(visibleNewTabPanel(page)).toHaveCount(1);
      const newTabHeaders = panes
        .locator('[data-testid^="workspace-tab-tab_"]')
        .filter({ hasText: "New tab" });
      await expect(newTabHeaders).toHaveCount(0);
      await expect(
        page.getByTestId("workspace-new-tab-button").filter({ visible: true }),
      ).toBeVisible();
      await page.keyboard.press(`${modifier}+n`);
      await expect(newTabHeaders).toHaveCount(2);
      expect(
        (await workspace.client.fetchAgents()).entries.filter(
          (entry) => entry.agent.workspaceId === workspace.workspaceId,
        ),
      ).toEqual([]);
      expect(
        (
          await workspace.client.listTerminals(workspace.repoPath, undefined, {
            workspaceId: workspace.workspaceId,
          })
        ).terminals,
      ).toEqual([]);
    } finally {
      await workspace.cleanup();
    }
  });

  test("New tab shortcuts leave the sandboxed Source Control diff without editing it", async ({
    page,
  }) => {
    test.skip(process.env.MIXER_WEB_PLATFORM !== "electron", "Uses the desktop Monaco renderer");
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    const workspace = await seedWorkspace({ repoPrefix: "diff-layout-shortcut-" });
    try {
      await writeFile(path.join(workspace.repoPath, "shortcut.ts"), "export const value = 1;\n");
      execFileSync("git", ["add", "shortcut.ts"], { cwd: workspace.repoPath });
      execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-m", "Shortcut fixture"], {
        cwd: workspace.repoPath,
      });
      await writeFile(path.join(workspace.repoPath, "shortcut.ts"), "export const value = 2;\n");
      await workspace.client.checkoutRefresh(workspace.repoPath);
      await gotoWorkspace(page, workspace.workspaceId);
      await openFileExplorer(page);
      await page.getByRole("button", { name: "Source Control", exact: true }).click();
      await page
        .getByRole("button", { name: "Open working tree diff for shortcut.ts", exact: true })
        .click();
      const iframe = page
        .locator('iframe[title="shortcut.ts diff editor"]')
        .filter({ visible: true });
      await expect(iframe).toHaveAttribute("sandbox", "allow-scripts");
      await expect(iframe.contentFrame().locator("#editor")).toBeVisible({ timeout: 15_000 });
      const diffInput = iframe.contentFrame().locator(".editor.modified textarea");
      await diffInput.focus();
      await expect(diffInput).toBeFocused();
      await page.keyboard.press(process.platform === "darwin" ? "Meta+n" : "Control+n");
      await expect(visibleNewTabPanel(page)).toHaveCount(1);
      expect(await readFile(path.join(workspace.repoPath, "shortcut.ts"), "utf8")).toBe(
        "export const value = 2;\n",
      );
    } finally {
      await workspace.cleanup();
    }
  });

  test("a new split pane focuses its launcher and supports arrow navigation", async ({ page }) => {
    const workspace = await seedWorkspace({ repoPrefix: "empty-pane-split-keyboard-" });

    try {
      await gotoWorkspace(page, workspace.workspaceId);
      await waitForWorkspaceTabsVisible(page);
      await clickNewChat(page);
      await runWorkspaceActionFromCommandCenter(page, "Split pane right");

      const launcher = visibleNewTabPanel(page);
      await expect(launcher).toBeVisible({ timeout: 30_000 });
      await expectLauncherSelection(launcher, "Agent");

      await page.keyboard.press("ArrowDown");
      await expectLauncherSelection(launcher, "Terminal");
      await page.keyboard.press("ArrowDown");
      await expectLauncherSelection(launcher, "Diff");
      await page.keyboard.press("Enter");

      await expect(
        page.getByTestId("workspace-tab-working_diff").filter({ visible: true }),
      ).toBeVisible({ timeout: 30_000 });
    } finally {
      await workspace.cleanup();
    }
  });
});
