import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test, type Page } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import {
  expectNoBranchSwitcherInWorkspaceHeader,
  expectWorkspaceBranch,
  openChangesPanel,
  switchBranchFromChangesPanel,
} from "../support/helpers/branch-switcher";
import { seedWorkspace } from "../support/helpers/seed-client";
import { getServerId } from "../support/helpers/server-id";
import { readWorktreeBranchInfo } from "../support/helpers/workspace";
import {
  switchWorkspaceViaSidebar,
  waitForSidebarHydration,
} from "../support/helpers/workspace-ui";

async function renameWorkspaceViaSidebar(
  page: Page,
  input: { workspaceId: string; title: string },
): Promise<void> {
  const serverId = getServerId();
  const row = page.getByTestId(`sidebar-workspace-row-${serverId}:${input.workspaceId}`);
  await expect(row).toBeVisible({ timeout: 30_000 });
  await row.click({ button: "right" });

  const renameItem = page.getByRole("menuitem", { name: "Rename workspace", exact: true });
  await expect(renameItem).toBeVisible({ timeout: 10_000 });
  await renameItem.click();

  const renameInput = page.getByTestId(
    `sidebar-workspace-rename-input-${serverId}:${input.workspaceId}`,
  );
  await expect(renameInput).toBeVisible({ timeout: 10_000 });
  await renameInput.fill(input.title);
  await renameInput.press("Enter");
  await expect(renameInput).toHaveCount(0, { timeout: 15_000 });
}

test.describe("Branch switcher", () => {
  // The first test after a spec-file switch can fail while the shared daemon
  // releases stale sessions from the previous spec; one retry stabilizes it.
  test.describe.configure({ retries: 1 });

  test("a custom workspace title stays in the header while the diff panel switches the real branch", async ({
    page,
  }) => {
    test.setTimeout(90_000);
    const serverId = getServerId();
    const workspace = await seedWorkspace({
      repoPrefix: "branch-coherence-",
      repo: { branches: ["main", "dev"] },
    });

    try {
      expect(workspace.workspaceName).toBe("main");

      await gotoAppShell(page);
      await waitForSidebarHydration(page);
      await switchWorkspaceViaSidebar({ page, serverId, workspaceId: workspace.workspaceId });

      const customTitle = "Payments Refactor";
      await renameWorkspaceViaSidebar(page, {
        workspaceId: workspace.workspaceId,
        title: customTitle,
      });

      // The header shows the custom title verbatim (a plain static title), never a
      // branch name, and the branch switcher does not live in the header.
      const headerTitle = page
        .getByTestId("workspace-header-title")
        .filter({ visible: true })
        .first();
      await expect(headerTitle).toHaveText(customTitle, { timeout: 30_000 });
      await expectNoBranchSwitcherInWorkspaceHeader(page);

      // The diff panel's switcher tracks the real branch ("main"), not the title,
      // and switching it checks out the real branch on disk.
      await openChangesPanel(page);
      await expectWorkspaceBranch(page, "main");
      await switchBranchFromChangesPanel(page, { from: "main", to: "dev" });
      await expectWorkspaceBranch(page, "dev");

      // The custom title is unaffected by the branch switch.
      await expect(headerTitle).toHaveText(customTitle, { timeout: 30_000 });

      await expect
        .poll(
          async () =>
            (await readWorktreeBranchInfo({ worktreePath: workspace.repoPath })).currentBranch,
          { timeout: 30_000 },
        )
        .toBe("dev");
    } finally {
      await workspace.cleanup();
    }
  });
});

for (const blocked of [false, true]) {
  test(`status-bar branch switching ${blocked ? "prompts only for overlapping changes" : "carries compatible local changes without stashing"}`, async ({
    page,
  }) => {
    const workspace = await seedWorkspace({
      repoPrefix: "branch-local-changes-",
      repo: { branches: ["main", "feature"] },
    });
    const dialogs: string[] = [];
    page.on("dialog", async (dialog) => {
      dialogs.push(dialog.message());
      await dialog.dismiss();
    });
    const git = (...args: string[]) =>
      execFileSync("git", args, { cwd: workspace.repoPath, stdio: "pipe" }).toString().trim();
    try {
      git("checkout", "feature");
      await writeFile(
        path.join(workspace.repoPath, blocked ? "README.md" : "feature.txt"),
        "target branch edit\n",
      );
      git("add", "-A");
      git("commit", "-m", "target branch");
      git("checkout", "main");
      await writeFile(path.join(workspace.repoPath, "README.md"), "local edit\n");
      await writeFile(path.join(workspace.repoPath, "untracked.txt"), "local untracked\n");
      if (!blocked) git("add", "README.md");
      await gotoAppShell(page);
      await waitForSidebarHydration(page);
      await switchWorkspaceViaSidebar({
        page,
        serverId: getServerId(),
        workspaceId: workspace.workspaceId,
      });
      const trigger = page.getByTestId("status-bar-branch");
      await expect(trigger).toContainText("main");
      await trigger.click();
      await page.getByPlaceholder("Filter branches...").fill("feature");
      await page
        .getByTestId("combobox-desktop-container")
        .getByText("feature", { exact: true })
        .click();
      if (blocked) {
        await expect.poll(() => dialogs).toHaveLength(1);
        expect(dialogs[0]).toContain("Stash them before switching branches?");
        expect(git("branch", "--show-current")).toBe("main");
        await expect(trigger).toContainText("main");
      } else {
        await expect.poll(() => git("branch", "--show-current")).toBe("feature");
        await expect(trigger).toContainText("feature");
        expect(dialogs).toEqual([]);
        expect(git("diff", "--cached", "--name-only")).toBe("README.md");
        expect(await readFile(path.join(workspace.repoPath, "feature.txt"), "utf8")).toBe(
          "target branch edit\n",
        );
      }
      expect(await readFile(path.join(workspace.repoPath, "README.md"), "utf8")).toBe(
        "local edit\n",
      );
      expect(await readFile(path.join(workspace.repoPath, "untracked.txt"), "utf8")).toBe(
        "local untracked\n",
      );
      expect(git("stash", "list")).toBe("");
    } finally {
      await workspace.cleanup();
    }
  });
}
