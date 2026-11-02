import { seedMockAgentWorkspace, openAgentRoute } from "../support/helpers/mock-agent";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { openFileFromExplorer } from "../support/helpers/file-explorer";
import { openSettingsSection, clickSettingsBackToWorkspace } from "../support/helpers/settings";
import { expect, test } from "../support/fixtures";
import {
  gotoWorkspace,
  pressNewTabShortcut,
  expectTabTitleFits,
} from "../support/helpers/launcher";
import { seedWorkspace } from "../support/helpers/seed-client";
import { installDaemonWebSocketGate } from "../support/helpers/daemon-websocket-gate";
import {
  ensureExplorerSidebar,
  openFilesPanel,
  waitForWorkspaceTabsVisible,
} from "../support/helpers/workspace-tabs";

function explorerSidebar(page: Parameters<typeof ensureExplorerSidebar>[0]) {
  return page.getByTestId("workspace-explorer-sidebar").filter({ visible: true });
}

function paintedBackground(element: HTMLElement): string {
  let node: HTMLElement | null = element;
  while (node) {
    const color = getComputedStyle(node).backgroundColor;
    if (color !== "transparent" && color !== "rgba(0, 0, 0, 0)") return color;
    node = node.parentElement;
  }
  return "transparent";
}

function paintedOpacity(element: Element): number {
  let opacity = 1;
  for (let node: Element | null = element; node; node = node.parentElement)
    opacity *= Number(getComputedStyle(node).opacity);
  return opacity;
}

async function expectExplorerActiveTabForeground(
  page: Parameters<typeof ensureExplorerSidebar>[0],
) {
  await openFilesPanel(page);
  const main = page.getByTestId("workspace-pane-main");
  await main.hover();
  const activeMainLabel = main
    .getByTestId("workspace-tabs-row")
    .locator('[aria-selected="true"]')
    .getByText("New tab", { exact: true });
  const foreground = await activeMainLabel.evaluate((element) => getComputedStyle(element).color);
  const activeFiles = explorerSidebar(page).getByRole("button", {
    name: "Browse workspace files",
    exact: true,
  });
  await expect(activeFiles).toHaveAttribute("aria-selected", "true");
  await expect(activeFiles.getByText("Files", { exact: true })).toHaveCSS("color", foreground);
}

test.describe("Explorer sidebar", () => {
  test("status bar branch picker switches only the selected worktree", async ({ page }) => {
    const workspace = await seedWorkspace({ repoPrefix: "status-branch-picker-" });
    const git = promisify(execFile);
    const linkedPath = `${workspace.repoPath}-linked`;
    const remotePath = `${workspace.repoPath}-remote.git`;
    const incomingPath = `${workspace.repoPath}-incoming`;
    const gate = await installDaemonWebSocketGate(page);
    try {
      await git("git", ["init", "--bare", remotePath]);
      await git("git", ["remote", "add", "origin", remotePath], { cwd: workspace.repoPath });
      await git("git", ["branch", "feature/picker"], { cwd: workspace.repoPath });
      await git("git", ["worktree", "add", "-b", "linked-worktree", linkedPath], {
        cwd: workspace.repoPath,
      });
      const created = await workspace.client.createWorkspace({
        source: { kind: "directory", path: linkedPath },
      });
      expect(created.workspace).toBeTruthy();
      if (!created.workspace) throw new Error("Worktree workspace was not created");
      await gotoWorkspace(page, created.workspace.id);
      const branch = page.getByTestId("status-bar-branch");
      await expect(branch).toHaveText("linked-worktree");
      await branch.click();
      const picker = page.getByTestId("combobox-desktop-container");
      await expect(
        picker.getByRole("button", { name: "linked-worktree", exact: true }),
      ).toBeVisible();
      const search = picker.getByPlaceholder("Filter branches...");
      await expect(search).toBeFocused();
      await search.fill("feature/picker");
      await picker.getByRole("button", { name: "feature/picker", exact: true }).click();
      await expect(branch).toHaveText("feature/picker");
      const linkedBranch = await git("git", ["branch", "--show-current"], { cwd: linkedPath });
      const rootBranch = await git("git", ["branch", "--show-current"], {
        cwd: workspace.repoPath,
      });
      expect(linkedBranch.stdout.trim()).toBe("feature/picker");
      expect(rootBranch.stdout.trim()).not.toBe("feature/picker");
      await branch.click();
      gate.holdNextServerMessage("branch_suggestions_response");
      await search.fill("feature/brand-new");
      await gate.waitForHeldServerMessage("branch_suggestions_response");
      await expect(picker.getByText("Loading...", { exact: true })).toHaveCount(0);
      await expect(
        picker.getByRole("button", { name: "feature/brand-new (New branch)", exact: true }),
      ).toBeVisible();
      gate.releaseHeldServerMessage("branch_suggestions_response");
      const createOption = picker.getByRole("button", {
        name: "feature/brand-new (New branch)",
        exact: true,
      });
      await expect(createOption).toBeVisible();
      page.once("dialog", (dialog) => {
        void dialog.dismiss();
      });
      await createOption.click();
      await expect(branch).toHaveText("feature/picker");
      const cancelled = await git("git", ["branch", "--list", "feature/brand-new"], {
        cwd: linkedPath,
      });
      expect(cancelled.stdout.trim()).toBe("");
      await expect(branch).toBeEnabled();
      await branch.click();
      await search.fill("feature/brand-new");
      page.once("dialog", (dialog) => {
        expect(dialog.message()).toContain("feature/brand-new");
        void dialog.accept();
      });
      await createOption.click();
      await expect(branch).toHaveText("feature/brand-new");
      const newBranch = await git("git", ["branch", "--show-current"], { cwd: linkedPath });
      expect(newBranch.stdout.trim()).toBe("feature/brand-new");
      const explorer = await ensureExplorerSidebar(page);
      await explorer.getByRole("button", { name: "Source Control", exact: true }).click();
      await explorer.getByRole("button", { name: "Publish branch", exact: true }).click();
      await expect
        .poll(async () => {
          try {
            const result = await git("git", ["rev-parse", "--abbrev-ref", "@{upstream}"], {
              cwd: linkedPath,
            });
            return result.stdout.trim();
          } catch {
            return "";
          }
        })
        .toBe("origin/feature/brand-new");
      await expect(
        explorer.getByRole("button", { name: "Commit staged changes", exact: true }),
      ).toBeVisible();
      await git("git", ["clone", "--branch", "feature/brand-new", remotePath, incomingPath]);
      await writeFile(path.join(incomingPath, "incoming.txt"), "incoming change\n");
      await git("git", ["add", "incoming.txt"], { cwd: incomingPath });
      await git(
        "git",
        [
          "-c",
          "user.name=Pull test",
          "-c",
          "user.email=pull@example.test",
          "-c",
          "commit.gpgsign=false",
          "commit",
          "-m",
          "incoming change",
        ],
        { cwd: incomingPath },
      );
      await git("git", ["push"], { cwd: incomingPath });
      await git("git", ["fetch", "origin"], { cwd: linkedPath });
      await explorer.getByRole("button", { name: "Refresh", exact: true }).click();
      const pull = explorer.getByRole("button", { name: "Pull incoming commits", exact: true });
      await expect(pull).toHaveText("Pull 1↓");
      await expect(pull).toBeEnabled();
      await pull.click();
      await expect(
        explorer.getByRole("button", { name: "Commit staged changes", exact: true }),
      ).toBeVisible();
      expect(await readFile(path.join(linkedPath, "incoming.txt"), "utf8")).toBe(
        "incoming change\n",
      );
      await git(
        "git",
        [
          "-c",
          "user.name=Sync test",
          "-c",
          "user.email=sync@example.test",
          "-c",
          "commit.gpgsign=false",
          "commit",
          "--allow-empty",
          "-m",
          "local sync commit",
        ],
        { cwd: linkedPath },
      );
      await git(
        "git",
        [
          "-c",
          "user.name=Sync test",
          "-c",
          "user.email=sync@example.test",
          "-c",
          "commit.gpgsign=false",
          "commit",
          "--allow-empty",
          "-m",
          "remote sync commit",
        ],
        { cwd: incomingPath },
      );
      await git("git", ["push"], { cwd: incomingPath });
      await git("git", ["fetch", "origin"], { cwd: linkedPath });
      await explorer.getByRole("button", { name: "Refresh", exact: true }).click();
      const sync = explorer.getByRole("button", { name: "Sync changes", exact: true });
      await expect(sync).toHaveText("Sync Changes 1↓ 1↑");
      await expect(sync).toBeEnabled();
      await sync.click();
      await expect(
        explorer.getByRole("button", { name: "Commit staged changes", exact: true }),
      ).toBeVisible();
      const localHead = await git("git", ["rev-parse", "HEAD"], { cwd: linkedPath });
      const remoteHead = await git("git", ["rev-parse", "refs/heads/feature/brand-new"], {
        cwd: remotePath,
      });
      expect(remoteHead.stdout).toBe(localHead.stdout);
      await page.screenshot({ path: test.info().outputPath("status-branch-switched.png") });
    } finally {
      await git("git", ["worktree", "remove", "--force", linkedPath], {
        cwd: workspace.repoPath,
      }).catch(() => {});
      await rm(incomingPath, { recursive: true, force: true });
      await rm(remotePath, { recursive: true, force: true });
      await workspace.cleanup();
    }
  });
  test("Source Control badge follows discard, refresh, partial staging, and commit", async ({
    page,
  }) => {
    const workspace = await seedWorkspace({
      repoPrefix: "scm-live-count-",
      repo: {
        files: [
          { path: "a.txt", content: "base\n" },
          { path: "b.txt", content: "base\n" },
        ],
      },
    });
    try {
      for (const name of ["a.txt", "b.txt"])
        await writeFile(path.join(workspace.repoPath, name), "modified\n");
      await gotoWorkspace(page, workspace.workspaceId);
      const explorer = await ensureExplorerSidebar(page);
      await explorer.getByRole("button", { name: "Source Control", exact: true }).click();
      const scm = explorer.getByTestId("source-control-panel");
      const badge = explorer.getByTestId("source-control-change-badge");
      await expect(badge).toHaveText("2");
      const a = scm.getByRole("button", { name: "Open working tree diff for a.txt", exact: true });
      const b = scm.getByRole("button", { name: "Open working tree diff for b.txt", exact: true });
      const modifiers: Array<"Meta" | "Control"> = [
        process.platform === "darwin" ? "Meta" : "Control",
      ];
      await a.click({ modifiers });
      await b.click({ modifiers });
      await a.click({ button: "right" });
      const confirmation = page.waitForEvent("dialog");
      const discardClick = page
        .getByRole("menuitem", { name: "Discard 2 Tracked Changes…", exact: true })
        .click();
      const dialog = await confirmation;
      expect(dialog.message()).toBe(
        "Discard changes?\n\nPermanently discard 2 tracked file(s)? This cannot be undone. Untracked files are preserved.",
      );
      await dialog.accept();
      await discardClick;
      await expect(scm.getByText("No changes to commit.", { exact: true })).toBeVisible();
      await expect(badge).toHaveCount(0, { timeout: 1000 });
      await expect(scm.getByTestId("source-control-refresh")).toBeEnabled();
      await expect(badge).toHaveCount(0);
      await writeFile(path.join(workspace.repoPath, "a.txt"), "first change\n");
      await scm.getByTestId("source-control-refresh").click();
      await expect(a).toBeVisible();
      await expect(badge).toHaveText("1", { timeout: 1000 });
      await a.hover();
      await scm.getByRole("button", { name: "Stage a.txt", exact: true }).click();
      await expect(
        scm.getByRole("button", { name: "Open staged diff for a.txt", exact: true }),
      ).toBeVisible();
      await expect(scm.getByTestId("source-control-refresh")).toBeEnabled();
      await writeFile(path.join(workspace.repoPath, "a.txt"), "second change\n");
      await scm.getByTestId("source-control-refresh").click();
      await expect(a).toBeVisible();
      await expect(badge).toHaveText("1", { timeout: 1000 });
      await a.hover();
      await scm.getByRole("button", { name: "Stage a.txt", exact: true }).click();
      await expect(a).toHaveCount(0);
      await expect(scm.getByTestId("source-control-refresh")).toBeEnabled();
      await scm.getByTestId("source-control-commit-message").fill("Update badge fixture");
      await scm.getByRole("button", { name: "Commit staged changes", exact: true }).click();
      await expect(scm.getByText("No changes to commit.", { exact: true })).toBeVisible();
      await expect(badge).toHaveCount(0, { timeout: 1000 });
      await expect(scm.getByTestId("source-control-refresh")).toBeEnabled();
    } finally {
      await workspace.cleanup();
    }
  });
  test("Source Control preserves batch selection after a stale-revision failure", async ({
    page,
  }) => {
    const gate = await installDaemonWebSocketGate(page);
    const workspace = await seedWorkspace({
      repoPrefix: "scm-selection-failure-",
      repo: {
        files: [
          { path: "a.txt", content: "base\n" },
          { path: "b.txt", content: "base\n" },
        ],
      },
    });
    try {
      await writeFile(path.join(workspace.repoPath, "a.txt"), "first change\n");
      await writeFile(path.join(workspace.repoPath, "b.txt"), "first change\n");
      await gotoWorkspace(page, workspace.workspaceId);
      const explorer = await ensureExplorerSidebar(page);
      await explorer.getByRole("button", { name: "Source Control", exact: true }).click();
      const scm = explorer.getByTestId("source-control-panel");
      const a = scm.getByRole("button", { name: "Open working tree diff for a.txt", exact: true });
      const b = scm.getByRole("button", { name: "Open working tree diff for b.txt", exact: true });
      const modifiers: Array<"Meta" | "Control"> = [
        process.platform === "darwin" ? "Meta" : "Control",
      ];
      await a.click({ modifiers });
      await b.click({ modifiers });
      await a.click({ button: "right" });
      gate.holdNextClientRequest("plugin.rpc.invoke.request");
      await page.getByRole("menuitem", { name: "Stage 2 Changes", exact: true }).click();
      await gate.waitForHeldClientRequest();
      await writeFile(path.join(workspace.repoPath, "a.txt"), "changed while staging\n");
      gate.releaseHeldClientRequest();
      await expect(scm.getByRole("alert")).toContainText(
        "Files changed. Refresh and review the diff before trying again.",
      );
      await expect(scm.getByTestId("source-control-refresh")).toBeEnabled();
      await expect(a).toHaveAttribute("aria-selected", "true");
      await expect(b).toHaveAttribute("aria-selected", "true");
      await a.click({ button: "right" });
      await page.getByRole("menuitem", { name: "Stage 2 Changes", exact: true }).click();
      await expect(
        scm.getByRole("button", { name: "Open staged diff for a.txt", exact: true }),
      ).toBeVisible();
      await expect(
        scm.getByRole("button", { name: "Open staged diff for b.txt", exact: true }),
      ).toBeVisible();
      expect(await readFile(path.join(workspace.repoPath, "a.txt"), "utf8")).toBe(
        "changed while staging\n",
      );
    } finally {
      await workspace.cleanup();
    }
  });
  test("Source Control modifier selection stages and unstages only the selected files", async ({
    page,
  }) => {
    await page.addInitScript(() => {
      localStorage.setItem("@mixer:app-settings", JSON.stringify({ theme: "dark" }));
    });
    const workspace = await seedWorkspace({
      repoPrefix: "scm-multi-select-",
      repo: {
        files: [
          { path: "a.txt", content: "base\n" },
          { path: "b.txt", content: "base\n" },
          { path: "c.txt", content: "base\n" },
        ],
      },
    });
    try {
      for (const name of ["a.txt", "b.txt", "c.txt"])
        await writeFile(path.join(workspace.repoPath, name), "modified\n");
      await gotoWorkspace(page, workspace.workspaceId);
      const explorer = await ensureExplorerSidebar(page);
      await explorer.getByRole("button", { name: "Source Control", exact: true }).click();
      const scm = explorer.getByTestId("source-control-panel");
      const a = scm.getByRole("button", { name: "Open working tree diff for a.txt", exact: true });
      const b = scm.getByRole("button", { name: "Open working tree diff for b.txt", exact: true });
      const c = scm.getByRole("button", { name: "Open working tree diff for c.txt", exact: true });
      await a.click();
      await c.click({ modifiers: ["Shift"] });
      const selectedRows = scm.locator('[aria-label^="Open "][aria-selected="true"]');
      await expect(selectedRows).toHaveCount(3);
      await b.click({ modifiers: [process.platform === "darwin" ? "Meta" : "Control"] });
      await expect(selectedRows).toHaveCount(2);
      await expect(a).toHaveAttribute("aria-selected", "true");
      await expect(b).toHaveAttribute("aria-selected", "false");
      await expect(c).toHaveAttribute("aria-selected", "true");
      await expect(scm.getByTestId("source-control-selection-toolbar")).toHaveCount(0);
      await expect(scm.getByRole("checkbox")).toHaveCount(0);
      await expect(scm.getByRole("button", { name: "Select files", exact: true })).toHaveCount(0);
      await expect(
        page.getByRole("button", { name: "a.txt (Working Tree)", exact: true }),
      ).toBeVisible();
      await expect(
        page.getByRole("button", { name: "c.txt (Working Tree)", exact: true }),
      ).toHaveCount(0);
      await b.click({ button: "right" });
      await expect(
        page.getByRole("menuitem", { name: "Stage Changes", exact: true }),
      ).toBeVisible();
      await expect(a).toHaveAttribute("aria-selected", "false");
      await expect(c).toHaveAttribute("aria-selected", "false");
      await expect(b).toHaveAttribute("aria-selected", "true");
      await page.getByRole("menuitem", { name: "Stage Changes", exact: true }).press("Escape");
      await a.click();
      await c.click({ modifiers: [process.platform === "darwin" ? "Meta" : "Control"] });
      await a.click({ button: "right" });
      await expect(selectedRows).toHaveCount(2);
      await expect
        .poll(() =>
          page
            .getByRole("menuitem", { name: "Stage 2 Changes", exact: true })
            .evaluate(paintedOpacity),
        )
        .toBeGreaterThan(0.99);
      await page.screenshot({
        path: test.info().outputPath("source-control-context-selection.png"),
      });
      await page.getByRole("menuitem", { name: "Stage 2 Changes", exact: true }).click();
      const stagedA = scm.getByRole("button", { name: "Open staged diff for a.txt", exact: true });
      const stagedC = scm.getByRole("button", { name: "Open staged diff for c.txt", exact: true });
      await expect(stagedA).toBeVisible();
      await expect(stagedC).toBeVisible();
      await expect(b).toBeVisible();
      await expect(a).toHaveCount(0);
      await expect(scm.getByTestId("source-control-refresh")).toBeEnabled();
      await stagedA.click();
      await stagedC.click({ modifiers: [process.platform === "darwin" ? "Meta" : "Control"] });
      await stagedA.click({ button: "right" });
      await page.getByRole("menuitem", { name: "Unstage 2 Changes", exact: true }).click();
      await expect(a).toBeVisible();
      await expect(c).toBeVisible();
      await expect(stagedA).toHaveCount(0);
      await expect(stagedC).toHaveCount(0);
      await expect(scm.getByTestId("source-control-refresh")).toBeEnabled();
      await scm.getByTestId("source-control-actions").selectOption("stage-all");
      await expect(
        scm.getByRole("button", { name: "Open staged diff for b.txt", exact: true }),
      ).toBeVisible();
      await expect(scm.getByTestId("source-control-refresh")).toBeEnabled();
      await scm.getByTestId("source-control-actions").selectOption("unstage-all");
      await expect(a).toBeVisible();
      await expect(b).toBeVisible();
      await expect(c).toBeVisible();
      await expect(stagedA).toHaveCount(0);
      for (const name of ["a.txt", "b.txt", "c.txt"])
        expect(await readFile(path.join(workspace.repoPath, name), "utf8")).toBe("modified\n");
    } finally {
      await workspace.cleanup();
    }
  });

  test("Source Control keyboard selection and context actions respect filters, collapsed folders, and discard confirmation", async ({
    page,
  }) => {
    const workspace = await seedWorkspace({
      repoPrefix: "scm-selection-tree-",
      repo: {
        files: [
          { path: "src/a.txt", content: "base\n" },
          { path: "src/b.txt", content: "base\n" },
          { path: "src/nested/c.txt", content: "base\n" },
        ],
      },
    });
    try {
      for (const name of ["src/a.txt", "src/b.txt", "src/nested/c.txt"])
        await writeFile(path.join(workspace.repoPath, name), "modified\n");
      await writeFile(path.join(workspace.repoPath, "new.txt"), "preserve untracked\n");
      await gotoWorkspace(page, workspace.workspaceId);
      const explorer = await ensureExplorerSidebar(page);
      await explorer.getByRole("button", { name: "Source Control", exact: true }).click();
      const scm = explorer.getByTestId("source-control-panel");
      const a = scm.getByRole("button", {
        name: "Open working tree diff for src/a.txt",
        exact: true,
      });
      const b = scm.getByRole("button", {
        name: "Open working tree diff for src/b.txt",
        exact: true,
      });
      const modifiers: Array<"Meta" | "Control"> = [
        process.platform === "darwin" ? "Meta" : "Control",
      ];
      await a.click({ modifiers });
      await b.click({ modifiers });
      const selectedRows = scm.locator('[aria-label^="Open "][aria-selected="true"]');
      await expect(selectedRows).toHaveCount(2);
      await scm.getByRole("button", { name: "Filter changes", exact: true }).click();
      await scm.getByLabel("Filter changed files", { exact: true }).fill("a.txt");
      await expect(selectedRows).toHaveCount(1);
      await scm.getByRole("button", { name: "Clear filter", exact: true }).click();
      await expect(b).toHaveAttribute("aria-selected", "false");
      await scm.getByRole("button", { name: "View as Tree", exact: true }).click();
      await scm.getByRole("button", { name: "Collapse src/nested/", exact: true }).click();
      await expect(
        scm.getByRole("button", {
          name: "Open working tree diff for src/nested/c.txt",
          exact: true,
        }),
      ).toHaveCount(0);
      await a.focus();
      await a.press(process.platform === "darwin" ? "Meta+a" : "Control+a");
      await expect(selectedRows).toHaveCount(3);
      await a.press("Shift+ArrowDown");
      await expect(selectedRows).toHaveCount(2);
      await expect(
        scm.getByRole("button", { name: "Open working tree diff for src/b.txt", exact: true }),
      ).toBeFocused();
      const focusedB = scm.getByRole("button", {
        name: "Open working tree diff for src/b.txt",
        exact: true,
      });
      await focusedB.press("Escape");
      await expect(selectedRows).toHaveCount(0);
      await focusedB.press("Shift+ArrowUp");
      await expect(selectedRows).toHaveCount(2);
      await a.press(process.platform === "darwin" ? "Meta+a" : "Control+a");
      await a.click({ button: "right" });
      const confirmation = page.waitForEvent("dialog");
      const cancelClick = page
        .getByRole("menuitem", { name: "Discard 2 Tracked Changes…", exact: true })
        .click();
      const canceled = await confirmation;
      expect(canceled.message()).toBe(
        "Discard changes?\n\nPermanently discard 2 tracked file(s)? This cannot be undone. Untracked files are preserved.",
      );
      await canceled.dismiss();
      await cancelClick;
      expect(await readFile(path.join(workspace.repoPath, "src/a.txt"), "utf8")).toBe("modified\n");
      await a.click({ button: "right" });
      const accepted = page.waitForEvent("dialog");
      const discardClick = page
        .getByRole("menuitem", { name: "Discard 2 Tracked Changes…", exact: true })
        .click();
      await (await accepted).accept();
      await discardClick;
      await expect
        .poll(() => readFile(path.join(workspace.repoPath, "src/a.txt"), "utf8"))
        .toBe("base\n");
      expect(await readFile(path.join(workspace.repoPath, "src/b.txt"), "utf8")).toBe("base\n");
      expect(await readFile(path.join(workspace.repoPath, "src/nested/c.txt"), "utf8")).toBe(
        "modified\n",
      );
      expect(await readFile(path.join(workspace.repoPath, "new.txt"), "utf8")).toBe(
        "preserve untracked\n",
      );
    } finally {
      await workspace.cleanup();
    }
  });
  test("New tab menu and screen do not list opened Source Control files", async ({ page }) => {
    const workspace = await seedWorkspace({ repoPrefix: "launcher-without-files-" });
    try {
      await writeFile(path.join(workspace.repoPath, "launcher-file.txt"), "changed file\n");
      await gotoWorkspace(page, workspace.workspaceId);
      const explorer = await ensureExplorerSidebar(page);
      await explorer.getByRole("button", { name: "Source Control", exact: true }).click();
      await explorer
        .getByRole("button", { name: "Open working tree diff for launcher-file.txt", exact: true })
        .click();
      await expect(
        page.getByRole("button", { name: "launcher-file.txt (Working Tree)", exact: true }),
      ).toBeVisible();
      await pressNewTabShortcut(page);
      const launcher = page.getByTestId("workspace-new-tab-panel").filter({ visible: true });
      await expect(launcher).toBeVisible();
      await expect(launcher).not.toContainText("launcher-file.txt");
      await page.getByTestId("workspace-new-tab-button").filter({ visible: true }).click();
      const menu = page.getByTestId("workspace-new-tab-menu").filter({ visible: true });
      await expect(menu).toBeVisible();
      await expect(menu).not.toContainText("launcher-file.txt");
      await expect(menu.getByText("Agent", { exact: true })).toBeVisible();
      await expect(menu.getByText("Terminal", { exact: true })).toBeVisible();
    } finally {
      await workspace.cleanup();
    }
  });
  test("startup loads workspace and plugins without require cycles", async ({ page }) => {
    const cycles: string[] = [];
    page.on("console", (message) => {
      if (message.text().includes("Require cycle:")) cycles.push(message.text());
    });
    const workspace = await seedWorkspace({ repoPrefix: "startup-import-cycles-" });
    try {
      await gotoWorkspace(page, workspace.workspaceId);
      const explorer = await ensureExplorerSidebar(page);
      await explorer.getByTestId("workspace-tab-plugin_workspace_6_search_6_search").click();
      await expect(explorer.getByTestId("workspace-search-panel")).toBeVisible();
      expect(cycles).toEqual([]);
    } finally {
      await workspace.cleanup();
    }
  });
  test("renders Material file and folder icons without leaking vendor metadata into React DOM", async ({
    page,
  }) => {
    const warnings: string[] = [];
    page.on("console", (message) => {
      if (/does not recognize.*data|dataMitNoRecolor/.test(message.text()))
        warnings.push(message.text());
    });
    const workspace = await seedWorkspace({ repoPrefix: "material-svg-metadata-" });
    try {
      await writeFile(path.join(workspace.repoPath, "tsconfig.json"), "{}\n");
      await writeFile(path.join(workspace.repoPath, "typedoc.json"), "{}\n");
      await mkdir(path.join(workspace.repoPath, "gitlab"));
      await gotoWorkspace(page, workspace.workspaceId);
      const explorer = await ensureExplorerSidebar(page);
      await openFilesPanel(page);
      const tree = explorer.getByTestId("file-explorer-tree-scroll");
      await expect(tree.getByText("tsconfig.json", { exact: true })).toBeVisible();
      await expect(tree.getByText("typedoc.json", { exact: true })).toBeVisible();
      await expect(tree.getByText("gitlab", { exact: true })).toBeVisible();
      await expect(tree.locator("svg").first()).toBeVisible();
      await expect(
        tree.locator("[data-mit-no-recolor], [datamitnorecolor], [data-name], [dataname]"),
      ).toHaveCount(0);
      expect(warnings).toEqual([]);
    } finally {
      await workspace.cleanup();
    }
  });
  test("Search finds workspace text, filters matches, reports invalid regex, and opens the matching line", async ({
    page,
  }) => {
    const workspace = await seedWorkspace({ repoPrefix: "explorer-text-search-" });
    try {
      await mkdir(path.join(workspace.repoPath, "src"));
      await mkdir(path.join(workspace.repoPath, "node_modules"));
      await writeFile(path.join(workspace.repoPath, ".gitignore"), "node_modules/\n");
      await writeFile(
        path.join(workspace.repoPath, "src/reference.ts"),
        "const first = 1;\nconst searchNeedle = first;\nconst other = 'searchNeedle';\n",
      );
      await writeFile(path.join(workspace.repoPath, "readme.txt"), "searchneedle\n");
      await writeFile(path.join(workspace.repoPath, "node_modules/ignored.txt"), "searchNeedle\n");
      await writeFile(
        path.join(workspace.repoPath, "src/many.ts"),
        "const limitNeedle = 1;\n".repeat(1050),
      );
      await gotoWorkspace(page, workspace.workspaceId);
      const explorer = await ensureExplorerSidebar(page);
      const searchTab = explorer.getByTestId("workspace-tab-plugin_workspace_6_search_6_search");
      await searchTab.click();
      const search = explorer.getByTestId("workspace-search-panel");
      await expect(search).toBeVisible();
      const input = search.getByLabel("Search workspace text", { exact: true });
      await input.fill("searchNeedle");
      await expect(search.getByTestId("search-status")).toHaveText("3 results in 2 files");
      await search.getByRole("button", { name: "Match case", exact: true }).click();
      await expect(search.getByTestId("search-status")).toHaveText("2 results in 1 file");
      await search.getByRole("button", { name: "Toggle search details", exact: true }).click();
      await search.getByLabel("Files to include", { exact: true }).fill("*.txt");
      await expect(search.getByTestId("search-status")).toHaveText("No results found.");
      await search.getByLabel("Files to include", { exact: true }).fill("src/**");
      await expect(search.getByTestId("search-status")).toHaveText("2 results in 1 file");
      await search.getByRole("button", { name: "Use regular expression", exact: true }).click();
      await input.fill("(");
      await expect(search.getByTestId("search-status")).toContainText("regex parse error");
      await search.getByRole("button", { name: "Use regular expression", exact: true }).click();
      await input.fill("does-not-exist");
      await expect(search.getByTestId("search-status")).toHaveText("No results found.");
      await input.fill("limitNeedle");
      await expect(search.getByTestId("search-status")).toHaveText("1000+ results in 1 file");
      await expect(search).toContainText("Showing the first 1,000 matches");
      await expect
        .poll(() => search.locator('[data-testid^="search-hit-"]').count())
        .toBeGreaterThan(0);
      expect(await search.locator('[data-testid^="search-hit-"]').count()).toBeLessThan(200);
      await search.getByTestId("search-results").evaluate((element) => {
        element.scrollTop = element.scrollHeight;
      });
      await expect(search.getByTestId("search-hit-src/many.ts-1000-7")).toBeVisible();
      await search
        .getByRole("button", { name: "Collapse all search results", exact: true })
        .click();
      await expect(search.locator('[data-testid^="search-hit-"]')).toHaveCount(0);
      await input.fill("searchNeedle");
      await expect(search.getByTestId("search-status")).toHaveText("2 results in 1 file");
      await page.screenshot({ path: test.info().outputPath("workspace-search.png") });
      await search.getByTestId("search-hit-src/reference.ts-2-7").click();
      await expect(
        page.getByTestId("workspace-tab-file_src/reference.ts").filter({ visible: true }),
      ).toBeVisible();
      await expect(page.getByTestId("file-source-editor").filter({ visible: true })).toBeVisible();
      await expect(
        page.getByTestId("file-source-editor").filter({ visible: true }).locator(".cm-activeLine"),
      ).toHaveText("const searchNeedle = first;");
    } finally {
      await workspace.cleanup();
    }
  });
  test("Search and Source Control share blue full-field focus outlines", async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem("@mixer:app-settings", JSON.stringify({ theme: "dark" }));
    });
    const workspace = await seedWorkspace({ repoPrefix: "explorer-input-focus-" });
    try {
      await gotoWorkspace(page, workspace.workspaceId);
      const explorer = await ensureExplorerSidebar(page);
      await explorer.getByTestId("workspace-tab-plugin_workspace_6_search_6_search").click();
      const search = explorer.getByTestId("workspace-search-panel");
      const input = search.getByLabel("Search workspace text", { exact: true });
      await expect(input).toBeFocused();
      await page.keyboard.type("autofocus");
      await expect(input).toHaveValue("autofocus");
      await explorer.getByTestId("workspace-tab-files").click();
      await explorer.getByTestId("workspace-tab-plugin_workspace_6_search_6_search").click();
      await expect(input).toBeFocused();
      const frame = search.getByTestId("workspace-search-query-frame");
      await expect(frame).toHaveCSS("outline-color", "rgb(56, 123, 206)");
      await expect(frame).toHaveCSS("outline-width", "2px");
      await expect(frame).toHaveCSS("border-color", "rgba(0, 0, 0, 0)");
      await expect(input).toHaveCSS("outline-width", "0px");
      for (const name of ["Match case", "Match whole word", "Use regular expression"]) {
        const icon = frame.getByRole("button", { name, exact: true });
        await expect(icon).toBeVisible();
        const frameBox = await frame.boundingBox();
        const iconBox = await icon.boundingBox();
        expect(frameBox).not.toBeNull();
        expect(iconBox).not.toBeNull();
        if (frameBox && iconBox) {
          expect(iconBox.x).toBeGreaterThanOrEqual(frameBox.x);
          expect(iconBox.x + iconBox.width).toBeLessThanOrEqual(frameBox.x + frameBox.width);
        }
      }
      await page.screenshot({ path: test.info().outputPath("search-focus.png") });
      await search.getByRole("button", { name: "Toggle search details", exact: true }).click();
      await input.blur();
      await expect(frame).toHaveCSS("outline-style", "none");
      for (const name of ["Files to include", "Files to exclude"]) {
        const filter = search.getByLabel(name, { exact: true });
        await filter.focus();
        await expect(filter).toHaveCSS("outline-width", "0px");
        await expect(filter.locator("..")).toHaveCSS("outline-color", "rgb(56, 123, 206)");
        await expect(filter.locator("..")).toHaveCSS("outline-width", "2px");
      }
      await explorer.getByRole("button", { name: "Source Control", exact: true }).click();
      const commitInput = explorer.getByTestId("source-control-commit-message");
      await commitInput.focus();
      await expect(commitInput).toHaveCSS("outline-color", "rgb(56, 123, 206)");
      await expect(commitInput).toHaveCSS("outline-width", "2px");
    } finally {
      await workspace.cleanup();
    }
  });
  test("aligns Source Control and Files pane titles, actions, and backgrounds", async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: "light" });
    const workspace = await seedWorkspace({ repoPrefix: "explorer-header-alignment-" });
    try {
      await gotoWorkspace(page, workspace.workspaceId);
      const explorer = await ensureExplorerSidebar(page);
      await openFilesPanel(page);
      const filesTitle = explorer.getByTestId("files-root-folder-name");
      await expect(filesTitle).toBeVisible();
      const files = await filesTitle.evaluate((element) => {
        const box = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return {
          x: box.x,
          y: box.y,
          height: box.height,
          fontSize: style.fontSize,
          fontWeight: style.fontWeight,
          letterSpacing: style.letterSpacing,
        };
      });
      const filesHeader = await explorer.getByTestId("files-pane-header").boundingBox();
      const filesBackground = await explorer
        .getByTestId("file-explorer-tree-scroll")
        .evaluate(paintedBackground);
      const filesAction = await explorer.getByTestId("files-new-file").boundingBox();
      const filesTrailing = await explorer.getByTestId("files-refresh").boundingBox();
      const filesIcon = await explorer
        .getByTestId("files-new-file")
        .locator("svg")
        .evaluate((element) => {
          const box = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          return {
            width: box.width,
            height: box.height,
            stroke: style.stroke,
            strokeWidth: style.strokeWidth,
          };
        });
      await explorer
        .getByTestId("workspace-tab-plugin_workspace_14_source-control_14_source-control")
        .click();
      const title = explorer.getByTestId("source-control-pane-title");
      expect(await explorer.getByTestId("source-control-panel").evaluate(paintedBackground)).toBe(
        filesBackground,
      );
      await expect(title).toHaveText("Source Control");
      await expect(title).toHaveCSS("font-size", files.fontSize);
      await expect(title).toHaveCSS("font-weight", files.fontWeight);
      await expect(title).toHaveCSS("letter-spacing", files.letterSpacing);
      const source = await title.boundingBox();
      expect(source?.x).toBe(files.x);
      expect(source?.y).toBe(files.y);
      expect(source?.height).toBe(files.height);
      const sourceHeader = await explorer.getByTestId("source-control-pane-header").boundingBox();
      expect(sourceHeader?.height).toBe(filesHeader?.height);
      const sourceAction = await explorer.getByTestId("source-control-filter").boundingBox();
      const sourceTrailing = await explorer.getByTestId("source-control-actions").boundingBox();
      expect(sourceAction).toEqual(filesAction);
      expect(sourceTrailing).toEqual(filesTrailing);
      const sourceIcon = await explorer
        .getByTestId("source-control-filter")
        .locator("svg")
        .evaluate((element) => {
          const box = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          return {
            width: box.width,
            height: box.height,
            stroke: style.stroke,
            strokeWidth: style.strokeWidth,
          };
        });
      expect(sourceIcon).toEqual(filesIcon);
      await page.emulateMedia({ colorScheme: "dark" });
      await openFilesPanel(page);
      await expect
        .poll(() => explorer.getByTestId("file-explorer-tree-scroll").evaluate(paintedBackground))
        .not.toBe(filesBackground);
      const darkFilesBackground = await explorer
        .getByTestId("file-explorer-tree-scroll")
        .evaluate(paintedBackground);
      await explorer
        .getByTestId("workspace-tab-plugin_workspace_14_source-control_14_source-control")
        .click();
      await expect
        .poll(() => explorer.getByTestId("source-control-panel").evaluate(paintedBackground))
        .toBe(darkFilesBackground);
      await page.screenshot({ path: test.info().outputPath("source-control-header-aligned.png") });
    } finally {
      await workspace.cleanup();
    }
  });
  test("starts with Files and Changes, switches views, and toggles without changing main", async ({
    page,
  }) => {
    const workspace = await seedWorkspace({ repoPrefix: "explorer-sidebar-defaults-" });

    try {
      await gotoWorkspace(page, workspace.workspaceId);
      await waitForWorkspaceTabsVisible(page);
      const mainTabsBefore = await page
        .getByTestId("workspace-pane-main")
        .locator('[data-testid^="workspace-tab-"]')
        .count();

      const explorer = await ensureExplorerSidebar(page);
      await expect(explorer.getByTestId("workspace-tab-files")).toBeVisible();
      await expect(explorer.getByTestId("workspace-tab-changes_tree")).toBeVisible();
      await expect(explorer.getByTestId("workspace-new-tab-button")).toHaveCount(1);

      await expectExplorerActiveTabForeground(page);
      await expect(explorer.getByTestId("file-explorer-tree-scroll")).toBeVisible();

      await explorer.getByTestId("workspace-tab-changes_tree").click();
      await expect(explorer.getByTestId("changes-tree-panel")).toBeVisible();

      await page.getByTestId("workspace-explorer-toggle").first().click();
      await expect(explorerSidebar(page)).toHaveCount(0);
      await expect(
        page.getByTestId("workspace-pane-main").locator('[data-testid^="workspace-tab-"]'),
      ).toHaveCount(mainTabsBefore);
    } finally {
      await workspace.cleanup();
    }
  });
});

async function launchExplorerPanel(
  page: Parameters<typeof ensureExplorerSidebar>[0],
  name: string,
) {
  const explorer = explorerSidebar(page);
  await explorer.getByRole("button", { name: "New tab", exact: true }).click();
  await page.getByRole("menuitem", { name: new RegExp(`^${name}`) }).click();
  await explorer.getByRole("button", { name: "New tab", exact: true }).click();
  await expect(page.getByRole("menuitem", { name: new RegExp(`^${name}`) })).toHaveCount(0);
  await page.keyboard.press("Escape");
}

async function closeExplorerFilesFromContextMenu(
  page: Parameters<typeof ensureExplorerSidebar>[0],
) {
  const explorer = explorerSidebar(page);
  const files = explorer.getByRole("button", { name: "Browse workspace files", exact: true });
  await files.hover();
  await expect(explorer.getByTestId("workspace-files-close")).toHaveCount(0);
  await explorer.getByTestId("workspace-tab-changes_tree").hover();
  await expect(explorer.getByTestId("workspace-working-diff-close-changes_tree")).toHaveCount(0);
  await files.click({ button: "right", position: { x: 12, y: 13 } });
  await page.getByRole("menuitem", { name: "Close", exact: true }).click();
  await expect(files).toHaveCount(0);
}

async function expectWorkspaceCloseOnHover(page: Parameters<typeof ensureExplorerSidebar>[0]) {
  const main = page.getByTestId("workspace-pane-main");
  const tab = main.locator('[data-testid^="workspace-tab-"][aria-selected="true"]');
  const close = main.getByRole("button", { name: "Close", exact: true });
  await explorerSidebar(page).hover();
  await expect(close.locator("..")).toHaveCSS("opacity", "0");
  await tab.hover();
  await expect(close.locator("..")).toHaveCSS("opacity", "1");
}

async function closeOtherExplorerTabs(page: Parameters<typeof ensureExplorerSidebar>[0]) {
  const files = explorerSidebar(page).getByRole("button", {
    name: "Browse workspace files",
    exact: true,
  });
  await files.click({ button: "right", position: { x: 12, y: 13 } });
  const confirmation = page.waitForEvent("dialog").then((dialog) => {
    expect(dialog.message()).toContain("close 1 tab");
    return dialog.accept();
  });
  await page.getByRole("menuitem", { name: "Close other tabs", exact: true }).click();
  await confirmation;
}

test("Explorer keeps Files and Changes close actions in the context menu", async ({
  page,
}, testInfo) => {
  const workspace = await seedWorkspace({ repoPrefix: "explorer-shared-tabs-" });
  try {
    await gotoWorkspace(page, workspace.workspaceId);
    await waitForWorkspaceTabsVisible(page);
    const main = page.getByTestId("workspace-pane-main");
    const mainTabsBefore = await main.getByTestId("workspace-tabs-row").getByRole("button").count();
    const explorer = await ensureExplorerSidebar(page);
    await expectTabTitleFits(page, "Files", { min: 64, max: 90 });

    await test.step("Explorer's + menu excludes Agent and terminal profiles", async () => {
      await explorer.getByRole("button", { name: "New tab", exact: true }).click();
      const menu = page.getByTestId("workspace-new-tab-menu").filter({ visible: true });
      await expect(menu).toBeVisible();
      await expect(menu.getByRole("menuitem", { name: /^Agent/ })).toHaveCount(1);
      await expect(menu.getByRole("menuitem", { name: /^Files/ })).toHaveCount(0);
      await expect(menu.getByRole("menuitem", { name: /^Changes/ })).toHaveCount(0);
      await expect(menu.getByRole("menuitem", { name: /^Terminal/ })).toBeVisible();
      const entries = await menu.getByRole("menuitem").allTextContents();
      expect(entries.findIndex((entry) => entry.startsWith("Terminal"))).toBeLessThan(
        entries.findIndex((entry) => entry.startsWith("Diff")),
      );
      await page.keyboard.press("Escape");
      await main.getByTestId("workspace-new-tab-button").click();
      await expect(menu).toBeVisible();
      await expect(menu.getByRole("menuitem", { name: /^Agent/ })).toBeVisible();
      await expect(menu.getByText("Terminal profiles", { exact: true })).toBeVisible();
      await page.keyboard.press("Escape");
    });

    await test.step("Files and Changes omit X, and + restores Files after context-menu close", async () => {
      await expectWorkspaceCloseOnHover(page);
      await closeExplorerFilesFromContextMenu(page);
      await launchExplorerPanel(page, "Files");
      await expect(
        explorer.getByRole("button", { name: "Browse workspace files", exact: true }),
      ).toBeVisible();
      await expect(explorer.getByTestId("file-explorer-tree-scroll")).toBeVisible();
    });

    await test.step("standard bulk-close menus affect only Explorer tabs", async () => {
      await closeOtherExplorerTabs(page);
      await expect(explorer.getByTestId("workspace-tab-changes_tree")).toHaveCount(0);
      await expect(explorer.getByTestId("workspace-tab-files")).toBeVisible();
      await expect(main.getByTestId("workspace-tabs-row").getByRole("button")).toHaveCount(
        mainTabsBefore,
      );
      await launchExplorerPanel(page, "Changes");
      await expect(explorer.getByTestId("changes-tree-panel")).toBeVisible();
    });

    await test.step("Cmd+N still belongs to the focused workspace pane", async () => {
      await pressNewTabShortcut(page);
      await expect(
        main.getByTestId("workspace-new-tab-panel").filter({ visible: true }),
      ).toBeVisible();
      await expect(explorer.getByTestId("workspace-new-tab-panel")).toHaveCount(0);
    });

    await testInfo.attach("shared-explorer-tabs", {
      body: await page.screenshot(),
      contentType: "image/png",
    });
  } finally {
    await workspace.cleanup();
  }
});

async function dragTabIntoExplorer(
  page: Parameters<typeof ensureExplorerSidebar>[0],
  tabId: string,
) {
  const source = page.getByTestId("workspace-pane-main").getByTestId(`workspace-tab-${tabId}`);
  const destination = explorerSidebar(page).getByTestId("workspace-tab-files");
  const sourceBox = await source.boundingBox();
  const destinationBox = await destination.boundingBox();
  if (!sourceBox || !destinationBox)
    throw new Error("Tab drag requires visible source and destination");
  const start = { x: sourceBox.x + 12, y: sourceBox.y + sourceBox.height / 2 };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x + 12, start.y + 4);
  await page.mouse.move(destinationBox.x + 12, destinationBox.y + destinationBox.height / 2, {
    steps: 20,
  });
  await page.mouse.up();
}

test("moves agents into Explorer and keeps the shared Agent launcher available", async ({
  page,
}, testInfo) => {
  const workspace = await seedWorkspace({ repoPrefix: "explorer-agent-drag-" });
  try {
    await gotoWorkspace(page, workspace.workspaceId);
    const explorer = await ensureExplorerSidebar(page);
    const agent = await workspace.client.createAgent({
      provider: "mock",
      cwd: workspace.repoPath,
      workspaceId: workspace.workspaceId,
      title: "Dragged agent",
      modeId: "load-test",
      model: "ten-second-stream",
    });
    const main = page.getByTestId("workspace-pane-main");
    await expect(main.getByTestId(`workspace-tab-agent_${agent.id}`)).toBeVisible();
    await dragTabIntoExplorer(page, `agent_${agent.id}`);
    await expect(explorer.getByTestId(`workspace-tab-agent_${agent.id}`)).toBeVisible();
    await expect(main.getByTestId(`workspace-tab-agent_${agent.id}`)).toHaveCount(0);
    await explorer.getByRole("button", { name: "New tab", exact: true }).click();
    const menu = page.getByTestId("workspace-new-tab-menu").filter({ visible: true });
    await expect(menu).toBeVisible();
    await expect(menu.getByRole("menuitem", { name: /^Agent/ })).toHaveCount(1);
    await page.keyboard.press("Escape");
    await testInfo.attach("agent-in-explorer", {
      body: await page.screenshot(),
      contentType: "image/png",
    });
  } finally {
    await workspace.cleanup();
  }
});

test("tablet prototype keeps Explorer tabs when resizing down to a phone", async ({
  page,
}, testInfo) => {
  const workspace = await seedWorkspace({ repoPrefix: "tablet-explorer-" });
  try {
    await page.setViewportSize({ width: 951, height: 669 });
    await gotoWorkspace(page, workspace.workspaceId);
    await waitForWorkspaceTabsVisible(page);
    await ensureExplorerSidebar(page);
    await expect(
      explorerSidebar(page).getByRole("button", { name: "Browse workspace files", exact: true }),
    ).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("tablet-951.png") });
    await openExplorerAgentDraft(page);
    await page.screenshot({ path: testInfo.outputPath("tablet-agent-draft.png") });
    await page.setViewportSize({ width: 390, height: 844 });
    await revealPhoneExplorer(page);
    await expect(
      explorerSidebar(page).getByRole("button", { name: "New tab", exact: true }),
    ).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("phone-shared-explorer.png") });
  } finally {
    await workspace.cleanup();
  }
});

async function openExplorerAgentDraft(page: Parameters<typeof ensureExplorerSidebar>[0]) {
  await explorerSidebar(page).getByRole("button", { name: "New tab", exact: true }).click();
  await page.getByRole("menuitem", { name: /^Agent/ }).click();
  await expect(explorerSidebar(page).getByRole("textbox").first()).toBeVisible();
}

async function revealPhoneExplorer(page: Parameters<typeof ensureExplorerSidebar>[0]) {
  await page.getByRole("button", { name: "Open Explorer sidebar", exact: true }).click();
  await expect(explorerSidebar(page)).toBeVisible();
  await expect(
    explorerSidebar(page).getByRole("button", { name: "Close Explorer sidebar", exact: true }),
  ).toBeInViewport({ ratio: 1 });
}

async function cycleWorkspaceTheme(page: Parameters<typeof ensureExplorerSidebar>[0]) {
  await page.keyboard.press("Control+Alt+t");
}

test("retains the Explorer host through appearance changes and folding", async ({ page }) => {
  const workspace = await seedWorkspace({ repoPrefix: "explorer-lifetime-" });
  try {
    await gotoWorkspace(page, workspace.workspaceId);
    const explorer = await ensureExplorerSidebar(page);
    await openFilesPanel(page);
    const host = await explorer.elementHandle();
    if (!host) throw new Error("Explorer must be mounted before changing appearance");
    const previousColor = await explorer.evaluate(
      (element) => getComputedStyle(element).backgroundColor,
    );
    await cycleWorkspaceTheme(page);
    await expect
      .poll(() => explorer.evaluate((element) => getComputedStyle(element).backgroundColor))
      .not.toBe(previousColor);
    expect(await host.evaluate((element) => element.isConnected)).toBe(true);
    await page.setViewportSize({ width: 390, height: 844 });
    await ensureExplorerSidebar(page);
    expect(await host.evaluate((element) => element.isConnected)).toBe(true);
    await page.setViewportSize({ width: 1280, height: 900 });
    await expect(explorer).toBeVisible();
    expect(await host.evaluate((element) => element.isConnected)).toBe(true);
  } finally {
    await workspace.cleanup();
  }
});

async function reorderCompactExplorerTabs(page: Parameters<typeof ensureExplorerSidebar>[0]) {
  const explorer = explorerSidebar(page);
  const files = explorer.getByTestId("workspace-tab-files");
  const changes = explorer.getByTestId("workspace-tab-changes_tree");
  const source = await changes.boundingBox();
  const target = await files.boundingBox();
  if (!source || !target) throw new Error("Explorer tabs must be visible to reorder");
  await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2);
  await page.mouse.down();
  await page.mouse.move(source.x + source.width / 2 - 12, source.y + source.height / 2);
  await page.mouse.move(target.x + 3, target.y + target.height / 2, { steps: 20 });
  await page.mouse.up();
  await expect
    .poll(async () => {
      const afterFiles = await files.boundingBox();
      const afterChanges = await changes.boundingBox();
      return Boolean(afterFiles && afterChanges && afterChanges.x < afterFiles.x);
    })
    .toBe(true);
}

test("reorders compact Explorer tabs with a pointer without changing selection", async ({
  page,
}) => {
  const workspace = await seedWorkspace({ repoPrefix: "explorer-compact-drag-" });
  try {
    await gotoWorkspace(page, workspace.workspaceId);
    await page.setViewportSize({ width: 390, height: 844 });
    await openFilesPanel(page);
    await reorderCompactExplorerTabs(page);
    await expect(
      explorerSidebar(page).getByRole("button", { name: "Browse workspace files", exact: true }),
    ).toHaveAttribute("aria-selected", "true");
  } finally {
    await workspace.cleanup();
  }
});

// Exercise appearance at its consumers while the real workspace navigator retains the panels.
test("updates populated code and diff appearance without losing the editor instance or draft", async ({
  page,
}) => {
  const workspace = await seedWorkspace({ repoPrefix: "explorer-populated-appearance-" });
  const source = Array.from(
    { length: 120 },
    (_, index) => `export const line${index} = "retained ${index}";`,
  ).join("\n");
  try {
    await writeFile(`${workspace.repoPath}/appearance.ts`, source);
    await page.addInitScript(() => {
      localStorage.setItem(
        "@mixer:app-settings",
        JSON.stringify({ codeFontSize: 13, theme: "light" }),
      );
      localStorage.setItem(
        "@mixer:changes-preferences",
        JSON.stringify({ inlineDiff: true, layout: "unified" }),
      );
    });
    await gotoWorkspace(page, workspace.workspaceId);
    await openFilesPanel(page);
    await openFileFromExplorer(page, "appearance.ts");
    const editor = page.getByTestId("file-source-editor").filter({ visible: true });
    const text = editor.locator(".cm-content");
    await expect(text).toBeVisible();
    await text.fill(`${source}\n// unsaved local edit`);
    const instance = await editor.elementHandle();
    const scroller = editor.locator(".cm-scroller");
    await scroller.evaluate((node) => {
      node.scrollTop = 400;
    });
    const scrollBefore = await scroller.evaluate((node) => node.scrollTop);
    await explorerSidebar(page).getByTestId("workspace-tab-changes_tree").click();
    const diff = explorerSidebar(page).getByTestId("git-diff-canvas");
    await expect(diff).toBeVisible();
    await page.keyboard.press("Control+,");
    await openSettingsSection(page, "appearance");
    await page.getByLabel("Code font size", { exact: true }).fill("19");
    await page.getByLabel("Code font size", { exact: true }).press("Tab");
    await clickSettingsBackToWorkspace(page);
    await expect(text).toHaveCSS("font-size", "19px");
    expect(await instance!.evaluate((node) => node.isConnected)).toBe(true);
    await expect(text).toContainText("unsaved local edit");
    expect(await scroller.evaluate((node) => node.scrollTop)).toBe(scrollBefore);
    await expect(diff).toHaveCSS("font-size", "19px");
    await cycleWorkspaceTheme(page);
    expect(await instance!.evaluate((node) => node.isConnected)).toBe(true);
    await expect(text).toContainText("unsaved local edit");
    await dragTabIntoExplorer(page, "file_appearance.ts");
    await expect(explorerSidebar(page).getByTestId("file-source-editor")).toBeVisible();
    const explorerEditor = await explorerSidebar(page)
      .getByTestId("file-source-editor")
      .elementHandle();
    await text.fill(`${source}\n// retained Explorer edit`);
    await page.setViewportSize({ width: 390, height: 844 });
    await ensureExplorerSidebar(page);
    await page.setViewportSize({ width: 1280, height: 900 });
    expect(await explorerEditor!.evaluate((node) => node.isConnected)).toBe(true);
    await expect(text).toContainText("retained Explorer edit");
  } finally {
    await workspace.cleanup();
  }
});

test("retains populated Explorer chat and terminal attachments through appearance, hide and fold", async ({
  page,
}) => {
  const workspace = await seedMockAgentWorkspace({
    repoPrefix: "explorer-chat-appearance-",
    title: "Retained chat",
    initialPrompt: "Show the retention marker",
    featureValues: {
      mockAssistantResponse: "Explorer populated paragraph.\n\n```ts\nconst retained = 42;\n```",
    },
  });
  const attaches: string[] = [];
  page.on("websocket", (socket) =>
    socket.on("framesent", (frame) => {
      if (typeof frame.payload !== "string") return;
      try {
        const message = JSON.parse(frame.payload).message;
        if (message?.type === "subscribe_terminal_request") attaches.push(message.terminalId);
      } catch {
        /* Binary terminal traffic is not a JSON request. */
      }
    }),
  );
  try {
    await openAgentRoute(page, workspace);
    await ensureExplorerSidebar(page);
    await dragTabIntoExplorer(page, `agent_${workspace.agentId}`);
    const explorer = explorerSidebar(page);
    const paragraph = explorer.getByText("Explorer populated paragraph.", { exact: true });
    await expect(paragraph).toBeVisible();
    const composer = explorer.getByRole("textbox", { name: "Message agent..." });
    await composer.fill("Unsubmitted Explorer draft");
    const composerNode = await composer.elementHandle();
    await page.keyboard.press("Control+,");
    await openSettingsSection(page, "appearance");
    await page.getByLabel("Content font size", { exact: true }).fill("20");
    await page.getByLabel("Content font size", { exact: true }).press("Tab");
    await clickSettingsBackToWorkspace(page);
    await expect(paragraph).toHaveCSS("font-size", "20px");
    expect(await composerNode!.evaluate((node) => node.isConnected)).toBe(true);
    await expect(composer).toHaveValue("Unsubmitted Explorer draft");
    const previousColor = await paragraph.evaluate((node) => getComputedStyle(node).color);
    await cycleWorkspaceTheme(page);
    await expect
      .poll(() => paragraph.evaluate((node) => getComputedStyle(node).color))
      .not.toBe(previousColor);
    await explorer.getByRole("button", { name: "New tab", exact: true }).click();
    await page
      .getByRole("menuitem", { name: /^Terminal/ })
      .first()
      .click();
    const terminal = explorer.getByTestId("terminal-surface");
    await expect(terminal).toBeVisible();
    await expect.poll(() => attaches.length).toBe(1);
    const terminalNode = await terminal.elementHandle();
    await page.getByTestId("workspace-explorer-toggle").first().click();
    await ensureExplorerSidebar(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await ensureExplorerSidebar(page);
    await page.setViewportSize({ width: 1280, height: 900 });
    await cycleWorkspaceTheme(page);
    expect(await terminalNode!.evaluate((node) => node.isConnected)).toBe(true);
    expect(attaches).toHaveLength(1);
    await explorer.getByTestId(`workspace-tab-agent_${workspace.agentId}`).click();
    expect(await composerNode!.evaluate((node) => node.isConnected)).toBe(true);
    await expect(composer).toHaveValue("Unsubmitted Explorer draft");
    await expect(paragraph).toHaveCSS("font-size", "20px");
  } finally {
    await workspace.cleanup();
  }
});

test("compact file sheets cover Explorer and return to its retained file list", async ({
  page,
}) => {
  const workspace = await seedWorkspace({ repoPrefix: "explorer-sheet-layer-" });
  try {
    await writeFile(`${workspace.repoPath}/sheet-marker.txt`, "Explorer sheet marker\n");
    await gotoWorkspace(page, workspace.workspaceId);
    await page.setViewportSize({ width: 390, height: 844 });
    const explorer = await ensureExplorerSidebar(page);
    await openFilesPanel(page);
    const host = await explorer.elementHandle();
    await openFileFromExplorer(page, "sheet-marker.txt");
    await expect(page.getByText("Explorer sheet marker", { exact: true })).toBeVisible();
    // A real click also proves the sheet draws above the retained Explorer overlay.
    await page.getByRole("button", { name: "Close", exact: true }).click();
    await expect(page.getByText("Explorer sheet marker", { exact: true })).toHaveCount(0);
    await expect(explorer.getByTestId("file-explorer-tree-scroll")).toBeVisible();
    expect(await host!.evaluate((node) => node.isConnected)).toBe(true);
  } finally {
    await workspace.cleanup();
  }
});
