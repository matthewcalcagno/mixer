import { expect } from "@playwright/test";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "../support/fixtures";
import { gotoWorkspace } from "../support/helpers/launcher";
import { seedWorkspace } from "../support/helpers/seed-client";

test("File replaces Diff in New tab and saves an empty-start Monaco document", async ({ page }) => {
  const workspace = await seedWorkspace({ repoPrefix: "new-tab-file-" });
  try {
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

test("a workspace with an existing agent never presents New during startup", async ({ page }) => {
  const workspace = await seedWorkspace({ repoPrefix: "new-tab-startup-agent-" });
  const agent = await workspace.client.createAgent({
    provider: "mock",
    cwd: workspace.repoPath,
    workspaceId: workspace.workspaceId,
    title: "Existing startup agent",
    modeId: "load-test",
    model: "ten-second-stream",
    initialPrompt: "ready",
  });

  try {
    await page.addInitScript(() => {
      Reflect.set(globalThis, "__mixerSawVisibleNewTab", false);
      function recordVisibleNewTab() {
        const panel = document.querySelector('[data-testid="workspace-new-tab-panel"]');
        if (panel?.getClientRects().length) {
          Reflect.set(globalThis, "__mixerSawVisibleNewTab", true);
        }
      }
      window.addEventListener("DOMContentLoaded", () => {
        new MutationObserver(recordVisibleNewTab).observe(document.documentElement, {
          childList: true,
          subtree: true,
        });
        recordVisibleNewTab();
      });
    });

    await gotoWorkspace(page, workspace.workspaceId);
    await expect(
      page.getByTestId(`workspace-tab-agent_${agent.id}`).filter({ visible: true }),
    ).toHaveAttribute("aria-selected", "true", { timeout: 30_000 });
    await expect(page.getByTestId("workspace-new-tab-panel").filter({ visible: true })).toHaveCount(
      0,
    );
    expect(await page.evaluate(() => Reflect.get(globalThis, "__mixerSawVisibleNewTab"))).toBe(
      false,
    );
  } finally {
    await workspace.cleanup();
  }
});
