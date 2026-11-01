import { randomUUID } from "node:crypto";
import { test, expect, type Page } from "../support/fixtures";
import { seedWorkspace, type SeedDaemonClient } from "../support/helpers/seed-client";
import { createIdleAgent, expectWorkspaceTabVisible } from "../support/helpers/archive-tab";
import { waitForWorkspaceTabsVisible } from "../support/helpers/workspace-tabs";
import { buildHostAgentDetailRoute } from "@/utils/host-routes";
import { getServerId } from "../support/helpers/server-id";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { gotoAppShell } from "../support/helpers/app";
import { waitForSidebarHydration } from "../support/helpers/workspace-ui";
import { selectWorkspaceInSidebar } from "../support/helpers/sidebar";
import {
  openFileExplorer,
  openFileFromExplorer,
  expectFileTabOpen,
} from "../support/helpers/file-explorer";

test("pinned tabs stay left and visible while ordinary tabs scroll, and survive reload", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.emulateMedia({ colorScheme: "dark" });
  const workspace = await seedWorkspace({ repoPrefix: "pinned-tabs-" });
  const filenames = Array.from(
    { length: 6 },
    (_, index) => `ordinary-long-filename-for-horizontal-scrolling-${index}.ts`,
  );
  async function openFile(filename: string) {
    if (!(await page.getByTestId("file-explorer-tree-scroll").isVisible()))
      await openFileExplorer(page);
    await openFileFromExplorer(page, filename);
    await expectFileTabOpen(page, filename);
  }
  try {
    for (const filename of ["pin.ts", ...filenames])
      await writeFile(path.join(workspace.repoPath, filename), "export const value = true;\n");
    await gotoAppShell(page);
    await waitForSidebarHydration(page);
    await selectWorkspaceInSidebar(page, workspace.workspaceId);
    await openFile("pin.ts");
    const pinnedTab = page.getByTestId("workspace-tab-file_pin.ts").filter({ visible: true });
    await expect(pinnedTab.getByText("pin.ts", { exact: true })).toHaveCSS("font-style", "italic");
    await pinnedTab.click({ button: "right" });
    await page.getByRole("menuitem", { name: "Pin tab", exact: true }).click();
    const pinnedRail = page.getByTestId("workspace-pinned-tabs").filter({ visible: true });
    await expect(pinnedRail.getByTestId("workspace-tab-file_pin.ts")).toBeVisible();
    await expect(pinnedTab.getByText("pin.ts", { exact: true })).toBeVisible();
    await expect(pinnedTab.getByTestId("workspace-tab-pin-indicator")).toBeVisible();
    const before = await pinnedTab.boundingBox();
    if (!before) throw new Error("Missing pinned tab bounds");
    for (const filename of filenames) {
      await openFile(filename);
      await page
        .getByTestId(`workspace-tab-file_${filename}`)
        .filter({ visible: true })
        .getByText(filename, { exact: true })
        .dblclick();
    }
    const row = page
      .getByTestId("workspace-tabs-row")
      .filter({ has: page.getByTestId("workspace-pinned-tabs") });
    const scroll = row.getByTestId("workspace-tabs-scroll");
    expect(
      await scroll.evaluate((node) => {
        node.scrollLeft = node.scrollWidth;
        node.dispatchEvent(new Event("scroll"));
        return node.scrollLeft;
      }),
    ).toBeGreaterThan(0);
    await expect(pinnedTab).toBeVisible();
    expect((await pinnedTab.boundingBox())?.x).toBeCloseTo(before.x, 0);
    await expect(pinnedTab.getByText("pin.ts", { exact: true })).toBeVisible();
    await expect(pinnedTab.getByTestId("workspace-tab-pin-indicator")).toBeVisible();
    await page.screenshot({
      path: test.info().outputPath("pinned-tab-visible-while-scrolled.png"),
    });
    await page
      .getByTestId(`workspace-tab-file_${filenames[5]}`)
      .filter({ visible: true })
      .click({ button: "right" });
    const confirmation = page.waitForEvent("dialog");
    const closeOthers = page
      .getByRole("menuitem", { name: "Close other tabs", exact: true })
      .click();
    await (await confirmation).accept();
    await closeOthers;
    await expect(
      page.getByTestId(`workspace-tab-file_${filenames[0]}`).filter({ visible: true }),
    ).toHaveCount(0);
    await expect(pinnedTab).toBeVisible();
    await page.reload();
    await expect(pinnedRail.getByTestId("workspace-tab-file_pin.ts")).toBeVisible();
    await expect(pinnedTab.getByText("pin.ts", { exact: true })).toBeVisible();
    await expect(pinnedTab.getByTestId("workspace-tab-pin-indicator")).toBeVisible();
    await pinnedTab.click({ button: "right" });
    await page.getByRole("menuitem", { name: "Unpin tab", exact: true }).click();
    await expect(pinnedRail).toHaveCount(0);
    await expect(pinnedTab.getByTestId("workspace-tab-pin-indicator")).toHaveCount(0);
    await expect(pinnedTab.getByText("pin.ts", { exact: true })).toHaveCSS("font-style", "normal");
  } finally {
    await workspace.cleanup();
  }
});

async function openAgentInWorkspace(page: Page, agent: { id: string; workspaceId: string }) {
  await page.goto(buildHostAgentDetailRoute(getServerId(), agent.id, agent.workspaceId));
  await page.waitForURL(
    (url) => url.pathname.includes("/workspace/") && !url.searchParams.has("open"),
    { timeout: 60_000 },
  );
  await waitForWorkspaceTabsVisible(page);
  await expectWorkspaceTabVisible(page, agent.id);
}

async function fetchAgentTitle(client: SeedDaemonClient, agentId: string): Promise<string | null> {
  const result = await client.fetchAgents({ scope: "active" });
  return result.entries.find((entry) => entry.agent.id === agentId)?.agent.title ?? null;
}

test.describe("Workspace agent tab rename", () => {
  test("right-click rename persists the agent title and updates the tab label", async ({
    page,
  }) => {
    test.setTimeout(120_000);

    const workspace = await seedWorkspace({ repoPrefix: "workspace-agent-rename-" });

    try {
      const initialTitle = `agent-rename-${randomUUID().slice(0, 8)}`;
      const agent = await createIdleAgent(workspace.client, {
        cwd: workspace.repoPath,
        workspaceId: workspace.workspaceId,
        title: initialTitle,
      });

      await openAgentInWorkspace(page, agent);

      const tab = page.getByTestId(`workspace-tab-agent_${agent.id}`).first();
      await expect(tab).toContainText(initialTitle, { timeout: 15_000 });

      await tab.click({ button: "right" });
      await expect(page.getByTestId(`workspace-tab-context-agent_${agent.id}`)).toBeVisible({
        timeout: 10_000,
      });
      const renameItem = page.getByTestId(`workspace-tab-context-agent_${agent.id}-rename`);
      await expect(renameItem).toBeVisible({ timeout: 10_000 });
      await renameItem.click();

      const input = page.getByTestId(`workspace-tab-rename-input-agent-${agent.id}`);
      await expect(input).toBeVisible({ timeout: 10_000 });
      await expect(input).toHaveValue(initialTitle);
      await expect(input).toBeFocused();
      expect(
        await input.evaluate((element: HTMLInputElement) => [
          element.selectionStart,
          element.selectionEnd,
        ]),
      ).toEqual([0, initialTitle.length]);

      const renamed = "My Renamed Agent";
      await input.fill(renamed);
      await input.press("Enter");

      await expect(input).toHaveCount(0, { timeout: 15_000 });
      await expect(tab).toContainText(renamed, { timeout: 15_000 });
      await expect.poll(() => fetchAgentTitle(workspace.client, agent.id)).toBe(renamed);
      await tab.getByText(renamed, { exact: true }).dblclick();
      await expect(input).toBeFocused();
      await input.fill("Discard this");
      await input.press("Escape");
      await expect(input).toHaveCount(0);
      await expect(tab).toContainText(renamed);
    } finally {
      await workspace.cleanup();
    }
  });
});
