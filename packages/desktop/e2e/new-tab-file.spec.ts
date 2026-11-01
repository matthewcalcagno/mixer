import { expect, test } from "../../app/e2e/support/fixtures";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { gotoWorkspace } from "../../app/e2e/support/helpers/launcher";
import { seedWorkspace } from "../../app/e2e/support/helpers/seed-client";
import { getServerId } from "../../app/e2e/support/helpers/server-id";
import { getE2EDaemonPort } from "../../app/e2e/support/helpers/daemon-port";
import { installDesktopRuntime } from "./support/runtime";

test("File replaces Diff in New tab and saves an empty-start Monaco document", async ({ page }) => {
  const workspace = await seedWorkspace({ repoPrefix: "new-tab-file-" });
  try {
    await installDesktopRuntime(page, {
      serverId: getServerId(),
      daemonListen: `127.0.0.1:${getE2EDaemonPort()}`,
    });
    await gotoWorkspace(page, workspace.workspaceId);
    let saveCount = 0;
    await page.exposeFunction("__nativeSaveText", async ({ content }: { content: string }) => {
      saveCount += 1;
      if (saveCount === 1) return null;
      const selected = path.join(workspace.repoPath, "notes.txt");
      await writeFile(selected, content, "utf8");
      return selected;
    });
    await page.evaluate(() => {
      window.mixerDesktop = {
        ...window.mixerDesktop,
        dialog: {
          ...window.mixerDesktop?.dialog,
          saveText: (options) => Reflect.get(window, "__nativeSaveText")(options),
        },
      };
    });
    await page.getByTestId("workspace-new-tab-file").filter({ visible: true }).click();
    await expect(page.getByTestId("workspace-new-tab-diff").filter({ visible: true })).toHaveCount(
      0,
    );
    const editor = page.frameLocator('iframe[title="New file editor"]');
    await expect(page.getByRole("textbox", { name: "New file path" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Save", exact: true })).toHaveCount(0);
    await expect(editor.locator(".monaco-editor")).toBeVisible();
    if (process.env.MIXER_WEB_PLATFORM === "electron") {
      await expect(page.getByTestId("status-bar-language-mode")).toHaveText("Plain Text");
    }
    await editor.locator(".monaco-editor").click();
    await page.keyboard.type("hello from a new file");
    await expect(editor.locator(".view-lines")).toContainText("hello from a new file");
    // Monaco chooses its shortcut modifier from the user agent, which Playwright emulates.
    const modifier = await editor
      .locator("body")
      .evaluate(() => (/Macintosh/.test(navigator.userAgent) ? "Meta" : "Control"));
    await page.keyboard.press(`${modifier}+z`);
    await expect(editor.locator(".view-lines")).not.toContainText("hello from a new file");
    await page.keyboard.press(`${modifier}+Shift+z`);
    await expect(editor.locator(".view-lines")).toContainText("hello from a new file");
    await page.keyboard.press(`${modifier}+s`);
    await expect.poll(() => saveCount).toBe(1);
    await expect(editor.locator(".view-lines")).toContainText("hello from a new file");
    await expect(page.getByRole("textbox", { name: "New file path" })).toHaveCount(0);
    await page.keyboard.press(`${modifier}+s`);
    await expect
      .poll(async () => {
        try {
          return await readFile(path.join(workspace.repoPath, "notes.txt"), "utf8");
        } catch {
          return null;
        }
      })
      .toBe("hello from a new file");
    await expect(editor.locator(".view-lines")).toContainText("hello from a new file");
    await expect(page.getByRole("textbox", { name: "New file path" })).toHaveCount(0);
  } finally {
    await workspace.cleanup();
  }
});
