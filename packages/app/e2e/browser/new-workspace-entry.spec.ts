import { expect, test } from "../support/fixtures";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { gotoAppShell } from "../support/helpers/app";
import {
  connectNewWorkspaceDaemonClient,
  expectNewWorkspaceControlsEnabled,
  expectNewWorkspaceProjectSelected,
  expectNewWorkspaceTriggerLabelsAligned,
  openGlobalNewWorkspaceComposer,
  openMissingProjectNewWorkspaceComposer,
  openNewWorkspaceComposer,
  selectWorkspaceIsolation,
} from "../support/helpers/new-workspace";
import { getE2EDaemonPort } from "../support/helpers/daemon-port";
import { openFileExplorer } from "../support/helpers/file-explorer";
import { installDaemonWebSocketGate } from "../support/helpers/daemon-websocket-gate";
import { seedWorkspace, type SeededWorkspace } from "../support/helpers/seed-client";
import { seedSavedSettingsHosts } from "../support/helpers/settings";
import { getServerId } from "../support/helpers/server-id";
import { projectEquivalenceViewKey } from "../support/helpers/project-view-key";
import {
  clickArchiveWorkspaceMenuItem,
  expectWorkspaceAbsentFromSidebar,
} from "../support/helpers/sidebar";
import {
  switchWorkspaceViaSidebar,
  waitForSidebarHydration,
} from "../support/helpers/workspace-ui";

// Model B entry points into the New Workspace screen. The surviving entries are
// the global button (universal) and each project's per-row New workspace icon
// (preselects that project) — shown for git projects and for non-git projects on
// a multiplicity-capable host. These specs prove the global entry opens the
// screen, the project icon preselects the right project across the reused 'new'
// screen, and non-git projects never offer the worktree Isolation control.

function projectRow(page: import("@playwright/test").Page, projectKey: string) {
  return page.getByTestId(`sidebar-project-row-${projectEquivalenceViewKey(projectKey)}`);
}

async function explorerTabAppearance(page: import("@playwright/test").Page, testId: string) {
  return page
    .getByTestId(testId)
    .filter({ visible: true })
    .evaluate((button) => {
      const dock = button.closest('[data-testid="workspace-explorer-sidebar"]');
      if (!dock) throw new Error("Missing shared Explorer dock");
      const bounds = button.getBoundingClientRect();
      const frame = dock.getBoundingClientRect();
      const style = getComputedStyle(button);
      return {
        width: bounds.width,
        height: bounds.height,
        left: bounds.left - frame.left,
        top: bounds.top - frame.top,
        background: style.backgroundColor,
        radius: style.borderRadius,
        surface: getComputedStyle(dock).backgroundColor,
        iconWidth: button.querySelector("svg")?.getBoundingClientRect().width,
      };
    });
}

async function chooseSetupBranch(
  page: import("@playwright/test").Page,
  trigger: string,
  search: string,
  label = search,
) {
  await page.getByTestId(trigger).click();
  const input = page.getByPlaceholder("Search branches", { exact: true });
  await expect(input).toHaveCount(1);
  await input.fill(search);
  await page.getByRole("button", { name: label, exact: true }).click();
}

test.describe("New workspace entry points", () => {
  let client: Awaited<ReturnType<typeof connectNewWorkspaceDaemonClient>>;

  test.describe.configure({ timeout: 240_000 });

  test.beforeEach(async () => {
    client = await connectNewWorkspaceDaemonClient();
  });

  test.afterEach(async () => {
    await client?.close().catch(() => undefined);
  });

  test("setup-only form never shows Explorer and creates an empty workspace without a first tab", async ({
    page,
  }) => {
    test.setTimeout(60_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    const seeded = await seedWorkspace({ repoPrefix: "entry-project-explorer-" });
    const filename = "mixer-preview-check.txt";
    const contents = "Project preview without workspace creation";
    try {
      await writeFile(path.join(seeded.repoPath, filename), contents);
      await writeFile(path.join(seeded.repoPath, "README.md"), "Tracked change in the same list\n");
      await gotoAppShell(page);
      await waitForSidebarHydration(page);
      await switchWorkspaceViaSidebar({
        page,
        serverId: getServerId(),
        workspaceId: seeded.workspaceId,
      });
      await openFileExplorer(page);
      await page.mouse.move(700, 300);
      const workspaceExplorerAppearance = await explorerTabAppearance(page, "workspace-tab-files");
      expect(workspaceExplorerAppearance).toMatchObject({ width: 28, height: 28, iconWidth: 16 });
      await page.getByRole("button", { name: "Source Control", exact: true }).click();
      const workspaceDock = page
        .getByTestId("workspace-explorer-sidebar")
        .filter({ visible: true });
      await expect(
        workspaceDock.getByRole("button", { name: "Collapse Untracked Changes", exact: true }),
      ).toHaveCount(0);
      const changesHeader = workspaceDock
        .getByRole("button", { name: "Collapse Changes", exact: true })
        .locator("..");
      await expect(changesHeader.getByText("2", { exact: true })).toBeVisible();
      await expect(
        workspaceDock.getByRole("button", {
          name: "Open working tree diff for README.md",
          exact: true,
        }),
      ).toBeVisible();
      const commitMessage = workspaceDock.getByRole("textbox", { name: "Commit message" });
      await expect(commitMessage).toHaveCSS("font-size", "12px");
      await expect(commitMessage).toHaveCSS("height", "28px");
      const commitPlaceholder = workspaceDock.getByTestId("source-control-commit-placeholder");
      await expect(commitPlaceholder).toHaveCSS("white-space", "nowrap");
      await expect(commitPlaceholder).toHaveCSS("text-overflow", "ellipsis");
      await commitMessage.fill("Line one\nLine two\nLine three");
      await expect(commitMessage).toHaveCSS("height", "60px");
      await expect(commitPlaceholder).toHaveCount(0);
      await commitMessage.fill("");
      await expect(commitMessage).toHaveCSS("height", "28px");
      const sourceActions = workspaceDock.getByRole("combobox", { name: "Source Control actions" });
      expect(await sourceActions.evaluate((node) => node.tagName)).toBe("SELECT");
      await sourceActions.selectOption("sort-name");
      await expect(sourceActions.locator('option[value="sort-name"]')).toHaveText("Sort by name ✓");
      await expect(workspaceDock.getByText("Close menu", { exact: true })).toHaveCount(0);
      await workspaceDock
        .getByRole("button", { name: `Open file ${filename}`, exact: true })
        .hover();
      const resourceRow = workspaceDock
        .getByRole("button", { name: `Open file ${filename}`, exact: true })
        .locator("..");
      const openFile = resourceRow.getByRole("button", { name: "Open file", exact: true });
      const stageFile = workspaceDock.getByRole("button", {
        name: `Stage ${filename}`,
        exact: true,
      });
      const openBox = await openFile.boundingBox();
      const stageBox = await stageFile.boundingBox();
      if (!openBox || !stageBox) throw new Error("Missing Source Control row actions");
      expect(openBox.x).toBeLessThan(stageBox.x);
      await openFile.click();
      await expect(
        page.getByTestId(`workspace-tab-file_${filename}`).filter({ visible: true }),
      ).toBeVisible();
      await expect(
        page
          .getByTestId(`workspace-tab-file_${filename}`)
          .filter({ visible: true })
          .getByText(filename, { exact: true }),
      ).toHaveCSS("font-style", "italic");
      await expect(page.getByTestId("file-source-editor").filter({ visible: true })).toContainText(
        contents,
      );
      await workspaceDock
        .getByRole("button", { name: "Open working tree diff for README.md", exact: true })
        .click();
      await expect(
        page.locator('iframe[title="README.md diff editor"]').filter({ visible: true }),
      ).toBeVisible();
      const untrackedRow = workspaceDock.getByRole("button", {
        name: `Open file ${filename}`,
        exact: true,
      });
      await untrackedRow.click();
      await expect(page.getByTestId("file-source-editor").filter({ visible: true })).toContainText(
        contents,
      );
      await expect(page.locator(`iframe[title="${filename} diff editor"]`)).toHaveCount(0);
      await untrackedRow.focus();
      await untrackedRow.press("Enter");
      await expect(page.getByTestId("file-source-editor").filter({ visible: true })).toContainText(
        contents,
      );
      await expect(page.locator(`iframe[title="${filename} diff editor"]`)).toHaveCount(0);
      await openFileExplorer(page);
      await openNewWorkspaceComposer(page, seeded);
      const before = await client.fetchWorkspaces();
      await expect(page.getByTestId("new-workspace-setup-form")).toBeVisible();
      await expect(page.getByTestId("new-workspace-project-icon")).toBeVisible();
      await expect(page.getByTestId("new-workspace-project-icon")).toHaveCSS("width", "16px");
      await expect(page.getByTestId("new-workspace-host-status")).toBeVisible();
      await expect(page.getByRole("textbox", { name: "Message agent..." })).toHaveCount(0);
      await expect(page.getByTestId("new-workspace-launch-trigger")).toHaveCount(0);
      await selectWorkspaceIsolation(page, "local");
      await expect(page.getByTestId("new-workspace-ref-picker-trigger")).toHaveCount(0);
      await page.screenshot({ path: test.info().outputPath("workspace-setup-local-form.png") });
      await expect(page.getByTestId("new-workspace-main-island")).toBeVisible();
      const shell = page.getByTestId("new-workspace-setup-surface");
      await expect(shell).toHaveCSS("padding-bottom", "0px");
      const shellBox = await shell.boundingBox();
      const mainBox = await page.getByTestId("new-workspace-main-island").boundingBox();
      expect(shellBox).not.toBeNull();
      expect(mainBox).not.toBeNull();
      if (shellBox && mainBox) {
        expect(mainBox.x).toBe(shellBox.x);
        expect(mainBox.width).toBe(shellBox.width);
        expect(mainBox.y + mainBox.height).toBe(shellBox.y + shellBox.height);
      }
      await expectNewWorkspaceProjectSelected(page, seeded.projectDisplayName);
      await expect(shell.getByTestId("workspace-explorer-sidebar")).toHaveCount(0);
      const dock = page.getByTestId("workspace-explorer-sidebar").filter({ visible: true });
      await expect(dock).toHaveCount(0);
      await page.keyboard.press("Control+b");
      await page.keyboard.press("Meta+b");
      await page.keyboard.press("Control+`");
      await expect(dock).toHaveCount(0);
      await expect(page.getByTestId("new-workspace-file-preview")).toHaveCount(0);
      const after = await client.fetchWorkspaces();
      expect(after.entries.map((entry) => entry.id).sort()).toEqual(
        before.entries.map((entry) => entry.id).sort(),
      );
      await page.getByTestId("workspace-create-submit").click();
      await expect(page).toHaveURL(/\/workspace\//);
      await expect(dock).toBeVisible();
      await expect(
        page.getByTestId("file-explorer-tree-scroll").filter({ visible: true }),
      ).toBeVisible();
      await expect(
        page.getByTestId("workspace-tab-files").filter({ visible: true }),
      ).toHaveAttribute("aria-selected", "true");
      const previousIds = new Set(before.entries.map((entry) => entry.id));
      const created = (await client.fetchWorkspaces()).entries.find(
        (entry) => !previousIds.has(entry.id),
      );
      if (!created) throw new Error("Missing created workspace");
      expect(
        (await client.fetchAgents()).entries.filter(
          (entry) => entry.agent.workspaceId === created.id,
        ),
      ).toEqual([]);
      expect(
        (
          await client.listTerminals(created.workspaceDirectory, undefined, {
            workspaceId: created.id,
          })
        ).terminals,
      ).toEqual([]);
    } finally {
      await seeded.cleanup();
    }
  });

  test("setup worktree opens the chosen branch and never silently forks an occupied branch", async ({
    page,
  }) => {
    test.setTimeout(60_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.emulateMedia({ colorScheme: "dark" });
    const seeded = await seedWorkspace({ repoPrefix: "setup-existing-branch-" });
    try {
      const branchName = "feature/open-existing";
      execFileSync("git", ["branch", branchName], { cwd: seeded.repoPath });
      const branchesBefore = execFileSync(
        "git",
        ["for-each-ref", "--format=%(refname)", "refs/heads"],
        { cwd: seeded.repoPath, encoding: "utf8" },
      );
      const workspacesBefore = await client.fetchWorkspaces();
      await gotoAppShell(page);
      await waitForSidebarHydration(page);
      await openNewWorkspaceComposer(page, seeded);
      await selectWorkspaceIsolation(page, "worktree");
      await expect(page.getByTestId("new-workspace-branch-field")).toBeVisible();
      const create = page.getByTestId("workspace-create-submit");
      await expect(create).toBeEnabled();
      await create.click();
      await expect(page.getByTestId("new-workspace-setup-error")).toContainText(
        /already checked out/i,
      );
      expect(
        execFileSync("git", ["for-each-ref", "--format=%(refname)", "refs/heads"], {
          cwd: seeded.repoPath,
          encoding: "utf8",
        }),
      ).toBe(branchesBefore);
      await page.getByTestId("new-workspace-ref-picker-trigger").click();
      await page.getByPlaceholder("Search branches", { exact: true }).fill(branchName);
      await page.getByText(branchName, { exact: true }).filter({ visible: true }).click();
      await expect(page.getByTestId("new-workspace-ref-picker-trigger")).toContainText(branchName);
      await page.screenshot({ path: test.info().outputPath("workspace-setup-branch-form.png") });
      await create.click();
      await expect(page).toHaveURL(/\/workspace\//);
      const previousIds = new Set(workspacesBefore.entries.map((entry) => entry.id));
      const created = (await client.fetchWorkspaces()).entries.find(
        (entry) => !previousIds.has(entry.id),
      );
      if (!created) throw new Error("Missing worktree workspace");
      expect(created.workspaceDirectory).not.toBe(seeded.repoPath);
      expect(
        execFileSync("git", ["branch", "--show-current"], {
          cwd: created.workspaceDirectory,
          encoding: "utf8",
        }).trim(),
      ).toBe(branchName);
      expect(
        execFileSync("git", ["for-each-ref", "--format=%(refname)", "refs/heads"], {
          cwd: seeded.repoPath,
          encoding: "utf8",
        }),
      ).toBe(branchesBefore);
      expect(
        (await client.fetchAgents()).entries.filter(
          (entry) => entry.agent.workspaceId === created.id,
        ),
      ).toEqual([]);
      expect(
        (
          await client.listTerminals(created.workspaceDirectory, undefined, {
            workspaceId: created.id,
          })
        ).terminals,
      ).toEqual([]);
    } finally {
      await seeded.cleanup();
    }
  });

  test("creates an explicit new branch from the chosen base and rejects a conflicting name", async ({
    page,
  }) => {
    test.setTimeout(60_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.emulateMedia({ colorScheme: "dark" });
    const seeded = await seedWorkspace({ repoPrefix: "setup-new-branch-" });
    try {
      const base = "release/base";
      execFileSync("git", ["checkout", "-b", base], { cwd: seeded.repoPath });
      await writeFile(path.join(seeded.repoPath, "base-marker.txt"), "From the selected base\n");
      execFileSync("git", ["add", "base-marker.txt"], { cwd: seeded.repoPath });
      execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-m", "Selected base fixture"], {
        cwd: seeded.repoPath,
      });
      const baseTip = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: seeded.repoPath,
        encoding: "utf8",
      }).trim();
      execFileSync("git", ["checkout", "main"], { cwd: seeded.repoPath });
      const before = await client.fetchWorkspaces();
      const branchGate = await installDaemonWebSocketGate(page);
      await gotoAppShell(page);
      await waitForSidebarHydration(page);
      await openNewWorkspaceComposer(page, seeded);
      await selectWorkspaceIsolation(page, "worktree");
      const conflicting = "internal/race-branch";
      await page.getByTestId("new-workspace-ref-picker-trigger").click();
      await expect(page.getByRole("button", { name: base, exact: true })).toBeVisible();
      branchGate.holdNextServerMessage("branch_suggestions_response");
      const branchSearch = page.getByPlaceholder("Search branches", { exact: true });
      await branchSearch.fill(conflicting);
      await branchGate.waitForHeldServerMessage("branch_suggestions_response");
      await expect(
        page.getByRole("button", { name: `${conflicting} (new branch)`, exact: true }),
      ).toBeVisible();
      await expect(page.getByText("No matching branches.", { exact: true })).toHaveCount(0);
      await branchSearch.press("Enter");
      await expect(page.getByTestId("new-workspace-base-branch-field")).toBeVisible();
      await expect(page.getByTestId("new-workspace-base-branch-field")).toContainText("Start from");
      await expect(page.getByTestId("new-workspace-base-branch-trigger")).toContainText("main");
      const branchBounds = await page.getByTestId("new-workspace-branch-field").boundingBox();
      const startBounds = await page.getByTestId("new-workspace-base-branch-field").boundingBox();
      if (!branchBounds || !startBounds) throw new Error("Missing branch fields");
      expect(startBounds.x).toBeGreaterThan(branchBounds.x);
      expect(startBounds.y).toBe(branchBounds.y);
      branchGate.releaseHeldServerMessage("branch_suggestions_response");
      await chooseSetupBranch(page, "new-workspace-base-branch-trigger", base);
      execFileSync("git", ["branch", conflicting], { cwd: seeded.repoPath });
      const branchNames = execFileSync(
        "git",
        ["for-each-ref", "--format=%(refname)", "refs/heads"],
        { cwd: seeded.repoPath, encoding: "utf8" },
      )
        .trim()
        .split("\n");
      await page.getByTestId("workspace-create-submit").click();
      await expect(page.getByTestId("new-workspace-setup-error")).toContainText(
        /branch already exists/i,
      );
      expect(
        execFileSync("git", ["for-each-ref", "--format=%(refname)", "refs/heads"], {
          cwd: seeded.repoPath,
          encoding: "utf8",
        })
          .trim()
          .split("\n"),
      ).toEqual(branchNames);
      const name = "internal/GLCX-106";
      await chooseSetupBranch(
        page,
        "new-workspace-ref-picker-trigger",
        name,
        `${name} (new branch)`,
      );
      await expect(page.getByTestId("new-workspace-ref-picker-trigger")).toContainText(
        `${name} (new branch)`,
      );
      await expect(page.getByTestId("new-workspace-base-branch-trigger")).toContainText(base);
      await page.screenshot({
        path: test.info().outputPath("workspace-setup-new-branch-form.png"),
      });
      await page.getByTestId("workspace-create-submit").click();
      await expect(page).toHaveURL(/\/workspace\//);
      const previousIds = new Set(before.entries.map((entry) => entry.id));
      const created = (await client.fetchWorkspaces()).entries.find(
        (entry) => !previousIds.has(entry.id),
      );
      if (!created) throw new Error("Missing new-branch workspace");
      expect(
        execFileSync("git", ["branch", "--show-current"], {
          cwd: created.workspaceDirectory,
          encoding: "utf8",
        }).trim(),
      ).toBe(name);
      expect(
        execFileSync("git", ["rev-parse", "HEAD"], {
          cwd: created.workspaceDirectory,
          encoding: "utf8",
        }).trim(),
      ).toBe(baseTip);
      expect(
        execFileSync("git", ["branch", "--show-current"], {
          cwd: seeded.repoPath,
          encoding: "utf8",
        }).trim(),
      ).toBe("main");
      expect(
        execFileSync("git", ["for-each-ref", "--format=%(refname)", "refs/heads"], {
          cwd: seeded.repoPath,
          encoding: "utf8",
        })
          .trim()
          .split("\n")
          .sort(),
      ).toEqual([...branchNames, `refs/heads/${name}`].sort());
    } finally {
      await seeded.cleanup();
    }
  });

  test("the global new-workspace button opens the New Workspace screen", async ({ page }) => {
    const seeded: SeededWorkspace = await seedWorkspace({ repoPrefix: "entry-global-button-" });

    try {
      await seedSavedSettingsHosts(page, [
        {
          serverId: getServerId(),
          label: "localhost",
          endpoint: `127.0.0.1:${getE2EDaemonPort()}`,
        },
        {
          serverId: "secondary-new-workspace-host",
          label: "Secondary host",
          endpoint: "127.0.0.1:9",
        },
      ]);

      await gotoAppShell(page);
      await waitForSidebarHydration(page);
      await expect(
        page.getByTestId(`sidebar-workspace-row-${getServerId()}:${seeded.workspaceId}`),
      ).toBeVisible({ timeout: 30_000 });
      await switchWorkspaceViaSidebar({
        page,
        serverId: getServerId(),
        workspaceId: seeded.workspaceId,
      });

      const globalButton = page.getByTestId("sidebar-global-new-workspace");
      await expect(globalButton).toBeVisible({ timeout: 30_000 });

      await openGlobalNewWorkspaceComposer(page);
      await expect(page.getByTestId("host-chooser")).toHaveCount(0);

      await expect(page.getByTestId("new-workspace-project-picker-trigger")).toBeVisible({
        timeout: 30_000,
      });
      await expect(page.getByTestId("host-picker-trigger")).toBeVisible({ timeout: 30_000 });
      await expectNewWorkspaceTriggerLabelsAligned(page, {
        projectLabel: seeded.projectDisplayName,
        hostLabel: "localhost",
      });
    } finally {
      await seeded.cleanup();
    }
  });

  test("the New Workspace screen shows the host selector with Add host when there is only one host", async ({
    page,
  }) => {
    const seeded: SeededWorkspace = await seedWorkspace({ repoPrefix: "entry-single-host-" });

    try {
      await seedSavedSettingsHosts(page, [
        {
          serverId: getServerId(),
          label: "localhost",
          endpoint: `127.0.0.1:${getE2EDaemonPort()}`,
        },
      ]);

      await gotoAppShell(page);
      await waitForSidebarHydration(page);
      await expect(
        page.getByTestId(`sidebar-workspace-row-${getServerId()}:${seeded.workspaceId}`),
      ).toBeVisible({ timeout: 30_000 });

      await openGlobalNewWorkspaceComposer(page);

      await expect(page.getByTestId("new-workspace-project-picker-trigger")).toBeVisible({
        timeout: 30_000,
      });
      const hostTrigger = page.getByTestId("host-picker-trigger");
      await expect(hostTrigger).toContainText("localhost", { timeout: 30_000 });
      await hostTrigger.click();
      await expect(page.getByTestId("new-workspace-host-picker-add-host")).toBeVisible();
      await page.getByTestId("new-workspace-host-picker-add-host").click();
      await expect(page).toHaveURL(/\/settings\/general\?addHost=/);
    } finally {
      await seeded.cleanup();
    }
  });

  test("a stale project route keeps the New Workspace controls enabled", async ({ page }) => {
    await gotoAppShell(page);
    await openMissingProjectNewWorkspaceComposer(page, {
      serverId: getServerId(),
      projectId: "missing-project",
      sourceDirectory: "/tmp/missing-project",
    });

    await expectNewWorkspaceControlsEnabled(page);
  });

  test("the setup Project field opens its searchable selector from the keyboard", async ({
    page,
  }) => {
    const seeded: SeededWorkspace = await seedWorkspace({ repoPrefix: "entry-shortcut-" });

    try {
      await gotoAppShell(page);
      await waitForSidebarHydration(page);
      await openGlobalNewWorkspaceComposer(page);

      await page.getByTestId("new-workspace-project-picker-trigger").focus();
      await page.keyboard.press("Enter");
      await expect(page.getByPlaceholder("Search projects", { exact: true })).toBeVisible();
      await expect(page.getByPlaceholder("Search projects", { exact: true })).toBeFocused();
    } finally {
      await seeded.cleanup();
    }
  });

  test("keeps the in-progress form when the remembered workspace is archived elsewhere", async ({
    page,
  }) => {
    const otherProject: SeededWorkspace = await seedWorkspace({
      repoPrefix: "aa-new-workspace-archive-other-",
    });
    const rememberedProject: SeededWorkspace = await seedWorkspace({
      repoPrefix: "zz-new-workspace-archive-remembered-",
    });
    const serverId = getServerId();

    try {
      await seedSavedSettingsHosts(page, [
        {
          serverId,
          label: "localhost",
          endpoint: `127.0.0.1:${getE2EDaemonPort()}`,
        },
      ]);

      await gotoAppShell(page);
      await waitForSidebarHydration(page);
      await page
        .getByTestId(`sidebar-workspace-row-${serverId}:${rememberedProject.workspaceId}`)
        .click();
      await expect(page).toHaveURL(/\/workspace\//, { timeout: 30_000 });

      await page.goto(`/new?serverId=${encodeURIComponent(serverId)}`);
      await expectNewWorkspaceProjectSelected(page, rememberedProject.projectDisplayName);

      await selectWorkspaceIsolation(page, "worktree");
      await expect(page.getByTestId("workspace-create-isolation-trigger")).toContainText(
        "New worktree",
      );

      await clickArchiveWorkspaceMenuItem(page, rememberedProject.workspaceId);
      await expectWorkspaceAbsentFromSidebar(page, rememberedProject.workspaceId);

      await expect(page).toHaveURL(/\/new(?:\?.*)?$/, { timeout: 30_000 });
      await expect(page.getByTestId("workspace-create-isolation-trigger")).toContainText(
        "New worktree",
      );
      await expectNewWorkspaceProjectSelected(page, rememberedProject.projectDisplayName);
    } finally {
      await otherProject.cleanup();
      await rememberedProject.cleanup();
    }
  });

  test("each project's row icon preselects that project, and the reused screen resets a stale manual choice across projects", async ({
    page,
  }) => {
    const projectA: SeededWorkspace = await seedWorkspace({ repoPrefix: "entry-preselect-a-" });
    const projectB: SeededWorkspace = await seedWorkspace({ repoPrefix: "entry-preselect-b-" });
    const projectC: SeededWorkspace = await seedWorkspace({ repoPrefix: "entry-preselect-c-" });

    try {
      await gotoAppShell(page);
      await waitForSidebarHydration(page);
      await expect(projectRow(page, projectA.projectKey)).toBeVisible({ timeout: 30_000 });
      await expect(projectRow(page, projectB.projectKey)).toBeVisible({ timeout: 30_000 });
      await expect(projectRow(page, projectC.projectKey)).toBeVisible({ timeout: 30_000 });

      // Project A's row icon opens New Workspace with A preselected.
      await openNewWorkspaceComposer(page, {
        projectKey: projectA.projectKey,
        projectDisplayName: projectA.projectDisplayName,
      });
      await expectNewWorkspaceProjectSelected(page, projectA.projectDisplayName);

      // Manually override the selection to C from inside A's screen. This stale
      // manualProjectKey is what the reused 'new' screen must reset when the next
      // route-driven navigation targets a different project.
      await page.getByTestId("new-workspace-project-picker-trigger").click();
      const optionC = page.getByTestId(
        `new-workspace-project-picker-option-${projectEquivalenceViewKey(projectC.projectKey)}`,
      );
      await expect(optionC).toBeVisible({ timeout: 30_000 });
      await optionC.click();
      await expectNewWorkspaceProjectSelected(page, projectC.projectDisplayName);

      // Navigate via B's row icon. B must be preselected — the route project wins
      // because the stale manual choice (C) was reset on the route change. If the
      // reset were missing, the trigger would still read C.
      await openNewWorkspaceComposer(page, {
        projectKey: projectB.projectKey,
        projectDisplayName: projectB.projectDisplayName,
      });
      await expectNewWorkspaceProjectSelected(page, projectB.projectDisplayName);
    } finally {
      await projectA.cleanup();
      await projectB.cleanup();
      await projectC.cleanup();
    }
  });

  test("the Isolation control is hidden for a non-git project and shown for a git project", async ({
    page,
  }) => {
    const gitProject: SeededWorkspace = await seedWorkspace({ repoPrefix: "entry-iso-git-" });
    const nonGitProject: SeededWorkspace = await seedWorkspace({
      repoPrefix: "entry-iso-nongit-",
      git: false,
    });

    try {
      await gotoAppShell(page);
      await waitForSidebarHydration(page);
      await expect(projectRow(page, gitProject.projectKey)).toBeVisible({ timeout: 30_000 });
      await expect(projectRow(page, nonGitProject.projectKey)).toBeVisible({ timeout: 30_000 });

      // Open New Workspace for the non-git project via the global button, then
      // select it in the picker (the per-row icon would preselect it too).
      await openGlobalNewWorkspaceComposer(page);
      const trigger = page.getByTestId("new-workspace-project-picker-trigger");
      await expect(trigger).toBeVisible({ timeout: 30_000 });
      await trigger.click();
      const nonGitOption = page.getByTestId(
        `new-workspace-project-picker-option-${projectEquivalenceViewKey(nonGitProject.projectKey)}`,
      );
      await expect(nonGitOption).toBeVisible({ timeout: 30_000 });
      await nonGitOption.click();
      await expectNewWorkspaceProjectSelected(page, nonGitProject.projectDisplayName);

      // No git checkout means no worktree isolation choice: the Isolation row is
      // absent entirely.
      await expect(page.getByTestId("workspace-create-isolation-trigger")).toHaveCount(0);

      // Switching to the git project on the same screen reveals the Isolation row.
      await trigger.click();
      const gitOption = page.getByTestId(
        `new-workspace-project-picker-option-${projectEquivalenceViewKey(gitProject.projectKey)}`,
      );
      await expect(gitOption).toBeVisible({ timeout: 30_000 });
      await gitOption.click();
      await expectNewWorkspaceProjectSelected(page, gitProject.projectDisplayName);

      await expect(page.getByTestId("workspace-create-isolation-trigger")).toBeVisible({
        timeout: 30_000,
      });
    } finally {
      await gitProject.cleanup();
      await nonGitProject.cleanup();
    }
  });
});
