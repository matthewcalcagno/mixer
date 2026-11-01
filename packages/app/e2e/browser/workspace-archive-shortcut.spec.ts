import { existsSync } from "node:fs";
import { expect, test } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import { seedWorkspace } from "../support/helpers/seed-client";
import {
  expectWorkspaceAbsentFromSidebar,
  selectWorkspaceInSidebar,
} from "../support/helpers/sidebar";
import { waitForSidebarHydration } from "../support/helpers/workspace-ui";

test.describe("Workspace deletion shortcut", () => {
  test("confirms deletion, supports cancel, and preserves the local checkout", async ({ page }) => {
    const workspace = await seedWorkspace({ repoPrefix: "archive-shortcut-" });

    try {
      await gotoAppShell(page);
      await waitForSidebarHydration(page);
      await selectWorkspaceInSidebar(page, workspace.workspaceId);

      const modifier = process.platform === "darwin" ? "Meta" : "Control";
      const cancelled = page.waitForEvent("dialog");
      const cancelAction = page.keyboard.press(`${modifier}+Shift+Backspace`);
      const cancelDialog = await cancelled;
      expect(cancelDialog.type()).toBe("confirm");
      expect(cancelDialog.message()).toContain("Delete");
      expect(cancelDialog.message()).toContain(
        "Your project directory and Git branches will be kept",
      );
      await cancelDialog.dismiss();
      await cancelAction;
      expect(
        (await workspace.client.fetchWorkspaces()).entries.some(
          (entry) => entry.id === workspace.workspaceId,
        ),
      ).toBe(true);

      const confirmed = page.waitForEvent("dialog");
      const deleteAction = page.keyboard.press(`${modifier}+Shift+Backspace`);
      await (await confirmed).accept();
      await deleteAction;

      await expectWorkspaceAbsentFromSidebar(page, workspace.workspaceId);
      expect(existsSync(workspace.repoPath)).toBe(true);
    } finally {
      await workspace.cleanup();
    }
  });
});
