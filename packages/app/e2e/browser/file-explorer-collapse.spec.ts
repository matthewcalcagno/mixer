import { mkdir, rmdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "../support/fixtures";
import {
  collapseFolder,
  expandFolder,
  expectExplorerEntryHidden,
  expectExplorerEntryVisible,
  expectFileTabOpen,
  openFileExplorer,
  openFileFromExplorer,
} from "../support/helpers/file-explorer";
import { gotoWorkspace } from "../support/helpers/launcher";
import { seedWorkspace, type SeededWorkspace } from "../support/helpers/seed-client";
import { installDaemonWebSocketGate } from "../support/helpers/daemon-websocket-gate";

let workspace: SeededWorkspace;

test.beforeAll(async () => {
  workspace = await seedWorkspace({
    repoPrefix: "file-explorer-collapse-",
    repo: {
      files: [
        { path: "assets/logo.png", content: "image bytes for explorer e2e\n" },
        { path: "docs/guide.md", content: "# Guide\n" },
      ],
    },
  });
});

test.afterAll(async () => {
  await workspace?.cleanup();
});

test.describe("File explorer collapse", () => {
  test("keeps visible file selections stationary and reveals offscreen tab selections", async ({
    page,
    withWorkspace,
  }) => {
    const root = await withWorkspace({ prefix: "explorer-reveal-scroll-" });
    await Promise.all(
      Array.from({ length: 100 }, (_, index) =>
        writeFile(
          path.join(root.repoPath, `file-${String(index).padStart(3, "0")}.txt`),
          `File ${index}\n`,
        ),
      ),
    );
    await root.navigateTo();
    await openFileExplorer(page);
    const tree = page.getByTestId("file-explorer-tree-scroll");
    await expect(tree.getByText("file-030.txt", { exact: true })).toBeVisible();
    await tree.evaluate((element) => {
      element.scrollTop = 440;
    });
    await expect(tree).toHaveJSProperty("scrollTop", 440);
    await openFileFromExplorer(page, "file-030.txt");
    await expectFileTabOpen(page, "file-030.txt");
    await page.getByTestId("workspace-tab-file_file-030.txt").dblclick();
    await expect(tree).toHaveJSProperty("scrollTop", 440);
    await openFileFromExplorer(page, "file-035.txt");
    await expectFileTabOpen(page, "file-035.txt");
    await expect(tree).toHaveJSProperty("scrollTop", 440);
    await page.getByTestId("workspace-tab-file_file-030.txt").click();
    await expect(
      tree
        .getByText("file-030.txt", { exact: true })
        .locator("xpath=ancestor::*[@aria-selected][1]"),
    ).toHaveAttribute("aria-selected", "true");
    await expect(tree).toHaveJSProperty("scrollTop", 440);
    await page.getByTestId("workspace-tab-file_file-035.txt").click();
    await tree.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    await expect(tree.getByText("file-030.txt", { exact: true })).not.toBeInViewport();
    await page.getByTestId("workspace-tab-file_file-030.txt").click();
    await expect(tree.getByText("file-030.txt", { exact: true })).toBeInViewport({ ratio: 1 });
  });

  test("matches VS Code Explorer row height, type and indentation without changing muted labels", async ({
    page,
    withWorkspace,
  }) => {
    const visualWorkspace = await withWorkspace({ prefix: "explorer-visual-metrics-" });
    await mkdir(path.join(visualWorkspace.repoPath, "src", "components"), { recursive: true });
    await writeFile(
      path.join(visualWorkspace.repoPath, "src", "components", "example.tsx"),
      "export const example = true;\n",
    );
    await visualWorkspace.navigateTo();
    await openFileExplorer(page);
    const tree = page.getByTestId("file-explorer-tree-scroll");
    const src = tree.getByText("src", { exact: true });
    const rootRow = src.locator("xpath=ancestor::*[@aria-selected][1]");
    await expect(src).toHaveCSS("font-size", "13px");
    await expect(src).toHaveCSS("font-weight", "400");
    await expect(src).toHaveCSS("line-height", "18px");
    await expect(rootRow).toHaveCSS("height", "22px");
    await expect(rootRow).toHaveCSS("padding-left", "12px");
    await expandFolder(page, "src");
    const components = tree
      .getByText("components", { exact: true })
      .locator("xpath=ancestor::*[@aria-selected][1]");
    await expect(components).toHaveCSS("height", "22px");
    await expect(components).toHaveCSS("padding-left", "20px");
    await expandFolder(page, "components");
    const file = tree.getByText("example.tsx", { exact: true });
    await expect(file.locator("xpath=ancestor::*[@aria-selected][1]")).toHaveCSS(
      "padding-left",
      "28px",
    );
    const projectName = path.basename(visualWorkspace.repoPath);
    const projectLabel = page
      .locator('[data-testid^="sidebar-project-row-"]')
      .filter({ hasText: projectName })
      .first()
      .getByText(projectName, { exact: true });
    const muted = await projectLabel.evaluate((element) => getComputedStyle(element).color);
    await expect(file).toHaveCSS("color", muted);
    await page.mouse.move(900, 600);
    await page.screenshot({ path: test.info().outputPath("vscode-explorer-metrics.png") });
  });

  test("restores deep expansion and remembers children beneath a collapsed parent", async ({
    page,
    withWorkspace,
  }) => {
    test.setTimeout(90_000);
    const root = await withWorkspace({ prefix: "explorer-deep-restore-" });
    const names = Array.from({ length: 8 }, (_, index) => `level-${index + 1}`);
    const directory = path.join(root.repoPath, ...names);
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "deep.ts"), "export const deep = true;\n");
    const gate = await installDaemonWebSocketGate(page);
    await root.navigateTo();
    await openFileExplorer(page);
    for (const name of names) {
      await expectExplorerEntryVisible(page, name);
      await expandFolder(page, name);
    }
    await expectExplorerEntryVisible(page, "deep.ts");
    const reads = gate.getClientRequestCount("file_explorer_request");
    await collapseFolder(page, names[0]);
    await expectExplorerEntryHidden(page, "deep.ts");
    await expandFolder(page, names[0]);
    await expectExplorerEntryVisible(page, "deep.ts");
    expect(gate.getClientRequestCount("file_explorer_request")).toBe(reads);
    await page.reload();
    await openFileExplorer(page);
    await expectExplorerEntryVisible(page, "deep.ts");
    await collapseFolder(page, names[0]);
    await page.reload();
    await openFileExplorer(page);
    await expectExplorerEntryHidden(page, names[1]);
    await expandFolder(page, names[0]);
    await expectExplorerEntryVisible(page, "deep.ts");
  });

  test("a delayed folder read cannot undo a later collapse or duplicate the read", async ({
    page,
    withWorkspace,
  }) => {
    const root = await withWorkspace({ prefix: "explorer-pending-toggle-" });
    await mkdir(path.join(root.repoPath, "slow"));
    await mkdir(path.join(root.repoPath, "fast"));
    await writeFile(path.join(root.repoPath, "slow", "slow.ts"), "// slow\n");
    await writeFile(path.join(root.repoPath, "fast", "fast.ts"), "// fast\n");
    const gate = await installDaemonWebSocketGate(page);
    await root.navigateTo();
    await openFileExplorer(page);
    const tree = page.getByTestId("file-explorer-tree-scroll");
    const slow = tree
      .locator('[data-testid^="file-explorer-row-"][aria-selected]')
      .filter({ hasText: /^slow$/ });
    gate.holdNextClientRequest("file_explorer_request");
    await expandFolder(page, "slow");
    await gate.waitForHeldClientRequest();
    await expect(slow).toHaveAttribute("aria-expanded", "true");
    await expandFolder(page, "fast");
    await expectExplorerEntryVisible(page, "fast.ts");
    await expect(slow).toHaveAttribute("aria-busy", "true");
    const reads = gate.getClientRequestCount("file_explorer_request");
    await collapseFolder(page, "slow");
    await expandFolder(page, "slow");
    await collapseFolder(page, "slow");
    expect(gate.getClientRequestCount("file_explorer_request")).toBe(reads);
    gate.releaseHeldClientRequest();
    await expect(slow).toHaveAttribute("aria-busy", "false");
    await expect(slow).toHaveAttribute("aria-expanded", "false");
    await expectExplorerEntryHidden(page, "slow.ts");
    await expandFolder(page, "slow");
    await expectExplorerEntryVisible(page, "slow.ts");
    expect(gate.getClientRequestCount("file_explorer_request")).toBe(reads);
  });

  test("a failed folder read retains the tree and Retry keeps the folder open", async ({
    page,
    withWorkspace,
  }) => {
    const root = await withWorkspace({ prefix: "explorer-read-failure-" });
    const missing = path.join(root.repoPath, "missing");
    await mkdir(missing);
    await writeFile(path.join(root.repoPath, "safe.ts"), "// safe\n");
    const gate = await installDaemonWebSocketGate(page);
    await root.navigateTo();
    await openFileExplorer(page);
    const tree = page.getByTestId("file-explorer-tree-scroll");
    await tree.evaluate((element) => {
      element.dataset.retainedTree = "yes";
    });
    gate.holdNextClientRequest("file_explorer_request");
    await expandFolder(page, "missing");
    await gate.waitForHeldClientRequest();
    await rmdir(missing);
    gate.releaseHeldClientRequest();
    await expect(page.getByTestId("file-explorer-error")).toContainText("missing");
    await expect(tree).toHaveAttribute("data-retained-tree", "yes");
    await expectExplorerEntryVisible(page, "safe.ts");
    await mkdir(missing);
    await writeFile(path.join(missing, "recovered.ts"), "// recovered\n");
    await page.getByText("Retry", { exact: true }).click();
    await expectExplorerEntryVisible(page, "recovered.ts");
    await expect(tree).toHaveAttribute("data-retained-tree", "yes");
    await expect(page.getByTestId("file-explorer-error")).toHaveCount(0);
  });

  test("shows an icon-only Explorer rail without add or panel-toggle controls", async ({
    page,
    withWorkspace,
  }) => {
    const iconWorkspace = await withWorkspace({ prefix: "file-explorer-icons-" });
    await iconWorkspace.navigateTo();
    await openFileExplorer(page);
    const sidebar = page.getByTestId("workspace-explorer-sidebar");
    const rail = sidebar.getByTestId("workspace-tabs-row");
    const files = rail.getByTestId("workspace-tab-files");
    await expect(files).toBeVisible();
    await expect(files).toHaveAttribute("aria-label", "Browse workspace files");
    await expect(files).toHaveText("");
    await expect(rail.getByRole("button")).toHaveCount(2);
    const sourceControl = rail.getByRole("button").nth(1);
    await expect(sourceControl).toHaveText("");
    await sourceControl.click();
    await expect(sourceControl).toHaveAttribute("aria-selected", "true");
    await files.click();
    await expect(files).toHaveAttribute("aria-selected", "true");
    await expect(sidebar.getByTestId("workspace-new-tab-button")).toHaveCount(0);
    await expect(sidebar.getByTestId("workspace-explorer-toggle")).toHaveCount(0);
  });

  test("mutes ignored entries without hiding them or blocking navigation", async ({
    page,
    withWorkspace,
  }) => {
    const ignoredWorkspace = await withWorkspace({ prefix: "file-explorer-ignored-" });
    await writeFile(
      path.join(ignoredWorkspace.repoPath, ".gitignore"),
      "dist/\n*.log\n!keep.log\n",
    );
    await mkdir(path.join(ignoredWorkspace.repoPath, "dist"));
    await writeFile(path.join(ignoredWorkspace.repoPath, "dist", "bundle.js"), "// generated\n");
    await writeFile(path.join(ignoredWorkspace.repoPath, "debug.log"), "ignored\n");
    await writeFile(path.join(ignoredWorkspace.repoPath, "keep.log"), "not ignored\n");
    await ignoredWorkspace.navigateTo();
    await openFileExplorer(page);
    const explorer = page.getByTestId("file-explorer-tree-scroll");
    const ignored = explorer.getByText("debug.log", { exact: true });
    const normal = explorer.getByText("keep.log", { exact: true });
    await expect(ignored).toBeVisible();
    await expect(normal).toBeVisible();
    const projectName = path.basename(ignoredWorkspace.repoPath);
    const projectLabel = page
      .locator('[data-testid^="sidebar-project-row-"]')
      .filter({ hasText: projectName })
      .first()
      .getByText(projectName, { exact: true });
    const workspaceLabelColor = await projectLabel.evaluate((node) => getComputedStyle(node).color);
    await expect(normal).toHaveCSS("color", workspaceLabelColor);
    await expect(normal).toHaveCSS("opacity", "1");
    const ignoredColor = await ignored.evaluate((node) => getComputedStyle(node).color);
    expect(await normal.evaluate((node) => getComputedStyle(node).color)).not.toBe(ignoredColor);
    await ignored.hover();
    await expect(ignored).toHaveCSS("color", ignoredColor);
    await expect(explorer.getByText("dist", { exact: true })).toHaveCSS("color", ignoredColor);
    await expandFolder(page, "dist");
    await expect(explorer.getByText("bundle.js", { exact: true })).toHaveCSS("color", ignoredColor);
    await openFileFromExplorer(page, "debug.log");
    await expectFileTabOpen(page, "debug.log");
  });

  test("collapses an opened image file parent folder and still expands other folders", async ({
    page,
  }) => {
    await gotoWorkspace(page, workspace.workspaceId);
    await openFileExplorer(page);

    await expandFolder(page, "assets");
    await expectExplorerEntryVisible(page, "logo.png");

    await openFileFromExplorer(page, "logo.png");
    await expectFileTabOpen(page, "assets/logo.png");

    await collapseFolder(page, "assets");
    await expectExplorerEntryHidden(page, "logo.png");

    await expandFolder(page, "docs");
    await expectExplorerEntryVisible(page, "guide.md");
  });
});
