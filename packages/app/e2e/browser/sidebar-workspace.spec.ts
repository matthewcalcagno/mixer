import path from "node:path";
import type { Page, TestInfo } from "@playwright/test";
import { test, expect } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import { buildHostWorkspaceRoute } from "../../src/utils/host-routes";
import {
  closeMobileAgentSidebar,
  expectMobileAgentSidebarHidden,
  expectMobileAgentSidebarVisible,
  expectWorkspaceHoverCardClosed,
  expectWorkspaceHoverCardOpen,
  expectWorkspaceHoverCardStaysOpen,
  focusWorkspaceRowWithKeyboard,
  movePointerAwayFromWorkspaceHoverCard,
  openMobileAgentSidebar,
  pinWorkspaceFromSidebar,
} from "../support/helpers/sidebar";
import { seedWorkspace } from "../support/helpers/seed-client";
import { expectWorkspaceHeader } from "../support/helpers/workspace-ui";
import { getServerId } from "../support/helpers/server-id";
import { getE2EDaemonPort } from "../support/helpers/daemon-port";
import { projectEquivalenceViewKey } from "../support/helpers/project-view-key";
import { escapeRegex } from "../support/helpers/regex";
import { openFilesPanel } from "../support/helpers/workspace-tabs";
import { seedMockAgentWorkspace } from "../support/helpers/mock-agent";
import {
  actionContextMenuSchema,
  type ActionContextMenuRequest,
} from "../../../desktop/src/features/action-context-menu";

const GITHUB_REMOTE_URL = "https://github.com/test-owner/test-repo.git";

test("projects keep their icons while workspace disclosure stays at the trailing edge", async ({
  page,
}) => {
  const workspace = await seedWorkspace({
    repoPrefix: "project-disclosure-long-project-name-for-label-width-",
  });
  try {
    await page.setViewportSize({ width: 1440, height: 900 });
    await gotoAppShell(page);
    const project = await waitForSidebarProject(page, path.basename(workspace.repoPath));
    const disclosure = project.locator('[data-testid^="sidebar-project-disclosure-"]');
    const title = project.getByText(path.basename(workspace.repoPath), { exact: true });
    await page.mouse.move(1000, 700);
    const idleTitle = await title.boundingBox();
    const idleRow = await project.boundingBox();
    await expect(project.getByTestId("project-icon-only")).toBeVisible();
    await project.hover();
    const projectHoverColor = await project.evaluate(
      (element) => getComputedStyle(element).backgroundColor,
    );
    await expect(project.getByTestId("project-icon-only")).toBeVisible();
    await expect(disclosure).toBeVisible();
    const hoveredTitle = await title.boundingBox();
    const hoveredRow = await project.boundingBox();
    if (!idleRow || !hoveredRow) throw new Error("Missing row geometry");
    expect(Math.abs(idleRow.height - hoveredRow.height)).toBeLessThanOrEqual(1);
    if (!idleTitle || !hoveredTitle) throw new Error("Missing title geometry");
    expect(idleTitle.width - hoveredTitle.width).toBeGreaterThan(20);
    expect(await title.evaluate((element) => getComputedStyle(element).textOverflow)).toBe(
      "ellipsis",
    );
    const bounds = await project.boundingBox();
    const arrow = await disclosure.boundingBox();
    if (!bounds || !arrow) throw new Error("Missing project disclosure geometry");
    expect(bounds.x + bounds.width - (arrow.x + arrow.width)).toBeLessThanOrEqual(12);
    await project.click({
      position: { x: arrow.x - bounds.x + arrow.width / 2, y: bounds.height / 2 },
    });
    await expect(project).toHaveAttribute("aria-expanded", "false");
    await expect(project.getByTestId("project-icon-only")).toBeVisible();
    await expect(
      page.getByTestId(`sidebar-workspace-row-${getServerId()}:${workspace.workspaceId}`),
    ).toBeHidden();
    await project.click();
    await expect(project).toHaveAttribute("aria-expanded", "true");
    await expect(
      page.getByTestId(`sidebar-workspace-row-${getServerId()}:${workspace.workspaceId}`),
    ).toBeVisible();
    await page.getByTestId("sidebar-add-folder").click();
    const input = page.locator('[data-testid^="sidebar-folder-name-"]');
    await input.fill("Empty folder");
    await input.press("Enter");
    await expect(page.locator('[data-testid^="sidebar-folder-disclosure-"]')).toHaveCount(0);
    await page.mouse.move(1000, 700);
    const folder = page.getByRole("button", { name: "Empty folder", exact: true });
    const folderTitle = await folder.getByText("Empty folder", { exact: true }).boundingBox();
    const projectTitle = await title.boundingBox();
    const folderIcon = await folder.locator('[data-testid^="sidebar-folder-icon-"]').boundingBox();
    const projectIcon = await project.getByTestId("project-icon-only").boundingBox();
    if (!folderTitle || !projectTitle || !folderIcon || !projectIcon)
      throw new Error("Missing tree alignment geometry");
    expect(Math.abs(folderTitle.x - projectTitle.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(folderIcon.x - projectIcon.x)).toBeLessThanOrEqual(1);
    expect(folderTitle.x - (folderIcon.x + folderIcon.width)).toBe(4);
    expect(projectTitle.x - (projectIcon.x + projectIcon.width)).toBe(4);
    const folderIdleColor = await folder.evaluate(
      (element) => getComputedStyle(element).backgroundColor,
    );
    const folderIdleBounds = await folder.boundingBox();
    await folder.hover();
    const hoverBackground = folder.getByTestId("sidebar-folder-hover-background");
    await expect(hoverBackground).toBeVisible();
    expect(
      await hoverBackground.evaluate((element) => getComputedStyle(element).backgroundColor),
    ).toBe(projectHoverColor);
    expect(
      await hoverBackground.evaluate((element) => getComputedStyle(element).backgroundColor),
    ).not.toBe(folderIdleColor);
    const folderHoverBounds = await folder.boundingBox();
    const highlightBounds = await hoverBackground.boundingBox();
    if (!folderHoverBounds || !highlightBounds) throw new Error("Missing folder hover geometry");
    expect(folderHoverBounds.x - highlightBounds.x).toBe(2);
    expect(highlightBounds.width - folderHoverBounds.width).toBe(2);
    expect(folderHoverBounds?.width).toBe(folderIdleBounds?.width);
    expect(folderHoverBounds?.height).toBe(folderIdleBounds?.height);
    await page.mouse.move(1000, 700);
    await expect(hoverBackground).toHaveCount(0);
    expect(await folder.evaluate((element) => getComputedStyle(element).backgroundColor)).toBe(
      folderIdleColor,
    );
  } finally {
    await workspace.cleanup();
  }
});

test("a project can be placed before or after a folder without moving inside", async ({ page }) => {
  const workspace = await seedWorkspace({ repoPrefix: "folder-edge-" });
  try {
    await page.setViewportSize({ width: 1440, height: 900 });
    await gotoAppShell(page);
    const projectName = path.basename(workspace.repoPath);
    const project = await waitForSidebarProject(page, projectName);
    await page.getByTestId("sidebar-add-folder").click();
    const input = page.locator('[data-testid^="sidebar-folder-name-"]');
    await input.fill("Clients");
    await input.press("Enter");
    await expect(input).toHaveCount(0);
    const folder = page.getByRole("button", { name: "Clients", exact: true });
    const root = page.getByTestId("sidebar-project-root-list");
    const labels = () =>
      root.evaluate((element) =>
        Array.from(element.children).map((child) =>
          child
            .querySelector('[data-testid^="sidebar-folder-row-"],[role="group"][aria-label]')
            ?.getAttribute("aria-label"),
        ),
      );
    for (const edge of ["before", "after"] as const) {
      const source = await project.boundingBox();
      const target = await folder.boundingBox();
      if (!source || !target) throw new Error("Missing edge drag geometry");
      const y = edge === "before" ? target.y + 2 : target.y + target.height - 2;
      await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2);
      await page.mouse.down();
      await page.mouse.move(target.x + target.width / 2, y, { steps: 25 });
      await expect(
        page.locator(`[data-folder-drop-placement="${edge}"][data-folder-drop-active="true"]`),
      ).toHaveCount(1);
      await page.mouse.up();
      const expected = edge === "before" ? [projectName, "Clients"] : ["Clients", projectName];
      await expect.poll(labels).toEqual(expected);
      const folderId = (await folder.getAttribute("data-testid"))?.replace(
        "sidebar-folder-row-",
        "",
      );
      await expect(
        page
          .getByTestId(`sidebar-folder-${folderId}`)
          .locator('[data-testid^="sidebar-project-row-"]'),
      ).toHaveCount(0);
      await page.reload();
      await expect.poll(labels).toEqual(expected);
    }
  } finally {
    await workspace.cleanup();
  }
});

test("folders can be dragged between root projects and retain their order", async ({ page }) => {
  const first = await seedWorkspace({ repoPrefix: "folder-order-a-" });
  const second = await seedWorkspace({ repoPrefix: "folder-order-b-" });
  try {
    await page.setViewportSize({ width: 1440, height: 900 });
    await gotoAppShell(page);
    await waitForSidebarProject(page, path.basename(first.repoPath));
    await waitForSidebarProject(page, path.basename(second.repoPath));
    await page.getByTestId("sidebar-add-folder").click();
    const input = page.locator('[data-testid^="sidebar-folder-name-"]');
    await input.fill("Clients");
    await input.press("Enter");
    await expect(input).toHaveCount(0);
    const root = page.getByTestId("sidebar-project-root-list");
    const labels = () =>
      root.evaluate((element) =>
        Array.from(element.children).map((child) =>
          child
            .querySelector('[data-testid^="sidebar-folder-row-"],[role="group"][aria-label]')
            ?.getAttribute("aria-label"),
        ),
      );
    const initial = await labels();
    expect(initial[0]).toBe("Clients");
    const folder = page.getByRole("button", { name: "Clients", exact: true });
    const project = root.locator('[data-testid^="sidebar-project-row-"]').first();
    const source = await folder.boundingBox();
    const destination = await project.boundingBox();
    if (!source || !destination) throw new Error("Missing folder drag geometry");
    await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2);
    await page.mouse.down();
    await page.mouse.move(
      destination.x + destination.width / 2,
      destination.y + destination.height / 2,
      { steps: 25 },
    );
    await expect(page.getByTestId("sidebar-folder-drag-preview")).toContainText("Clients");
    await page.mouse.up();
    const expected = [initial[1], "Clients", initial[2]];
    await expect.poll(labels).toEqual(expected);
    await page.reload();
    await expect.poll(labels).toEqual(expected);
  } finally {
    await first.cleanup();
    await second.cleanup();
  }
});

test("dragging a project into a collapsed folder reveals it and persists membership", async ({
  page,
}) => {
  const workspace = await seedWorkspace({ repoPrefix: "folder-drag-" });
  try {
    await page.setViewportSize({ width: 1440, height: 900 });
    await gotoAppShell(page);
    const project = await waitForSidebarProject(page, path.basename(workspace.repoPath));
    await page.getByTestId("sidebar-add-folder").click();
    const name = page.locator('[data-testid^="sidebar-folder-name-"]');
    await name.fill("Clients");
    await name.press("Enter");
    await expect(name).toHaveCount(0);
    await expect(page.getByText("Move projects here from their menu", { exact: true })).toHaveCount(
      0,
    );
    const folderRow = page.getByRole("button", { name: "Clients", exact: true });
    const folderTextColor = await folderRow
      .getByText("Clients", { exact: true })
      .evaluate((element) => getComputedStyle(element).color);
    const projectTextColor = await project
      .getByText(path.basename(workspace.repoPath), { exact: true })
      .evaluate((element) => getComputedStyle(element).color);
    expect(folderTextColor).toBe(projectTextColor);
    await expect(folderRow.locator('[data-testid^="sidebar-folder-disclosure-"]')).toHaveCount(0);
    const folderBounds = await folderRow.boundingBox();
    const workspacePanelBounds = await page
      .getByTestId("sidebar-project-workspace-list-scroll")
      .boundingBox();
    if (!folderBounds || !workspacePanelBounds) throw new Error("Missing folder or panel geometry");
    expect(workspacePanelBounds.width - folderBounds.width).toBeLessThanOrEqual(24);
    await folderRow.click({ position: { x: folderBounds.width - 8, y: folderBounds.height / 2 } });
    await expect(folderRow).toHaveAttribute("aria-expanded", "false");
    const normalProjectIcon = await project.getByTestId("project-icon-only").textContent();
    const source = await project.boundingBox();
    const destination = await folderRow.boundingBox();
    if (!source || !destination) throw new Error("Missing project or folder geometry");
    const folderDropX = destination.x + destination.width - 8;
    await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2);
    await page.mouse.down();
    await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2 + 12, {
      steps: 4,
    });
    await page.mouse.move(folderDropX, destination.y + destination.height / 2, { steps: 20 });
    await expect(page.locator('[data-folder-drop-active="true"]')).toHaveCount(1);
    const insideTarget = await folderRow.boundingBox();
    if (!insideTarget) throw new Error("Missing folder target");
    expect(Math.abs(insideTarget.y - destination.y)).toBeLessThanOrEqual(1);
    expect(await folderRow.evaluate((element) => getComputedStyle(element).cursor)).toBe(
      "grabbing",
    );
    const preview = await page.getByTestId("sidebar-project-drag-preview").boundingBox();
    await expect(
      page.getByTestId("sidebar-project-drag-preview").getByTestId("project-icon-only"),
    ).toHaveText(normalProjectIcon ?? "");
    if (!preview) throw new Error("Missing drag preview");
    expect(Math.abs(preview.x + preview.width / 2 - folderDropX)).toBeLessThan(3);
    expect(
      Math.abs(preview.y + preview.height / 2 - (destination.y + destination.height / 2)),
    ).toBeLessThan(3);
    await page.mouse.up();
    expect(await folderRow.evaluate((element) => getComputedStyle(element).cursor)).not.toBe(
      "grabbing",
    );
    await expect(folderRow).toHaveAttribute("aria-expanded", "true");
    const iconGap = await folderRow.evaluate((element) => {
      const disclosure = element.querySelector('[data-testid^="sidebar-folder-disclosure-"]');
      const icon = element.querySelector('[data-testid^="sidebar-folder-icon-"]');
      if (!disclosure || !icon) throw new Error("Missing folder icon slots");
      return icon.getBoundingClientRect().left - disclosure.getBoundingClientRect().right;
    });
    expect(iconGap).toBe(4);
    const leftInset = await folderRow.evaluate((element) => {
      const arrow = element.querySelector('[data-testid^="sidebar-folder-disclosure-"]');
      if (!arrow) throw new Error("Missing folder disclosure");
      return arrow.getBoundingClientRect().left - element.getBoundingClientRect().left;
    });
    expect(leftInset).toBe(-2);
    await expect(project).toBeVisible();
    const folderLabelBounds = await folderRow.getByText("Clients", { exact: true }).boundingBox();
    const nestedIconBounds = await project.getByTestId("project-icon-only").boundingBox();
    if (!folderLabelBounds || !nestedIconBounds)
      throw new Error("Missing folder label or nested project icon");
    expect(Math.abs(nestedIconBounds.x + 8 - folderLabelBounds.x)).toBeLessThanOrEqual(1);
    const folderId = (await folderRow.getAttribute("data-testid"))?.replace(
      "sidebar-folder-row-",
      "",
    );
    await expect(page.getByTestId(`sidebar-folder-${folderId}`)).toContainText(
      path.basename(workspace.repoPath),
    );
    await page.reload();
    await expect(page.getByTestId(`sidebar-folder-${folderId}`)).toContainText(
      path.basename(workspace.repoPath),
    );
    await expect(project).toBeVisible();
    const nestedSource = await project.boundingBox();
    const panel = await page.getByTestId("sidebar-project-workspace-list-scroll").boundingBox();
    if (!nestedSource || !panel) throw new Error("Missing project or Workspaces panel geometry");
    const rootX = panel.x + panel.width / 2;
    const rootY = panel.y + panel.height * 0.7;
    await page.mouse.move(
      nestedSource.x + nestedSource.width / 2,
      nestedSource.y + nestedSource.height / 2,
    );
    await page.mouse.down();
    await page.mouse.move(rootX, rootY, { steps: 25 });
    await expect(page.locator('[data-folder-root-drop-active="true"]')).toHaveCount(1);
    expect(
      await page
        .getByTestId("sidebar-project-workspace-list-scroll")
        .evaluate((element) => getComputedStyle(element).cursor),
    ).toBe("grabbing");
    const rootPreview = await page.getByTestId("sidebar-project-drag-preview").boundingBox();
    if (!rootPreview) throw new Error("Missing root drag preview");
    expect(Math.abs(rootPreview.x + rootPreview.width / 2 - rootX)).toBeLessThan(3);
    expect(Math.abs(rootPreview.y + rootPreview.height / 2 - rootY)).toBeLessThan(3);
    await page.mouse.up();
    await expect(
      page
        .getByTestId(`sidebar-folder-${folderId}`)
        .locator('[data-testid^="sidebar-project-row-"]'),
    ).toHaveCount(0);
    await expect(project).toBeVisible();
    await page.reload();
    await expect(project).toBeVisible();
    await expect(
      page
        .getByTestId(`sidebar-folder-${folderId}`)
        .locator('[data-testid^="sidebar-project-row-"]'),
    ).toHaveCount(0);
  } finally {
    await workspace.cleanup();
  }
});

test("project folders organize projects without moving their files", async ({ page }) => {
  const workspace = await seedWorkspace({ repoPrefix: "sidebar-folders-" });
  try {
    await page.setViewportSize({ width: 1440, height: 900 });
    await gotoAppShell(page);
    const projectName = path.basename(workspace.repoPath);
    const project = await waitForSidebarProject(page, projectName);
    await page.getByTestId("sidebar-add-folder").click();
    const name = page.locator('[data-testid^="sidebar-folder-name-"]');
    await expect(name).toBeFocused();
    expect(
      await name.evaluate((element: HTMLInputElement) => [
        element.selectionStart,
        element.selectionEnd,
      ]),
    ).toEqual([0, "New folder".length]);
    await name.fill("Clients");
    await name.press("Enter");
    await expect(name).toHaveCount(0);
    const folder = page
      .locator('[data-testid^="sidebar-folder-"]')
      .filter({ has: page.getByRole("button", { name: "Clients", exact: true }) })
      .first();
    await project.click({ button: "right" });
    await page.getByRole("menuitem", { name: "Move to folder", exact: true }).click();
    await page.getByRole("menuitem", { name: "Clients", exact: true }).click();
    await expect(folder).toContainText(projectName);
    await page.getByRole("button", { name: "Clients", exact: true }).click();
    await expect(project).toBeHidden();
    await page.reload();
    await expect(page.getByRole("button", { name: "Clients", exact: true })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    await page.getByRole("button", { name: "Clients", exact: true }).click();
    await expect(project).toBeVisible();
    await page.getByRole("button", { name: "Clients", exact: true }).click({ button: "right" });
    await page.getByRole("menuitem", { name: "Remove folder", exact: true }).click();
    await expect(page.getByRole("button", { name: "Clients", exact: true })).toHaveCount(0);
    await expect(project).toBeVisible();
    await expect(
      page.getByTestId(`sidebar-workspace-row-${getServerId()}:${workspace.workspaceId}`),
    ).toBeVisible();
  } finally {
    await workspace.cleanup();
  }
});

test("project and workspace action menus use the shared native menu bridge", async ({ page }) => {
  const workspace = await seedWorkspace({ repoPrefix: "native-menus-" });
  const menus: ActionContextMenuRequest[] = [];
  const commands: string[] = [];
  try {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.exposeFunction("recordNativeMenu", (request: unknown) => {
      menus.push(actionContextMenuSchema.parse(request));
    });
    await page.exposeFunction("recordNativeCommand", (command: string) => {
      commands.push(command);
    });
    // Keep the runtime identity stable from startup; switching it after boot changes sidebar ownership.
    await page.addInitScript(
      ({ serverId, port }) => {
        window.mixerDesktop = {
          platform: "darwin",
          events: { on: () => () => undefined },
          invoke: async (command) => {
            const record: unknown = Reflect.get(window, "recordNativeCommand");
            if (typeof record === "function") await record(command);
            if (command === "get_desktop_settings")
              return { daemon: { manageBuiltInDaemon: false } };
            if (command === "get_system_idle_time") return 0;
            if (command === "desktop_daemon_status" || command === "start_desktop_daemon")
              return {
                serverId,
                status: "running",
                listen: `127.0.0.1:${port}`,
                hostname: "localhost",
                home: "test-only",
                desktopManaged: false,
                ownedByDesktop: false,
              };
            return null;
          },
          menu: {
            showContextMenu: async (input) => {
              if (input?.kind === "actions") {
                const record: unknown = Reflect.get(window, "recordNativeMenu");
                if (typeof record === "function") await record(input);
                const folder = input.items
                  .find((item) => item.label === "Move to folder")
                  ?.submenu?.find((item) => item.label === "Clients");
                if (folder) return folder.id;
                return input.items.find((item) => item.label === "Rename workspace")?.id ?? null;
              }
              return null;
            },
          },
          editor: {
            listTargets: async () => [
              {
                id: "finder",
                label: "Finder",
                kind: "file-manager",
                icon: { kind: "symbol", name: "folder" },
              },
            ],
            openTarget: async () => undefined,
          },
        };
      },
      { serverId: getServerId(), port: getE2EDaemonPort() },
    );
    await gotoAppShell(page);
    const project = await waitForSidebarProject(page, path.basename(workspace.repoPath));
    const row = await waitForSidebarWorkspace(page, workspace.workspaceId);
    await project.click({ button: "right" });
    await expect.poll(() => menus.length).toBe(1);
    expect(menus[0].items.map((item) => item.label)).toEqual(
      expect.arrayContaining(["Open project settings", "Remove project"]),
    );
    await row.click({ button: "right" });
    await expect.poll(() => menus.length).toBe(2);
    expect(menus[1].items.map((item) => item.label)).toEqual(
      expect.arrayContaining(["Copy path", "Rename workspace", "Labels"]),
    );
    const renameInput = page.getByTestId(
      `sidebar-workspace-rename-input-${getServerId()}:${workspace.workspaceId}`,
    );
    await expect(renameInput).toBeFocused();
    expect(
      await renameInput.evaluate((element: HTMLInputElement) => [
        element.selectionStart,
        element.selectionEnd,
      ]),
    ).toEqual([0, workspace.workspaceName.length]);
    await renameInput.press("Escape");
    await expect(renameInput).toHaveCount(0);
    await project.hover();
    await page
      .locator('[data-testid^="sidebar-project-kebab-"]')
      .filter({ visible: true })
      .first()
      .click();
    await expect.poll(() => menus.length).toBe(3);
    expect(menus[2].items.map((item) => item.label)).toEqual(
      expect.arrayContaining(["Open project settings", "Remove project"]),
    );
    await page.mouse.move(1000, 700);
    await expect(
      page.locator('[data-testid^="sidebar-workspace-context-menu-"]').filter({ visible: true }),
    ).toHaveCount(0);
    await page.getByTestId("sidebar-add-folder").click();
    const folderInput = page.locator('[data-testid^="sidebar-folder-name-"]');
    await folderInput.fill("Clients");
    await folderInput.press("Enter");
    await expect(folderInput).toHaveCount(0);
    await project.click({ button: "right" });
    await expect.poll(() => menus.length).toBe(4);
    expect(
      menus[3].items
        .find((item) => item.label === "Move to folder")
        ?.submenu?.map((item) => item.label),
    ).toEqual(["No folder", "Clients"]);
    await expect(
      page.locator('[data-testid^="sidebar-folder-"]').filter({ has: project }).first(),
    ).toContainText(path.basename(workspace.repoPath));
    await row.click();
    await expect(page.getByTestId("desktop-window-title")).toBeVisible();
    await page.goto(buildHostWorkspaceRoute(getServerId(), "wks_missing_title"));
    await expect(page.getByText("Workspace unavailable", { exact: true })).toBeVisible();
    await expect(page.getByTestId("desktop-window-title")).toHaveCount(0);
    await expect(page.getByTestId("desktop-window-titlebar")).toBeVisible();
    await page.getByRole("button", { name: "Schedules", exact: true }).click();
    await expect(page.getByTestId("schedules-empty")).toBeVisible();
    await expect(page.getByTestId("desktop-window-title")).toHaveCount(0);
    await expect(page.getByTestId("desktop-window-titlebar")).toBeVisible();
  } finally {
    await test.info().attach("native-bridge-commands", {
      body: JSON.stringify(commands),
      contentType: "application/json",
    });
    await workspace.cleanup();
  }
});

function getWorkspaceRowTestId(workspaceId: string): string {
  return `sidebar-workspace-row-${getServerId()}:${workspaceId}`;
}

async function openWorkspaceFromSidebar(
  page: import("@playwright/test").Page,
  workspaceId: string,
) {
  const row = page.getByTestId(getWorkspaceRowTestId(workspaceId));
  await expect(row).toBeVisible({ timeout: 30_000 });
  await row.click();
  await expect(page).toHaveURL(/\/workspace\//, { timeout: 30_000 });
  return row;
}

async function waitForSidebarProject(page: import("@playwright/test").Page, projectName: string) {
  const row = page
    .getByRole("button", {
      name: new RegExp(escapeRegex(projectName), "i"),
    })
    .first();
  await expect(row).toBeVisible({ timeout: 30_000 });
  return row;
}

async function waitForSidebarWorkspace(page: import("@playwright/test").Page, workspaceId: string) {
  const row = page.getByTestId(getWorkspaceRowTestId(workspaceId));
  await expect(row).toBeVisible({ timeout: 30_000 });
  return row;
}

async function openWorkspaceReadAction(
  page: import("@playwright/test").Page,
  workspaceId: string,
  action: "read" | "unread",
) {
  const workspaceKey = `${getServerId()}:${workspaceId}`;
  const row = await waitForSidebarWorkspace(page, workspaceId);
  await row.hover();
  await page.getByTestId(`sidebar-workspace-kebab-${workspaceKey}`).click();
  const item = page.getByTestId(`sidebar-workspace-menu-mark-as-${action}-${workspaceKey}`);
  await expect(item).toBeVisible({ timeout: 30_000 });
  return item;
}

async function openWorkspaceHoverCard(page: import("@playwright/test").Page, workspaceId: string) {
  const row = await waitForSidebarWorkspace(page, workspaceId);
  await row.hover();

  const hoverCard = page.getByRole("menu", { name: "Workspace scripts" });
  await expect(hoverCard).toBeVisible({ timeout: 30_000 });
  return hoverCard;
}

interface MixerOwnedWorktree {
  projectName: string;
  workspaceId: string;
  worktreeSlug: string;
}

async function withMixerOwnedWorktree(
  run: (workspace: MixerOwnedWorktree) => Promise<void>,
): Promise<void> {
  const project = await seedWorkspace({ repoPrefix: "sidebar-hover-owned-worktree-" });
  const worktreeSlug = "hover-card-owned-worktree";

  try {
    const created = await project.client.createWorkspace({
      source: {
        kind: "worktree",
        cwd: project.repoPath,
        projectId: project.projectId,
        worktreeSlug,
      },
    });
    if (!created.workspace) {
      throw new Error(created.error ?? "Failed to create Mixer-owned worktree");
    }
    expect(path.basename(created.workspace.workspaceDirectory)).toBe(worktreeSlug);

    await run({
      projectName: path.basename(project.repoPath),
      workspaceId: created.workspace.id,
      worktreeSlug,
    });
  } finally {
    await project.cleanup();
  }
}

async function readCachedRowIds(
  page: Page,
  rowKind: "workspace" | "checkpoint",
): Promise<string[]> {
  return page.evaluate(
    async ({ serverId, kind }) => {
      const database = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open("mixer-replica-row-store");
        request.addEventListener("success", () => resolve(request.result));
        request.addEventListener("error", () => reject(request.error));
      });
      try {
        return await new Promise<string[]>((resolve, reject) => {
          const transaction = database.transaction("rows", "readonly");
          const request = transaction.objectStore("rows").getAll();
          request.onsuccess = () =>
            resolve(
              request.result
                .filter(
                  (row: { serverId: string; kind: string }) =>
                    row.serverId === serverId && row.kind === kind,
                )
                .map((row: { id: string }) => row.id)
                .sort(),
            );
          request.addEventListener("error", () => reject(request.error));
        });
      } finally {
        database.close();
      }
    },
    { serverId: getServerId(), kind: rowKind },
  );
}

async function simulateDamagedLegacyDirectoryCache(
  page: Page,
  workspaceIdToRemove: string,
): Promise<void> {
  // Stop the app before altering storage so no pending app write can repair the fixture.
  const fixtureUrl = new URL("/__directory_cache_fixture", page.url()).href;
  await page.route(fixtureUrl, (route) =>
    route.fulfill({ contentType: "text/html", body: "<html><body>Cache fixture</body></html>" }),
  );
  await page.goto(fixtureUrl);
  await page.evaluate(
    async ({ serverId, missingWorkspaceId }) => {
      const database = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open("mixer-replica-row-store");
        request.addEventListener("success", () => resolve(request.result));
        request.addEventListener("error", () => reject(request.error));
      });
      try {
        await new Promise<void>((resolve, reject) => {
          const transaction = database.transaction("rows", "readwrite");
          const store = transaction.objectStore("rows");
          const request = store.getAll();
          request.onsuccess = () => {
            const rows = request.result as Array<{
              serverId: string;
              kind: string;
              id: string;
              payload: string;
            }>;
            const checkpoint = rows.find(
              (row) => row.serverId === serverId && row.kind === "checkpoint",
            );
            if (!checkpoint) {
              transaction.abort();
              return;
            }
            const stored = JSON.parse(checkpoint.payload);
            // Accept either writer so this fixture also reproduces on the unfixed client.
            const cursors = stored.version === 1 ? stored.cursors : stored;
            if (!cursors.workspaces?.generation) {
              transaction.abort();
              return;
            }
            store.put({ ...checkpoint, payload: JSON.stringify(cursors) });
            for (const row of rows) {
              if (
                row.serverId === serverId &&
                row.kind === "workspace" &&
                row.id === missingWorkspaceId
              )
                store.delete([serverId, row.kind, row.id]);
            }
          };
          transaction.addEventListener("complete", () => resolve());
          transaction.addEventListener("abort", () =>
            reject(transaction.error ?? new Error("Missing current directory checkpoint")),
          );
          transaction.addEventListener("error", () => reject(transaction.error));
        });
      } finally {
        database.close();
      }
    },
    { serverId: getServerId(), missingWorkspaceId: workspaceIdToRemove },
  );
  expect(await readCachedRowIds(page, "workspace")).not.toContain(workspaceIdToRemove);
}

async function holdHostResponsesUntilCacheIsVisible(page: Page): Promise<() => void> {
  let release!: () => void;
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.routeWebSocket(new RegExp(`:${getE2EDaemonPort()}(?:/|$)`), (socket) => {
    const server = socket.connectToServer();
    server.onMessage(async (message) => {
      await ready;
      socket.send(message);
    });
  });
  return release;
}

async function createPinnedSiblingWorkspace(
  project: Awaited<ReturnType<typeof seedWorkspace>>,
): Promise<string> {
  const sibling = await project.client.createWorkspace({
    source: { kind: "directory", path: project.repoPath, projectId: project.projectId },
    title: "Pinned sibling",
  });
  if (!sibling.workspace) throw new Error(sibling.error ?? "Sibling workspace was not created");
  await project.client.setWorkspacePinned(sibling.workspace.id, true);
  return sibling.workspace.id;
}

async function expectSidebarWorkspaces(page: Page, workspaceIds: string[]): Promise<void> {
  for (const workspaceId of workspaceIds) {
    await waitForSidebarWorkspace(page, workspaceId);
  }
}

async function cacheWorkspaces(page: Page, workspaceIds: string[]): Promise<void> {
  await gotoAppShell(page);
  await expectSidebarWorkspaces(page, workspaceIds);
  await expect.poll(() => readCachedRowIds(page, "workspace")).toEqual(workspaceIds);
}

async function reopenDamagedCacheBeforeHostResponds(
  page: Page,
  missingWorkspaceId: string,
): Promise<() => void> {
  await simulateDamagedLegacyDirectoryCache(page, missingWorkspaceId);
  const releaseHost = await holdHostResponsesUntilCacheIsVisible(page);
  await gotoAppShell(page);
  return releaseHost;
}

async function expectDamagedCacheHydrated(
  page: Page,
  retainedWorkspaceId: string,
  missingWorkspaceId: string,
): Promise<void> {
  await waitForSidebarWorkspace(page, retainedWorkspaceId);
  await expect(page.getByTestId(getWorkspaceRowTestId(missingWorkspaceId))).toHaveCount(0);
  await expect.poll(() => readCachedRowIds(page, "checkpoint")).toEqual([]);
}

async function expectRecoveredWorkspacesAfterReload(
  page: Page,
  workspaceIds: string[],
  testInfo: TestInfo,
): Promise<void> {
  await expectSidebarWorkspaces(page, workspaceIds);
  await expect.poll(() => readCachedRowIds(page, "workspace")).toEqual(workspaceIds);
  await page.reload();
  await expectSidebarWorkspaces(page, workspaceIds);
  await page.screenshot({ path: testInfo.outputPath("recovered-workspaces.png") });
  await testInfo.attach("recovered-workspaces", {
    path: testInfo.outputPath("recovered-workspaces.png"),
    contentType: "image/png",
  });
}

test.describe("Sidebar workspace list", () => {
  test("aligns project and workspace labels above smaller branch and time metadata", async ({
    page,
  }) => {
    await page.addInitScript(() => {
      localStorage.setItem(
        "@mixer:app-settings",
        JSON.stringify({
          uiBaseFontSize: 14,
          contentFontSize: 15,
          workspaceTitleSource: "title",
          sidebarWorkspaceTrailing: "timestamp",
          sidebarRowItems: { branch: true },
        }),
      );
    });
    const workspace = await seedWorkspace({
      repoPrefix: "sidebar-typography-",
      title: "Workspace typography",
    });
    try {
      await gotoAppShell(page);
      const projectName = path.basename(workspace.repoPath);
      await waitForSidebarProject(page, projectName);
      const projectRow = page
        .locator('[data-testid^="sidebar-project-row-"]')
        .filter({ hasText: projectName })
        .first();
      const project = projectRow.getByText(projectName, { exact: true });
      const row = await openWorkspaceFromSidebar(page, workspace.workspaceId);
      const title = row.getByText("Workspace typography", { exact: true });
      const branch = row.getByText("main", { exact: true });
      const time = row.getByTestId("sidebar-workspace-timestamp");
      await expect(project).toHaveCSS("font-size", "13px");
      await expect(project).toHaveCSS("font-weight", "500");
      await expect(project).toHaveCSS("line-height", "20px");
      await expect(title).toHaveCSS("font-size", "13px");
      await expect(title).toHaveCSS("font-weight", "400");
      await expect(title).toHaveCSS("line-height", "20px");
      await expect(title).toHaveCSS("opacity", "1");
      await expect(branch).toHaveCSS("font-size", "12px");
      await expect(branch).toHaveCSS("line-height", "16px");
      await expect(time).toHaveCSS("font-size", "12px");
      await expect(time).toHaveCSS("line-height", "20px");
      await expect(projectRow).toHaveCSS("padding-top", "6px");
      await expect(projectRow).toHaveCSS("padding-bottom", "6px");
      await expect(projectRow).toHaveCSS("min-height", "32px");
      await expect(row).toHaveCSS("padding-top", "6px");
      await expect(row).toHaveCSS("padding-bottom", "6px");
      await expect(row).toHaveCSS("padding-left", "16px");
      const titleBounds = await title.boundingBox();
      const branchBounds = await branch.boundingBox();
      if (!titleBounds || !branchBounds)
        throw new Error("Workspace title and metadata must be visible");
      expect(branchBounds.y - titleBounds.y - titleBounds.height).toBeCloseTo(2, 0);
      const heading = page
        .getByText("Workspaces", { exact: true })
        .filter({ visible: true })
        .first();
      await expect(heading).toHaveCSS("font-size", "12px");
      await expect(heading).toHaveCSS("font-weight", "500");
      await page.mouse.move(900, 600);
      await page.screenshot({ path: test.info().outputPath("workspace-typography.png") });
    } finally {
      await workspace.cleanup();
    }
  });

  test("recovers missing workspaces from a damaged legacy cache after reload", async ({
    page,
  }, testInfo) => {
    const project = await seedWorkspace({ repoPrefix: "directory-cache-recovery-" });
    try {
      const siblingId = await createPinnedSiblingWorkspace(project);
      const ids = [project.workspaceId, siblingId].sort();
      await test.step("cache both workspaces", () => cacheWorkspaces(page, ids));

      const releaseHost = await test.step("reopen damaged cache before host responds", () =>
        reopenDamagedCacheBeforeHostResponds(page, project.workspaceId));
      await test.step("keep cached workspace and discard stale checkpoint", () =>
        expectDamagedCacheHydrated(page, siblingId, project.workspaceId));

      releaseHost();
      await test.step("recover missing workspace and retain both after reload", () =>
        expectRecoveredWorkspacesAfterReload(page, ids, testInfo));
    } finally {
      await project.cleanup();
    }
  });

  test("project with GitHub remote shows its selected folder name in sidebar", async ({ page }) => {
    const workspace = await seedWorkspace({
      repoPrefix: "sidebar-remote-",
      repo: { withRemote: true, originUrl: GITHUB_REMOTE_URL },
    });

    try {
      const projectName = path.basename(workspace.repoPath);
      await gotoAppShell(page);
      await waitForSidebarProject(page, projectName);
      await waitForSidebarWorkspace(page, workspace.workspaceId);

      const projectRow = page
        .locator('[data-testid^="sidebar-project-row-"]')
        .filter({ hasText: projectName })
        .first();

      await expect(projectRow).toBeVisible({ timeout: 30_000 });
      await expect(projectRow).not.toContainText("test-owner/test-repo");
    } finally {
      await workspace.cleanup();
    }
  });

  test("non-git project shows directory name", async ({ page }) => {
    const workspace = await seedWorkspace({ repoPrefix: "sidebar-directory-", git: false });

    try {
      await gotoAppShell(page);

      const directoryName = path.basename(workspace.repoPath);
      const projectRow = await waitForSidebarProject(page, directoryName);
      await expect(projectRow).toContainText(directoryName);
    } finally {
      await workspace.cleanup();
    }
  });

  test("workspace header uses the selected folder name instead of its GitHub remote", async ({
    page,
  }) => {
    const workspace = await seedWorkspace({
      repoPrefix: "sidebar-header-",
      repo: { withRemote: true, originUrl: GITHUB_REMOTE_URL },
    });

    try {
      const projectName = path.basename(workspace.repoPath);
      await gotoAppShell(page);
      await waitForSidebarProject(page, projectName);
      await waitForSidebarWorkspace(page, workspace.workspaceId);
      await openWorkspaceFromSidebar(page, workspace.workspaceId);

      await expectWorkspaceHeader(page, {
        title: workspace.workspaceName,
        subtitle: projectName,
      });
    } finally {
      await workspace.cleanup();
    }
  });

  test("git project shows branch name in workspace row", async ({ page }) => {
    const workspace = await seedWorkspace({ repoPrefix: "sidebar-branch-" });

    try {
      await gotoAppShell(page);
      await waitForSidebarProject(page, path.basename(workspace.repoPath));

      expect(workspace.workspaceName).toBe("main");
      await expect(await waitForSidebarWorkspace(page, workspace.workspaceId)).toContainText(
        "main",
      );
    } finally {
      await workspace.cleanup();
    }
  });

  test("workspace hover card shows host as metadata", async ({ page }) => {
    const workspace = await seedWorkspace({ repoPrefix: "sidebar-hover-host-" });

    try {
      await gotoAppShell(page);
      await waitForSidebarProject(page, path.basename(workspace.repoPath));

      const hoverCard = await openWorkspaceHoverCard(page, workspace.workspaceId);
      await expect(page.getByTestId("hover-card-workspace-host")).toHaveText("localhost");
      await expect(hoverCard).not.toContainText(/\b(Online|Connecting|Offline|Error|Idle)\b/);
    } finally {
      await workspace.cleanup();
    }
  });

  test("workspace hover card closes when the pointer leaves a clicked row", async ({ page }) => {
    const workspace = await seedWorkspace({ repoPrefix: "sidebar-hover-click-leave-" });

    try {
      await gotoAppShell(page);
      await waitForSidebarProject(page, path.basename(workspace.repoPath));
      const row = await openWorkspaceFromSidebar(page, workspace.workspaceId);
      await movePointerAwayFromWorkspaceHoverCard(page);
      await expectWorkspaceHoverCardClosed(page);

      await row.click();
      await expect(row).toBeFocused();
      await expectWorkspaceHoverCardOpen(page);
      await movePointerAwayFromWorkspaceHoverCard(page);
      await expectWorkspaceHoverCardClosed(page);
    } finally {
      await workspace.cleanup();
    }
  });

  test("workspace hover card follows keyboard focus on a row", async ({ page }) => {
    const workspace = await seedWorkspace({ repoPrefix: "sidebar-hover-keyboard-" });

    try {
      await gotoAppShell(page);
      await waitForSidebarProject(page, path.basename(workspace.repoPath));
      await openWorkspaceFromSidebar(page, workspace.workspaceId);
      await movePointerAwayFromWorkspaceHoverCard(page);
      await expectWorkspaceHoverCardClosed(page);

      await focusWorkspaceRowWithKeyboard(page, workspace.workspaceId);
      await expectWorkspaceHoverCardOpen(page);
      await movePointerAwayFromWorkspaceHoverCard(page);
      await expectWorkspaceHoverCardStaysOpen(page);
      await page.keyboard.press("Escape");
      await expectWorkspaceHoverCardClosed(page);

      await focusWorkspaceRowWithKeyboard(page, workspace.workspaceId);
      await expectWorkspaceHoverCardOpen(page);
      await page.keyboard.press("Tab");
      await expectWorkspaceHoverCardClosed(page);
    } finally {
      await workspace.cleanup();
    }
  });

  test("marks a finished workspace unread until it is opened again", async ({ page }) => {
    const workspace = await seedMockAgentWorkspace({
      repoPrefix: "sidebar-mark-unread-",
      title: "Mark unread",
      initialPrompt: "Finish this test turn.",
    });

    try {
      await workspace.client.waitForFinish(workspace.agentId, 20_000);
      await workspace.client.clearWorkspaceAttention(workspace.workspaceId);
      expect(workspace.client.getLastServerInfoMessage()?.features?.workspaceMarkUnread).toBe(true);
      await gotoAppShell(page);

      const row = await waitForSidebarWorkspace(page, workspace.workspaceId);
      await expect(row.getByTestId("workspace-status-indicator-done")).toBeVisible();
      await (await openWorkspaceReadAction(page, workspace.workspaceId, "unread")).click();
      await openWorkspaceReadAction(page, workspace.workspaceId, "read");

      await page.keyboard.press("Escape");
      await openWorkspaceFromSidebar(page, workspace.workspaceId);
      await openWorkspaceReadAction(page, workspace.workspaceId, "unread");
    } finally {
      await workspace.cleanup();
    }
  });

  test("Mixer-owned worktree hover card shows the worktree directory name", async ({ page }) => {
    await withMixerOwnedWorktree(async ({ projectName, workspaceId, worktreeSlug }) => {
      await gotoAppShell(page);
      await waitForSidebarProject(page, projectName);
      await openWorkspaceHoverCard(page, workspaceId);

      await expect(page.getByTestId("hover-card-workspace-cwd")).toHaveText(worktreeSlug);
    });
  });
});

test.describe("Mobile sidebar panelState transition", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("showMobileAgent open and close transition", async ({ page }) => {
    await gotoAppShell(page);
    await expectMobileAgentSidebarHidden(page);
    await openMobileAgentSidebar(page);
    await expectMobileAgentSidebarVisible(page);
    await closeMobileAgentSidebar(page);
    await expectMobileAgentSidebarHidden(page);
  });

  test("places the close button beside the first nav row instead of over it", async ({ page }) => {
    await gotoAppShell(page);
    await openMobileAgentSidebar(page);
    await expectMobileAgentSidebarVisible(page);

    const firstRow = await page.getByTestId("sidebar-global-new-workspace").boundingBox();
    const closeButton = await page.getByTestId("sidebar-close").boundingBox();
    if (!firstRow || !closeButton) throw new Error("first nav row and close button must render");
    expect(closeButton.x).toBeGreaterThanOrEqual(firstRow.x + firstRow.width);
  });

  test("keeps a pinned workspace rendered while the retained sidebar is closed", async ({
    page,
  }) => {
    const workspace = await seedWorkspace({ repoPrefix: "sidebar-retained-pin-" });

    try {
      await gotoAppShell(page);
      await openMobileAgentSidebar(page);
      await expectMobileAgentSidebarVisible(page);

      const row = page.getByTestId(getWorkspaceRowTestId(workspace.workspaceId));
      await expect(row).toBeVisible({ timeout: 30_000 });
      await pinWorkspaceFromSidebar(page, workspace.workspaceId);
      await expect(page.getByTestId("sidebar-pinned-section")).toBeVisible();

      await closeMobileAgentSidebar(page);
      await expectMobileAgentSidebarHidden(page);

      await expect(row).toHaveCount(1);
    } finally {
      await workspace.cleanup();
    }
  });
});

test.describe("Half-screen desktop layout", () => {
  test.use({ viewport: { width: 751, height: 982 } });

  test("keeps the sidebar scroll position across close and reopen", async ({ page }) => {
    const workspace = await seedWorkspace({ repoPrefix: "sidebar-retained-scroll-" });

    try {
      let lastWorkspaceId = workspace.workspaceId;
      for (let index = 0; index < 24; index += 1) {
        const created = await workspace.client.createWorkspace({
          source: {
            kind: "directory",
            path: workspace.repoPath,
            projectId: workspace.projectId,
          },
          title: `Retained sidebar ${index + 1}`,
        });
        if (!created.workspace) {
          throw new Error(created.error ?? "Failed to fill the retained sidebar");
        }
        lastWorkspaceId = created.workspace.id;
      }

      await gotoAppShell(page);
      await page
        .getByTestId(`sidebar-project-show-more-${projectEquivalenceViewKey(workspace.projectKey)}`)
        .click();
      await waitForSidebarWorkspace(page, lastWorkspaceId);

      const sidebarScroll = page.getByTestId("sidebar-project-workspace-list-scroll");
      const scrollTop = await sidebarScroll.evaluate((element) => {
        element.scrollTop = 160;
        return element.scrollTop;
      });
      expect(scrollTop).toBe(160);

      await page.getByTestId("menu-button").click();
      await expect(page.getByTestId("sidebar-global-new-workspace")).not.toBeVisible();

      await page.getByTestId("menu-button").click();
      await expect(page.getByTestId("sidebar-global-new-workspace")).toBeVisible();
      await expect(sidebarScroll).toHaveJSProperty("scrollTop", scrollTop);
    } finally {
      await workspace.cleanup();
    }
  });

  test("keeps the pinned sidebar at half of a 14-inch Mac display", async ({ page }) => {
    await gotoAppShell(page);
    await expect(page.getByTestId("sidebar-global-new-workspace")).toBeVisible();
    await expect(page.getByTestId("agent-list-backdrop")).not.toBeVisible();
  });

  test("keeps the left toggle center-owned without left window controls", async ({ page }) => {
    await gotoAppShell(page);

    const openToggle = page.getByTestId("menu-button");
    const openIcon = openToggle.locator("svg").first();
    await expect(openIcon).toBeVisible();
    const openBounds = await openIcon.boundingBox();
    expect(openBounds).not.toBeNull();
    expect(openBounds?.x).toBeGreaterThan(12);

    await openToggle.click();
    await expect(page.getByTestId("sidebar-global-new-workspace")).not.toBeVisible();

    const closedToggle = page.getByTestId("menu-button");
    const closedIcon = closedToggle.locator("svg").first();
    await expect(closedIcon).toBeVisible();
    const closedBounds = await closedIcon.boundingBox();
    expect(closedBounds).not.toBeNull();
    expect(closedBounds?.x).toBeCloseTo(9, 0);
    expect(closedBounds?.y).toBe(openBounds?.y);
  });

  test("yields app navigation to the settings split", async ({ page }) => {
    await gotoAppShell(page);
    await page.getByTestId("sidebar-settings").click();

    await expect(page.getByTestId("settings-sidebar")).toBeVisible();
    await expect(page.getByTestId("settings-detail-pane")).toBeVisible();
    await expect(page.getByTestId("sidebar-settings")).not.toBeVisible();
  });

  test("yields app navigation to Explorer and restores it when Explorer closes", async ({
    page,
  }) => {
    const workspace = await seedWorkspace({ repoPrefix: "sidebar-half-screen-explorer-" });

    try {
      await gotoAppShell(page);
      await waitForSidebarProject(page, path.basename(workspace.repoPath));
      await openWorkspaceFromSidebar(page, workspace.workspaceId);

      await openFilesPanel(page);
      const explorerToggle = page.getByTestId("workspace-explorer-toggle").first();
      await expect(page.getByTestId("workspace-tab-files").filter({ visible: true })).toBeVisible();
      await expect(explorerToggle).toHaveAccessibleName("Close Explorer sidebar");
      await expect(page.getByTestId("sidebar-global-new-workspace")).not.toBeVisible();
      await expect(page.getByTestId("workspace-explorer-sidebar")).toBeVisible();
      await expect(
        page
          .locator('[data-testid^="workspace-pane-"]')
          .getByTestId("workspace-tabs-row")
          .filter({ visible: true }),
      ).toHaveCount(1);

      await explorerToggle.click();
      await expect(page.getByTestId("workspace-tab-files").filter({ visible: true })).toHaveCount(
        0,
      );
      await expect(explorerToggle).toHaveAccessibleName("Open Explorer sidebar");
      await expect(page.getByTestId("sidebar-global-new-workspace")).toBeVisible();
    } finally {
      await workspace.cleanup();
    }
  });
});
