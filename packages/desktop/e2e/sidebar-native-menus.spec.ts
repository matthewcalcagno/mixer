import { installLocalDesktopHost } from "../../app/e2e/support/helpers/local-desktop-host";
import { openAgentRoute } from "../../app/e2e/support/helpers/mock-agent";
import {
  seedParentWithSubagent,
  expectManagedSubagentArchived,
} from "../../app/e2e/support/helpers/subagents";
import path from "node:path";
import { expect, test } from "../../app/e2e/support/fixtures";
import { gotoAppShell } from "../../app/e2e/support/helpers/app";
import { seedWorkspace } from "../../app/e2e/support/helpers/seed-client";
import { getServerId } from "../../app/e2e/support/helpers/server-id";
import { getE2EDaemonPort } from "../../app/e2e/support/helpers/daemon-port";
import { escapeRegex } from "../../app/e2e/support/helpers/regex";
import { buildHostWorkspaceRoute } from "../../app/src/utils/host-routes";
import {
  actionContextMenuSchema,
  type ActionContextMenuRequest,
} from "../src/features/action-context-menu";

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
  const row = page.getByTestId(`sidebar-workspace-row-${getServerId()}:${workspaceId}`);
  await expect(row).toBeVisible({ timeout: 30_000 });
  return row;
}

test("native subagent menu enables navigation and archive finished", async ({ page }) => {
  const workspace = await seedWorkspace({ repoPrefix: "native-archive-subagents-" });
  try {
    const agents = await seedParentWithSubagent(workspace, {
      parentTitle: "Native archive parent",
      childTitle: "Native finished child",
    });
    await workspace.client.waitForAgentUpsert(
      agents.child.id,
      (snapshot) => snapshot.status === "idle",
    );
    await installLocalDesktopHost(page, workspace.repoPath);
    let captured: ActionContextMenuRequest | undefined;
    await page.exposeFunction("selectSubagentArchive", (request: ActionContextMenuRequest) => {
      captured = request;
      for (const item of request.items) {
        if (item.label === "Archive finished subagents") return item.id;
      }
      return null;
    });
    await page.addInitScript(() => {
      const host = window as unknown as {
        mixerDesktop: { menu: unknown };
        selectSubagentArchive(request: unknown): Promise<string | null>;
      };
      host.mixerDesktop.menu = {
        showContextMenu: (request: unknown) => host.selectSubagentArchive(request),
      };
    });
    await openAgentRoute(page, { workspaceId: agents.workspaceId, agentId: agents.parent.id });
    await page.getByTestId("subagents-track-header").click();
    await expect
      .poll(() => {
        for (const item of captured?.items ?? []) {
          if (item.label === "Archive finished subagents") return !item.disabled;
        }
        return false;
      })
      .toBe(true);
    expect(
      captured?.items.some(
        (item) => item.label.includes("Native finished child") && !item.disabled,
      ),
    ).toBe(true);
    await expectManagedSubagentArchived(workspace, agents.child.id);
  } finally {
    await workspace.cleanup();
  }
});
