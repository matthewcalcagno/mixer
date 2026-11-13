import { existsSync } from "node:fs";
import overviewCorpus from "../../../protocol/tests/fixtures/plugin-overview.json";
import { pluginRequirements } from "../support/helpers/plugin-fixture";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { TestInfo } from "@playwright/test";
import { buildOpenProjectRoute } from "@/utils/host-routes";
import { expect, test as base, type Page } from "../support/fixtures";
import { gotoAppShell, openSettings } from "../support/helpers/app";
import { daemonWsRoutePattern } from "../support/helpers/daemon-port";
import { getServerId } from "../support/helpers/server-id";
import { connectNewWorkspaceDaemonClient } from "../support/helpers/new-workspace";
import { waitForSettledPosition } from "../support/helpers/sheet-layout";
import {
  expectSettingsHeader,
  openCompactSettings,
  openHostSection,
  openSettingsHost,
} from "../support/helpers/settings";

import {
  startNpmRegistry,
  npmPluginPackages,
} from "../../../../scripts/test-support/npm-registry.mjs";

interface PluginEnvironment {
  client: Awaited<ReturnType<typeof connectNewWorkspaceDaemonClient>>;
  directory: string;
}

async function sourceEditorModifier(page: Page, monaco: boolean) {
  // The desktop browser fixture has a Windows UA on macOS. Monaco reads the UA;
  // CodeMirror reads navigator.platform, so the two engines disagree in this fixture.
  return page.evaluate((desktop) => {
    const mac = desktop
      ? /Macintosh|Mac OS X/.test(navigator.userAgent)
      : /Mac/.test(navigator.platform);
    return mac ? "Meta" : "Control";
  }, monaco);
}

async function expectNoAutomationSettings(page: Page) {
  await openSettings(page);
  await expect(
    page.getByTestId("settings-host-section-plugins").filter({ visible: true }),
  ).toBeVisible();
  await expect(page.getByTestId("settings-host-section-automations")).toHaveCount(0);
  await expect(page.getByTestId("automations-preferences")).toHaveCount(0);
}

async function configureAutomationAssistant(page: Page, provider: string) {
  const screen = page.getByTestId("automations-screen").filter({ visible: true });
  await screen.getByRole("button", { name: "Automations configuration", exact: true }).click();
  await screen.getByRole("textbox", { name: "Source for config.json", exact: true }).fill(
    JSON.stringify(
      {
        runtime: { shutdownTimeout: 100 },
        extensions: {
          github: { enabled: false },
          jira: { enabled: false },
          scheduler: { enabled: false },
          webhooks: { enabled: false },
          mixer: { agentProvider: provider },
        },
      },
      null,
      2,
    ),
  );
  await screen.getByRole("button", { name: "Save configuration", exact: true }).click();
  await expect(screen.getByText("Workflow saved.", { exact: true })).toBeVisible();
}

base.beforeEach(async ({ e2eWorkerClient }, testInfo) => {
  if (!testInfo.title.includes("Automations")) return;
  const home = process.env.E2E_MIXER_HOME;
  if (!home) throw new Error("Missing isolated daemon home");
  await mkdir(path.join(home, "automations"), { recursive: true });
  await writeFile(
    path.join(home, "automations", "config.json"),
    JSON.stringify({
      runtime: { shutdownTimeout: 100 },
      extensions: {
        scheduler: {},
        github: { enabled: false },
        jira: { enabled: false },
        webhooks: { enabled: false },
        mixer: { agentProvider: "mock" },
      },
    }),
  );
  await e2eWorkerClient.invokePluginRpc("automations", "automations.runtime.control", {
    action: "restart",
  });
});

base(
  "Automations Ask AI submits its first draft using live host defaults",
  async ({ page, e2eWorkerClient }) => {
    await page.addInitScript(() => {
      localStorage.setItem(
        "@mixer:create-agent-preferences",
        JSON.stringify({
          provider: "mock",
          providerPreferences: { mock: { model: "ten-second-stream" } },
        }),
      );
    });
    const before = new Set(
      (await e2eWorkerClient.fetchAgents({ scope: "active" })).entries.map(({ agent }) => agent.id),
    );
    await gotoAppShell(page);
    await page.getByRole("button", { name: "Automations", exact: true }).click();
    const screen = page.getByTestId("automations-screen").filter({ visible: true });
    await screen.getByRole("button", { name: "Ask Automations AI", exact: true }).click();
    const assistant = screen.getByTestId("automations-assistant");
    const message = assistant.getByRole("textbox", { name: "Message agent...", exact: true });
    await expect(message).toBeVisible();
    await expect(
      assistant.getByRole("button", { name: "Select model (Ten second stream)", exact: true }),
    ).toBeVisible();
    await message.fill("AUTOMATIONS_COMPOSER_DEFAULTS_OK");
    await assistant.getByRole("button", { name: "Minimize AI", exact: true }).click();
    await screen.getByRole("button", { name: "Ask Automations AI", exact: true }).click();
    await expect(message).toHaveValue("AUTOMATIONS_COMPOSER_DEFAULTS_OK");
    await message.press("Enter");
    const home = process.env.E2E_MIXER_HOME;
    if (!home) throw new Error("Missing isolated daemon home");
    const cwd = await realpath(path.join(home, "automations"));
    await expect
      .poll(async () => {
        const { entries } = await e2eWorkerClient.fetchAgents({ scope: "active" });
        return entries
          .filter(({ agent }) => !before.has(agent.id))
          .map(({ agent }) => ({ provider: agent.provider, cwd: agent.cwd }));
      })
      .toEqual([{ provider: "mock", cwd }]);
    await expect(
      assistant.getByText("Model defaults are still loading", { exact: true }),
    ).toHaveCount(0);
    await expect(assistant.getByText("Workspace directory not found", { exact: true })).toHaveCount(
      0,
    );
    await expect(page).toHaveURL(/\/plugin\/automations\//);
  },
);

base(
  "Automations keeps Runs first and moves workflow files between folders and root",
  async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await gotoAppShell(page);
    await page.getByRole("button", { name: "Automations", exact: true }).click();
    const screen = page.getByTestId("automations-screen").filter({ visible: true });
    await expect(screen.getByRole("button", { name: "Workflows", exact: true })).toHaveCount(0);
    await expect(screen.getByRole("button", { name: "Integrations", exact: true })).toHaveCount(0);
    await expect(screen.getByRole("button", { name: "Diagnostics", exact: true })).toHaveCount(0);
    const runs = screen.getByRole("button", { name: "Runs", exact: true });
    await expect(runs).toBeVisible();
    const configuration = screen.getByRole("button", {
      name: "Automations configuration",
      exact: true,
    });
    await configuration.click();
    await expect(
      screen.getByRole("textbox", { name: "Source for config.json", exact: true }),
    ).toBeVisible();
    await expect(
      screen
        .getByTestId("automations-workflow-tree-pane")
        .getByRole("button", { name: "Open config.json", exact: true }),
    ).toHaveCount(0);
    await configuration.click();
    await expect(screen.getByRole("button", { name: "Edit config.json", exact: true })).toHaveCount(
      1,
    );
    await screen.getByRole("button", { name: "Close config.json", exact: true }).click();
    await expect(screen.getByTestId("automations-runs-table")).toBeVisible();
    await expect(screen.getByRole("button", { name: "Close runs", exact: true })).toHaveCount(0);
    await screen.getByRole("button", { name: "New folder", exact: true }).click();
    await screen.getByRole("textbox", { name: "Folder name", exact: true }).fill("moving");
    await screen.getByRole("textbox", { name: "Folder name", exact: true }).press("Enter");
    const folder = screen.getByRole("button", { name: "Folder moving", exact: true });
    await expect(folder).toBeVisible();
    const background = screen.getByTestId("automations-files-background");
    await background.click({ button: "right", position: { x: 30, y: 380 } });
    await page.getByRole("menuitem", { name: "New file", exact: true }).click();
    const filename = screen.getByRole("textbox", { name: "Workflow filename", exact: true });
    await filename.fill("move-me.yaml");
    await filename.press("Enter");
    const root = screen.getByRole("button", { name: "Open move-me.yaml", exact: true });
    await expect(root).toBeVisible();
    const tab = screen.getByRole("button", { name: "Edit move-me.yaml", exact: true });
    const runsBounds = await runs.boundingBox();
    const tabBounds = await tab.boundingBox();
    if (!runsBounds || !tabBounds) throw new Error("Missing shared tabs");
    expect(tabBounds.x).toBeGreaterThan(runsBounds.x);
    expect(Math.abs(tabBounds.y - runsBounds.y)).toBeLessThan(3);
    await root.dragTo(folder);
    const nested = screen.getByRole("button", { name: "Open moving/move-me.yaml", exact: true });
    await expect(nested).toBeVisible();
    await expect(root).toHaveCount(0);
    await expect(
      screen.getByRole("button", { name: "Edit moving/move-me.yaml", exact: true }),
    ).toBeVisible();
    await expect(
      screen.getByRole("textbox", { name: "Source for moving/move-me.yaml", exact: true }),
    ).toContainText('name: "move-me"');
    await nested.dragTo(background, { targetPosition: { x: 30, y: 380 } });
    await expect(root).toBeVisible();
    await expect(nested).toHaveCount(0);
    await folder.click({ button: "right" });
    await page.getByRole("menuitem", { name: "New file", exact: true }).click();
    await filename.fill("move-me.yaml");
    await filename.press("Enter");
    await expect(nested).toBeVisible();
    await root.dragTo(folder);
    await expect(page.getByText(/already exists at moving\/move-me.yaml/).first()).toBeVisible();
    await expect(root).toBeVisible();
    await expect(nested).toBeVisible();
    await screen.getByRole("button", { name: "Close moving/move-me.yaml", exact: true }).click();
    await runs.click();
    await expect(screen.getByTestId("automations-runs-table")).toBeVisible();
    await tab.click();
    const source = screen.getByRole("textbox", { name: "Source for move-me.yaml", exact: true });
    await expect(source).toBeVisible();
    await source.fill("on: {}\nsteps:\n  - run: echo moved\n");
    await expect(root.locator("xpath=ancestor::div[@draggable][1]")).toHaveAttribute(
      "draggable",
      "false",
    );
    await screen.getByRole("button", { name: "Save workflow", exact: true }).click();
    await expect(screen.getByText("Workflow saved.", { exact: true })).toBeVisible();
    await screen.getByRole("button", { name: "Close move-me.yaml", exact: true }).click();
    await expect(screen.getByTestId("automations-runs-table")).toBeVisible();
    await expect(runs).toBeVisible();
    await screen.screenshot({ path: testInfo.outputPath("automations-pinned-runs.png") });
  },
);

base(
  "Automations supports root and folder context creation with a compact floating agent conversation",
  async ({ page, e2eWorkerClient }, testInfo) => {
    const before = new Set(
      (await e2eWorkerClient.fetchWorkspaces()).entries.map((item) => item.projectId),
    );
    try {
      await page.setViewportSize({ width: 1440, height: 1000 });
      await page.emulateMedia({ colorScheme: "dark" });
      await gotoAppShell(page);
      await page.getByRole("button", { name: "Automations", exact: true }).click();
      const screen = page.getByTestId("automations-screen").filter({ visible: true });
      const background = screen.getByTestId("automations-files-background");
      await expect(
        screen.getByRole("button", { name: "Folder automations", exact: true }),
      ).toHaveCount(0);
      await background.click({ button: "right", position: { x: 30, y: 180 } });
      await page.getByRole("menuitem", { name: "New folder", exact: true }).click();
      const folderName = screen.getByRole("textbox", { name: "Folder name", exact: true });
      await expect(folderName).toBeFocused();
      await folderName.fill("issues");
      await folderName.press("Enter");
      const issues = screen.getByRole("button", { name: "Folder issues", exact: true });
      await expect(issues).toBeVisible();
      await issues.click({ button: "right" });
      await page.getByRole("menuitem", { name: "New file", exact: true }).click();
      const filename = screen.getByRole("textbox", { name: "Workflow filename", exact: true });
      await expect(filename).toBeFocused();
      await expect(filename).toHaveAttribute("placeholder", "File name");
      await expect(screen.getByRole("button", { name: "Create file", exact: true })).toHaveCount(0);
      const parentBounds = await issues.boundingBox();
      const inputBounds = await filename.boundingBox();
      if (!parentBounds || !inputBounds) throw new Error("Missing inline creation row");
      expect(inputBounds.y).toBeGreaterThan(parentBounds.y);
      expect(inputBounds.y - parentBounds.y).toBeLessThan(35);
      await screen.screenshot({ path: testInfo.outputPath("automations-inline-file.png") });
      await filename.fill("triage");
      await filename.press("Enter");
      await expect(
        screen.getByRole("button", { name: "Open issues/triage.yaml", exact: true }),
      ).toBeVisible();
      await expect(
        screen.getByRole("textbox", { name: "Source for issues/triage.yaml", exact: true }),
      ).toBeVisible();
      await issues.click({ button: "right" });
      await page.getByRole("menuitem", { name: "New folder", exact: true }).click();
      await folderName.fill("backlog");
      await folderName.press("Enter");
      await expect(
        screen.getByRole("button", { name: "Folder issues/backlog", exact: true }),
      ).toBeVisible();
      await background.click({ button: "right", position: { x: 30, y: 260 } });
      await page.getByRole("menuitem", { name: "New file", exact: true }).click();
      await filename.fill("root.yaml");
      await filename.press("Enter");
      await expect(
        screen.getByRole("button", { name: "Open root.yaml", exact: true }),
      ).toBeVisible();
      await screen
        .getByRole("button", { name: "Open issues/triage.yaml", exact: true })
        .click({ button: "right" });
      await page.getByRole("menuitem", { name: "New file", exact: true }).click();
      await filename.fill("follow-up");
      await filename.press("Enter");
      await expect(
        screen.getByRole("button", { name: "Open issues/follow-up.yaml", exact: true }),
      ).toBeVisible();
      await screen.getByRole("textbox", { name: "Filter workflows", exact: true }).fill("no-match");
      await background.click({ button: "right", position: { x: 30, y: 180 } });
      await page.getByRole("menuitem", { name: "New folder", exact: true }).click();
      await expect(
        screen.getByRole("textbox", { name: "Filter workflows", exact: true }),
      ).toHaveValue("");
      await folderName.fill("issues");
      await folderName.press("Enter");
      await expect(screen.getByRole("alert")).toContainText("already exists");
      await folderName.press("Escape");
      await expect(page.getByRole("dialog")).toHaveCount(0);
      const fileRowBounds = await screen
        .getByRole("button", { name: "Open root.yaml", exact: true })
        .boundingBox();
      const filterBounds = await screen
        .getByRole("textbox", { name: "Filter workflows", exact: true })
        .boundingBox();
      if (!fileRowBounds || !filterBounds) throw new Error("Missing compact tree geometry");
      expect(fileRowBounds.height).toBeLessThanOrEqual(22);
      expect(filterBounds.height).toBeLessThanOrEqual(20);
      const workspaceBounds = await screen.getByTestId("automations-workflows").boundingBox();
      const sourceBounds = await screen
        .getByRole("textbox", { name: "Source for issues/follow-up.yaml", exact: true })
        .boundingBox();
      if (!workspaceBounds || !sourceBounds) throw new Error("Missing workflow editor bounds");
      expect(sourceBounds.y - workspaceBounds.y).toBeLessThan(110);
      await screen.screenshot({ path: testInfo.outputPath("automations-context-tree.png") });
      await expectNoAutomationSettings(page);
      await leavePluginSettings(page);
      await page.getByRole("button", { name: "Automations", exact: true }).click();
      await configureAutomationAssistant(page, "mock");
      await screen.getByRole("button", { name: "Open issues/follow-up.yaml", exact: true }).click();
      const editorBefore = await screen.getByTestId("automations-workflows").boundingBox();
      const launcher = screen.getByRole("button", { name: "Ask Automations AI", exact: true });
      const launchBounds = await launcher.boundingBox();
      if (!launchBounds || !editorBefore) throw new Error("Missing workspace bounds");
      expect(launchBounds.height).toBeLessThanOrEqual(40);
      await launcher.click();
      const assistant = screen.getByTestId("automations-assistant");
      const message = assistant.getByRole("textbox", { name: "Message agent...", exact: true });
      await expect(message).toBeVisible();
      const editorAfter = await screen.getByTestId("automations-workflows").boundingBox();
      expect(editorAfter?.height).toBe(editorBefore.height);
      await message.fill("Keep this draft");
      await assistant.getByRole("button", { name: "Minimize AI", exact: true }).click();
      await expect(assistant).not.toBeVisible();
      await launcher.click();
      await expect(message).toHaveValue("Keep this draft");
      await expect(message).toBeFocused();
      await screen.getByRole("button", { name: "Open root.yaml", exact: true }).click();
      await expect(
        assistant
          .getByTestId("composer-attachment-tray")
          .getByRole("button", { name: "root.yaml", exact: true }),
      ).toBeVisible();
      await page.evaluate(async () => {
        await new Promise<number>(requestAnimationFrame);
        await new Promise<number>(requestAnimationFrame);
      });
      await expect(message).not.toBeFocused();
      await expect(page).toHaveURL(/\/plugin\/automations\//);
      await screen.screenshot({ path: testInfo.outputPath("automations-floating-agent.png") });
      await assistant.getByRole("button", { name: "Minimize AI", exact: true }).click();
      await configureAutomationAssistant(page, "");
    } finally {
      const projects = (await e2eWorkerClient.fetchWorkspaces()).entries.map(
        (item) => item.projectId,
      );
      for (const id of new Set(projects))
        if (!before.has(id)) await e2eWorkerClient.removeProject(id);
    }
  },
);

base(
  "built-in Automations creates, edits, validates, enables, runs, and deletes workflows inline",
  async ({ page, e2eWorkerClient }, testInfo) => {
    const before = new Set(
      (await e2eWorkerClient.fetchWorkspaces()).entries.map((item) => item.projectId),
    );
    page.on("dialog", (dialog) => void dialog.accept());
    try {
      await page.setViewportSize({ width: 1440, height: 1000 });
      await gotoAppShell(page);
      await page.getByRole("button", { name: "Automations", exact: true }).click();
      const screen = page.getByTestId("automations-screen").filter({ visible: true });
      await screen.getByRole("button", { name: "New file", exact: true }).click();
      await screen
        .getByRole("textbox", { name: "Workflow filename", exact: true })
        .fill("shared/inline-build.yaml");
      await screen.getByRole("textbox", { name: "Workflow filename", exact: true }).press("Enter");
      await expect(page.getByRole("dialog")).toHaveCount(0);
      const desktop = process.env.E2E_DESKTOP_RUNTIME === "1";
      const modifier = await sourceEditorModifier(page, desktop);
      const editor = desktop
        ? screen.getByTestId("plugin-source-editor").frameLocator("iframe").locator(".view-lines")
        : screen.getByRole("textbox", { name: "Source for shared/inline-build.yaml", exact: true });
      const replace = async (value: string) => {
        await editor.click();
        await page.keyboard.press(`${modifier}+a`);
        await page.keyboard.insertText(value);
      };
      await expect(editor).toContainText("disabled: true");
      await expect(screen.getByRole("button", { name: "Run", exact: true })).toBeDisabled();
      await replace("steps: broken\n");
      await screen.getByRole("button", { name: "Runs", exact: true }).click();
      await expect(screen.getByTestId("automations-sidebar")).toBeVisible();
      await screen
        .getByRole("button", { name: "Open shared/inline-build.yaml", exact: true })
        .click();
      await expect(editor).toContainText("steps: broken");
      await screen.getByRole("button", { name: "Ask Automations AI", exact: true }).click();
      await expect(screen.getByTestId("automations-assistant")).toBeVisible();
      await expect(
        screen.getByText("Save your draft before asking AI to change files.", { exact: true }),
      ).toBeVisible();
      await screen.getByRole("button", { name: "Minimize AI", exact: true }).click();
      await screen.getByRole("button", { name: "Save workflow", exact: true }).click();
      await expect(screen.getByRole("alert")).toContainText("steps");
      await expect(editor).toContainText("steps: broken");
      await replace(
        "name: Inline build\ndisabled: true\non: {}\nsteps:\n  - run: echo INLINE_AUTOMATION_SUCCESS\n",
      );
      await editor.click();
      await page.keyboard.press(`${modifier}+s`);
      await expect(screen.getByText("Workflow saved.", { exact: true })).toBeVisible();
      await expect(screen.getByRole("alert")).toHaveCount(0);
      const home = process.env.E2E_MIXER_HOME;
      if (!home) throw new Error("Missing isolated daemon home");
      await writeFile(
        path.join(home, "automations", "shared", "inline-build.yaml"),
        "# Changed externally\nname: Inline build\ndisabled: true\non: {}\nsteps:\n  - run: echo INLINE_AUTOMATION_SUCCESS\n",
      );
      await replace("name: Stale edit\non: {}\nsteps:\n  - run: echo stale\n");
      await screen.getByRole("button", { name: "Save workflow", exact: true }).click();
      await expect(screen.getByRole("alert").filter({ hasText: "changed on disk" })).toBeVisible();
      await expect(editor).toContainText("Stale edit");
      await screen.getByRole("button", { name: "Workflow actions", exact: true }).click();
      await page.getByRole("menuitem", { name: "Reload from disk", exact: true }).click();
      await expect(editor).toContainText("Changed externally");
      await expect(screen.getByRole("alert")).toHaveCount(0);
      await screen.screenshot({ path: testInfo.outputPath("automations-workflows.png") });
      await screen.getByRole("button", { name: "Disabled", exact: true }).click();
      await expect(screen.getByRole("button", { name: "Enabled", exact: true })).toBeEnabled();
      await screen.getByRole("button", { name: "Run", exact: true }).click();
      await expect(
        screen
          .getByTestId("automations-run-inspector")
          .getByText("scripted_steps_completed", { exact: true }),
      ).toBeVisible();
      await expect(screen.getByRole("button", { name: "Overview", exact: true })).toBeVisible();
      await screen
        .getByTestId("automations-run-inspector")
        .screenshot({ path: testInfo.outputPath("automations-run-overview.png") });
      await screen.getByRole("button", { name: "Details", exact: true }).click();
      await expect(
        screen.getByRole("button", { name: "Open current workflow", exact: true }),
      ).toBeVisible();
      await screen
        .getByTestId("automations-run-inspector")
        .screenshot({ path: testInfo.outputPath("automations-run-details.png") });
      await screen.getByRole("button", { name: "Logs", exact: true }).click();
      await expect(screen.getByRole("textbox", { name: "Run output", exact: true })).toContainText(
        "INLINE_AUTOMATION_SUCCESS",
      );
      await screen.getByRole("button", { name: "Back to runs", exact: true }).click();
      await expect(
        screen
          .getByTestId("automations-runs-table")
          .getByText("shared/inline-build.yaml", { exact: true }),
      ).toBeVisible();
      await screen.screenshot({ path: testInfo.outputPath("automations-runs.png") });
      await screen
        .getByRole("button", { name: "Open shared/inline-build.yaml", exact: true })
        .click();
      await expect(editor).toContainText("INLINE_AUTOMATION_SUCCESS");
      await screen.getByRole("button", { name: "Enabled", exact: true }).click();
      await expect(screen.getByRole("button", { name: "Run", exact: true })).toBeDisabled();
      await screen.getByRole("button", { name: "Workflow actions", exact: true }).click();
      await page.getByRole("menuitem", { name: "Delete workflow", exact: true }).click();
      await expect(
        screen.getByRole("button", { name: "Open shared/inline-build.yaml", exact: true }),
      ).toHaveCount(0);
      await expect(
        screen.getByRole("button", { name: "Folder shared", exact: true }),
      ).toBeVisible();
    } finally {
      const projects = (await e2eWorkerClient.fetchWorkspaces()).entries.map(
        (item) => item.projectId,
      );
      for (const id of new Set(projects))
        if (!before.has(id)) await e2eWorkerClient.removeProject(id);
    }
  },
);

base(
  "Automations source editor saves with the keyboard and retains drafts across file and section changes",
  async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await gotoAppShell(page);
    await page.getByRole("button", { name: "Automations", exact: true }).click();
    const screen = page.getByTestId("automations-screen").filter({ visible: true });
    await screen.getByRole("button", { name: "New file", exact: true }).click();
    await screen
      .getByRole("textbox", { name: "Workflow filename", exact: true })
      .fill("shared/checks/keyboard.yaml");
    await screen.getByRole("textbox", { name: "Workflow filename", exact: true }).press("Enter");
    const desktop = process.env.E2E_DESKTOP_RUNTIME === "1";
    const source = desktop
      ? screen
          .getByTestId("plugin-source-editor")
          .filter({ visible: true })
          .frameLocator("iframe")
          .locator(".view-lines")
      : screen.getByRole("textbox", {
          name: "Source for shared/checks/keyboard.yaml",
          exact: true,
        });
    await expect(source).toContainText("disabled: true");
    const modifier = await sourceEditorModifier(page, desktop);
    await source.click();
    await page.keyboard.press(`${modifier}+a`);
    await page.keyboard.insertText(
      "name: Keyboard workflow\non: {}\nsteps:\n  - run: echo MONACO_KEYBOARD_SAVED\n",
    );
    await screen.getByRole("button", { name: "New file", exact: true }).click();
    await screen.getByRole("textbox", { name: "Workflow filename", exact: true }).fill("triage.md");
    await screen.getByRole("textbox", { name: "Workflow filename", exact: true }).press("Enter");
    await screen
      .getByRole("button", { name: "Open shared/checks/keyboard.yaml", exact: true })
      .click();
    await expect(source).toContainText("MONACO_KEYBOARD_SAVED");
    await screen.getByRole("button", { name: "Runs", exact: true }).click();
    await screen
      .getByRole("button", { name: "Open shared/checks/keyboard.yaml", exact: true })
      .click();
    await expect(source).toContainText("MONACO_KEYBOARD_SAVED");
    await source.click();
    await page.keyboard.press(`${modifier}+s`);
    await expect(screen.getByText("Workflow saved.", { exact: true })).toBeVisible();
    await expect(
      screen.getByRole("button", { name: "Run", exact: true }).filter({ visible: true }),
    ).toBeEnabled();
    await screen.screenshot({ path: testInfo.outputPath("automations-source-workspace.png") });
    await screen
      .getByRole("button", { name: "Run", exact: true })
      .filter({ visible: true })
      .click();
    await expect(
      screen
        .getByTestId("automations-run-inspector")
        .getByText("scripted_steps_completed", { exact: true }),
    ).toBeVisible();
    await screen.getByRole("button", { name: "Ask Automations AI", exact: true }).click();
    await expect(screen.getByTestId("automations-assistant")).toBeVisible();
    await screen.screenshot({ path: testInfo.outputPath("automations-assistant.png") });
  },
);

base(
  "Automations AI sends to a Mixer agent and exposes provider failures without leaving the workspace",
  async ({ page, e2eWorkerClient }) => {
    const before = new Set(
      (await e2eWorkerClient.fetchWorkspaces()).entries.map((item) => item.projectId),
    );
    try {
      await gotoAppShell(page);
      await page.getByRole("button", { name: "Automations", exact: true }).click();
      const screen = page.getByTestId("automations-screen").filter({ visible: true });
      await configureAutomationAssistant(page, "mock");
      await screen.getByRole("button", { name: "Ask Automations AI", exact: true }).click();
      const assistant = screen.getByTestId("automations-assistant");
      const input = assistant.getByRole("textbox", { name: "Message agent...", exact: true });
      await input.fill("emit a synthetic turn failure");
      await input.press("Enter");
      await expect(
        assistant.getByText("Requested mock provider failure", { exact: false }).first(),
      ).toBeVisible();
      await expect(screen.getByTestId("automations-sidebar")).toBeVisible();
      await input.fill(
        "Generate a title and a git branch name for a coding agent. Return JSON only with fields 'title' and 'branch'.\n<user-prompt>\nAutomation assistant check\n</user-prompt>",
      );
      await input.press("Enter");
      await expect(
        assistant.getByText(
          '{"title":"Automation assistant check","branch":"automation-assistant-check"}',
          { exact: true },
        ),
      ).toBeVisible();
      await assistant.getByRole("button", { name: "Open full conversation", exact: true }).click();
      const full = screen.getByTestId("automations-agent-tab").filter({ visible: true });
      await expect(full).toBeVisible();
      await expect(
        full.getByText(
          '{"title":"Automation assistant check","branch":"automation-assistant-check"}',
          { exact: true },
        ),
      ).toBeVisible();
      await expect(page).toHaveURL(/\/plugin\/automations\//);
      await expect(assistant).not.toBeVisible();
      const home = process.env.E2E_MIXER_HOME;
      if (!home) throw new Error("Missing isolated daemon home");
      expect(
        (await e2eWorkerClient.listProjects()).projects.filter(
          (project) => project.projectRootPath === path.join(home, "automations"),
        ),
      ).toEqual([]);
      expect(
        (
          await e2eWorkerClient.fetchWorkspaces({ filter: { includeBackground: true } })
        ).entries.filter(
          (workspace) => workspace.projectRootPath === path.join(home, "automations"),
        ),
      ).toEqual([]);
      await screen.getByRole("button", { name: "Runs", exact: true }).click();
      await expect(screen.getByTestId("automations-runs-table")).toBeVisible();
      await screen.getByRole("button", { name: /^Agent / }).click();
      await expect(full).toBeVisible();
    } finally {
      const projects = (await e2eWorkerClient.fetchWorkspaces()).entries.map(
        (item) => item.projectId,
      );
      for (const id of new Set(projects))
        if (!before.has(id)) await e2eWorkerClient.removeProject(id);
    }
  },
);

base(
  "Automations edits config.json in the workspace and passes configured values to a workflow",
  async ({ page }, testInfo) => {
    const home = process.env.E2E_MIXER_HOME;
    if (!home) throw new Error("Missing isolated daemon home");
    try {
      await page.setViewportSize({ width: 1440, height: 1000 });
      await page.emulateMedia({ colorScheme: "dark" });
      await gotoAppShell(page);
      await page.getByRole("button", { name: "Automations", exact: true }).click();
      const screen = page.getByTestId("automations-screen").filter({ visible: true });
      await expect(
        screen
          .getByTestId("automations-workflow-tree-pane")
          .getByRole("button", { name: "Open config.json", exact: true }),
      ).toHaveCount(0);
      await screen.getByRole("button", { name: "Automations configuration", exact: true }).click();
      const configEditor = screen.getByRole("textbox", {
        name: "Source for config.json",
        exact: true,
      });
      await expect(screen.getByText("Automations configuration", { exact: true })).toHaveCount(0);
      await configEditor.fill(
        JSON.stringify(
          {
            runtime: { concurrency: 1, timeout: 5000, shutdownTimeout: 100 },
            history: { retention: "7d" },
            extensions: {
              github: { enabled: false },
              jira: { enabled: false },
              webhooks: { enabled: false },
              scheduler: { enabled: false },
              steps: { env: { GLOBAL_VALUE: "FROM_CONFIG_JSON" } },
              mixer: { agentProvider: "mock" },
            },
          },
          null,
          2,
        ),
      );
      await expect(configEditor).toContainText('"GLOBAL_VALUE": "FROM_CONFIG_JSON"');
      await expect(
        screen.getByRole("button", { name: "Add setup fields", exact: true }),
      ).toHaveCount(0);
      await screen.screenshot({ path: testInfo.outputPath("automations-config-editor.png") });
      await expect(screen.getByRole("button", { name: "Run", exact: true })).toHaveCount(0);
      await screen.getByRole("button", { name: "Save configuration", exact: true }).click();
      await expect(screen.getByText("Workflow saved.", { exact: true })).toBeVisible();
      await screen.getByRole("button", { name: "Restart", exact: true }).click();
      await expectNoAutomationSettings(page);
      await leavePluginSettings(page);
      await page.getByRole("button", { name: "Automations", exact: true }).click();
      await screen.getByRole("button", { name: "New file", exact: true }).click();
      await screen
        .getByRole("textbox", { name: "Workflow filename", exact: true })
        .fill("configuration-values.yaml");
      await screen.getByRole("textbox", { name: "Workflow filename", exact: true }).press("Enter");
      const source = screen.getByRole("textbox", {
        name: "Source for configuration-values.yaml",
        exact: true,
      });
      await source.fill('on: {}\nsteps:\n  - run: printf "%s" "$GLOBAL_VALUE"\n');
      await screen.getByRole("button", { name: "Save workflow", exact: true }).click();
      await expect(screen.getByRole("button", { name: "Run", exact: true })).toBeEnabled();
      await screen.getByRole("button", { name: "Run", exact: true }).click();
      await expect(screen.getByTestId("automations-run-inspector")).toBeVisible();
      await screen.getByRole("button", { name: "Logs", exact: true }).click();
      await expect(screen.getByRole("textbox", { name: "Run output", exact: true })).toContainText(
        "FROM_CONFIG_JSON",
      );
      await screen.getByRole("button", { name: "Automations configuration", exact: true }).click();
      await configEditor.fill('{"runtime":{"concurency":2}}');
      await configEditor.press(`${await sourceEditorModifier(page, false)}+s`);
      await expect(screen.getByRole("alert")).toContainText("concurency");
      await expect(configEditor).toContainText("concurency");
    } finally {
      await rm(path.join(home, "automations", "config.json"), { force: true });
      await rm(path.join(home, "automations", "configuration-values.yaml"), { force: true });
    }
  },
);

const test = base.extend<
  { pluginEnvironment: PluginEnvironment },
  { npmRegistry: Awaited<ReturnType<typeof startNpmRegistry>> }
>({
  pluginEnvironment: async ({ e2eWorker: _e2eWorker }, provide) => {
    const directory = await mkdtemp(path.join(tmpdir(), "mixer-plugins-e2e-"));
    const client = await connectNewWorkspaceDaemonClient({ ownProjects: false });
    const previous = await client.getDaemonConfig();
    try {
      await provide({ client, directory });
    } finally {
      try {
        const current = await client.getDaemonConfig();
        const existingIds = new Set(Object.keys(previous.config.plugins ?? {}));
        for (const id of Object.keys(current.config.plugins ?? {})) {
          if (!existingIds.has(id)) await client.removePlugin(id);
        }
      } finally {
        try {
          await client.patchDaemonConfig({
            pluginsEnabled: previous.config.pluginsEnabled ?? false,
          });
        } finally {
          try {
            await client.close();
          } finally {
            await rm(directory, { recursive: true, force: true });
          }
        }
      }
    }
  },
  npmRegistry: [
    async ({ browserName: _browserName }, provide) => {
      const registry = await startNpmRegistry(npmPluginPackages());
      try {
        await provide(registry);
      } finally {
        await registry.close();
      }
    },
    { scope: "worker" },
  ],
  e2eDaemonEnvironment: [
    async ({ npmRegistry }, provide) => {
      await provide(npmRegistry.env);
    },
    { scope: "worker" },
  ],
});

async function advertisePluginCapabilities(
  page: Page,
  features: Record<string, boolean | undefined>,
): Promise<void> {
  await page.routeWebSocket(daemonWsRoutePattern(), (browser) => {
    const server = browser.connectToServer();
    browser.onMessage((message) => server.send(message));
    server.onMessage((message) => {
      if (typeof message !== "string") {
        browser.send(message);
        return;
      }
      const envelope = JSON.parse(message);
      if (
        envelope.message?.type === "status" &&
        envelope.message.payload?.status === "server_info"
      ) {
        Object.assign(envelope.message.payload.features, features);
      }
      browser.send(JSON.stringify(envelope));
    });
  });
}

function observePluginCatalog(page: Page) {
  let responses = 0;
  page.on("websocket", (socket) => {
    socket.on("framereceived", ({ payload }) => {
      if (typeof payload !== "string") return;
      try {
        const envelope = JSON.parse(payload) as {
          type?: unknown;
          message?: { type?: unknown };
        };
        const message = envelope.type === "session" ? envelope.message : envelope;
        if (message?.type === "plugin.catalog.get.response") responses += 1;
      } catch {
        return;
      }
    });
  });
  return {
    waitForInitialFetch: async () => {
      await expect.poll(() => responses).toBeGreaterThan(0);
    },
  };
}

function pluginSource(title: string, renderError?: string): string {
  return `import React from "react";
import { Text } from "react-native";
export default function contribute(plugin) {
  function Surface() {
    ${renderError ? `throw new Error(${JSON.stringify(renderError)});` : ""}
    const cleanups = Number(globalThis.sessionStorage?.getItem("mixer-plugin-cleanups") || "0");
    return <Text>${title} cleanup {cleanups}</Text>;
  }
  plugin.addSurface("main", Surface);
  plugin.addSidebarItem({ id: "main", title: ${JSON.stringify(title)}, icon: "Blocks", surface: "main" });
  ${
    renderError
      ? `function HealthySurface() { return <Text>Healthy contribution</Text>; }
  plugin.addSurface("healthy", HealthySurface);
  plugin.addSidebarItem({ id: "healthy", title: "Healthy surface", icon: "Blocks", surface: "healthy" });`
      : ""
  }
  return () => {
    const storage = globalThis.sessionStorage;
    if (storage) {
      const cleanups = Number(storage.getItem("mixer-plugin-cleanups") || "0");
      storage.setItem("mixer-plugin-cleanups", String(cleanups + 1));
    }
  };
}`;
}

async function openPluginSettings(page: Page): Promise<void> {
  const serverId = getServerId();
  await openSettings(page);
  await openSettingsHost(page, serverId);
  await openHostSection(page, serverId, "plugins");
  await expectSettingsHeader(page, "Plugins");
}

async function openCompactPluginSettings(page: Page): Promise<void> {
  const serverId = getServerId();
  await openCompactSettings(page, buildOpenProjectRoute());
  await openHostSection(page, serverId, "plugins");
  await expect(page.getByRole("textbox", { name: "Plugin source", exact: true })).toBeVisible();
}

async function reloadPlugin(page: Page): Promise<void> {
  await selectPluginAction(page, "e2e-plugin", "Reload");
  await expect(page.getByText("Reloaded e2e-plugin", { exact: true })).toBeVisible();
}

async function openPluginActions(page: Page, pluginId: string): Promise<void> {
  await page.getByRole("button", { name: `Actions for ${pluginId}`, exact: true }).click();
  await expect(page.getByRole("menuitem").first()).toBeVisible();
}

async function selectPluginAction(page: Page, pluginId: string, action: string): Promise<void> {
  await openPluginActions(page, pluginId);
  await page.getByRole("menuitem", { name: action, exact: true }).click();
}

async function expectContributionBody(page: Page, expectedBody: string): Promise<void> {
  const body = page.getByText(expectedBody, { exact: true }).filter({ visible: true });
  await expect(body).toHaveCount(1);
  await expect(body).toBeVisible();
}

async function openContribution(page: Page, title: string, expectedBody: string): Promise<void> {
  await page.getByRole("button", { name: title, exact: true }).click();
  await expectContributionBody(page, expectedBody);
}

async function leavePluginSettings(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await expect(page).not.toHaveURL(/\/settings\//);
}

async function openContributionFromSettings(
  page: Page,
  title: string,
  expectedBody: string,
): Promise<void> {
  await leavePluginSettings(page);
  await openContribution(page, title, expectedBody);
}

async function reloadActiveContribution(
  page: Page,
  client: Awaited<ReturnType<typeof connectNewWorkspaceDaemonClient>>,
  expectedBody: string,
): Promise<void> {
  await client.reloadPlugin("e2e-plugin");
  await expectContributionBody(page, expectedBody);
}

async function expectContributionRemoved(page: Page, title: string): Promise<void> {
  await expect(page.getByRole("button", { name: title, exact: true })).not.toBeVisible();
}

async function capturePluginInstallForm(
  page: Page,
  testInfo: TestInfo,
  name: "wide" | "wide-menu" | "compact-error" | "compact-success" | "compact-menu",
): Promise<void> {
  await page.screenshot({
    path: testInfo.outputPath(`plugin-source-install-${name}.png`),
    fullPage: true,
    animations: "disabled",
  });
}

async function installPlugin(page: Page, source: string): Promise<void> {
  await page.getByLabel("Plugin source").fill(source);
  await page.getByRole("button", { name: "Install plugin" }).click();
}

async function expectPluginSourceDocsOpen(page: Page): Promise<void> {
  const requestedPage = page
    .context()
    .waitForEvent(
      "request",
      (request) => request.isNavigationRequest() && request.url().startsWith("https://paseo.sh/"),
    );
  const docsPagePromise = page.context().waitForEvent("page");
  await page.getByRole("link", { name: "Docs", exact: true }).click();
  const request = await requestedPage;
  const docsPage = await docsPagePromise;
  try {
    expect(new URL(request.url()).pathname).toBe("/docs/plugins/reference");
    // The deployed site can redirect while the matching website change is still in this PR.
    await docsPage.waitForURL(
      (url) => url.origin === "https://paseo.sh" && url.hash === "#plugin-sources",
      { waitUntil: "commit" },
    );
  } finally {
    await docsPage.close();
  }
}

async function createGitPluginRepository(root: string): Promise<string> {
  const repository = path.join(root, "repository");
  await mkdir(repository);
  await writeFile(
    path.join(repository, "mixer-plugin.json"),
    JSON.stringify({
      id: "git-e2e-plugin",
      description: "Adds review tools from a Git repository",
      requirements: pluginRequirements,
    }),
  );
  await writeFile(path.join(repository, "index.client.tsx"), pluginSource("Git plugin"));
  execFileSync("git", ["init", "-b", "main"], { cwd: repository, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Mixer Tests"], {
    cwd: repository,
    stdio: "ignore",
  });
  execFileSync("git", ["config", "user.email", "mixer@example.test"], {
    cwd: repository,
    stdio: "ignore",
  });
  execFileSync("git", ["add", "-A"], { cwd: repository, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: repository, stdio: "ignore" });
  return repository;
}

async function createDirectoryPlugin(
  root: string,
  id: string,
  description: string | undefined,
  title: string,
): Promise<string> {
  const directory = await mkdtemp(path.join(root, "plugin-row-"));
  await writeFile(
    path.join(directory, "mixer-plugin.json"),
    JSON.stringify({ id, description, requirements: pluginRequirements }),
  );
  await writeFile(
    path.join(directory, "index.client.tsx"),
    `import React from "react";
import { Text } from "react-native";
export default function contribute(plugin) {
  function Surface() { return <Text>${title}</Text>; }
  plugin.addSurface("main", Surface);
  plugin.addSidebarItem({ id: "main", title: ${JSON.stringify(title)}, icon: "Blocks", surface: "main" });
  return () => undefined;
}`,
  );
  return directory;
}

/** Build command that holds the plugin lifecycle queue until the test writes the release file. */
const gatedBuildCommand = [
  'const fs = require("node:fs");',
  'fs.writeFileSync(process.argv[1], "started");',
  "const wait = () => {",
  "  if (fs.existsSync(process.argv[2])) return;",
  "  setTimeout(wait, 50);",
  "};",
  "wait();",
].join("\n");

async function createGatedBuildRepository(
  root: string,
  gate: { started: string; release: string },
): Promise<string> {
  const repository = path.join(root, "gated-repository");
  await mkdir(repository);
  await writeFile(
    path.join(repository, "mixer-plugin.json"),
    JSON.stringify({
      id: "gated-build-plugin",
      description: "Holds the plugin lifecycle queue while its build waits",
      requirements: pluginRequirements,
      build: [[process.execPath, "-e", gatedBuildCommand, gate.started, gate.release]],
    }),
  );
  await writeFile(path.join(repository, "index.client.tsx"), pluginSource("Gated build plugin"));
  execFileSync("git", ["init", "-b", "main"], { cwd: repository, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Mixer Tests"], {
    cwd: repository,
    stdio: "ignore",
  });
  execFileSync("git", ["config", "user.email", "mixer@example.test"], {
    cwd: repository,
    stdio: "ignore",
  });
  execFileSync("git", ["add", "-A"], { cwd: repository, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: repository, stdio: "ignore" });
  return repository;
}

async function installFailedPlugin(
  page: Page,
  client: Awaited<ReturnType<typeof connectNewWorkspaceDaemonClient>>,
  directory: string,
): Promise<void> {
  await client.installPluginSource({ source: directory });
  await writeFile(path.join(directory, "index.client.tsx"), "export default broken !!!");
  await client.reloadPlugin("failed-preview-plugin");
  await expect(page.getByLabel("failed-preview-plugin failed")).toBeVisible();
}

test("installs, reloads, recovers, disables, and removes a trusted local plugin", async ({
  page,
  pluginEnvironment,
}, testInfo) => {
  const directory = await installLocalPluginWithStatusExamples(page, pluginEnvironment, testInfo);
  await reloadAndRecoverLocalPlugin(page, pluginEnvironment.client, directory);
  await toggleRemoveAndReinstallLocalPlugin(page, directory);
});

test("installs a Git source after a failed source remains editable", async ({
  page,
  pluginEnvironment,
}, testInfo) => {
  const source = await prepareCompactGitInstall(page, pluginEnvironment);
  await retryGitInstallAndInspectRows(page, source, testInfo);
});

for (const sourceSupport of [undefined, false]) {
  test(`keeps installed plugins manageable without source capability (${sourceSupport})`, async ({
    page,
    pluginEnvironment,
  }) => {
    const directory = await prepareLegacyPluginHost(page, pluginEnvironment, sourceSupport);
    await verifyLegacyPluginManagement(page, directory);
  });
}

for (const viewport of [
  { width: 1280, height: 900 },
  { width: 390, height: 844 },
]) {
  test(`installs an npm source and manages its row at ${viewport.width}px`, async ({
    page,
    pluginEnvironment,
  }, testInfo) => {
    await prepareNpmPluginHost(page, pluginEnvironment, viewport);
    await retryNpmInstallAndInspectRow(page, viewport.width, testInfo);
    await reloadAndRemoveNpmPlugin(page);
  });
}

async function openNpmPluginSettings(page: Page, width: number) {
  if (width < 600) await openCompactPluginSettings(page);
  else await openPluginSettings(page);
}

async function expectSourceHierarchy(page: Page, description: string, source: string) {
  const descriptionText = page.getByText(description, { exact: false });
  const sourceText = page.getByText(source, { exact: false });
  const descriptionSize = await descriptionText.evaluate((element) =>
    Number.parseFloat(getComputedStyle(element).fontSize),
  );
  const sourceSize = await sourceText.evaluate((element) =>
    Number.parseFloat(getComputedStyle(element).fontSize),
  );
  expect(sourceSize).toBeLessThan(descriptionSize);
  await expect(sourceText).toHaveCSS("color", "rgb(161, 161, 170)");
  await expect(descriptionText).toHaveCSS("color", "rgb(113, 113, 122)");
}

async function installLocalPluginWithStatusExamples(
  page: Page,
  pluginEnvironment: PluginEnvironment,
  testInfo: TestInfo,
) {
  const directory = await mkdtemp(path.join(pluginEnvironment.directory, "local-"));
  const disabledDirectory = await createDirectoryPlugin(
    pluginEnvironment.directory,
    "disabled-preview-plugin-with-a-long-name",
    "Keeps optional previews off until this plugin is enabled",
    "Preview plugin",
  );
  const failedDirectory = await createDirectoryPlugin(
    pluginEnvironment.directory,
    "failed-preview-plugin",
    "Demonstrates a plugin that needs attention",
    "Failed preview plugin",
  );
  const { client } = pluginEnvironment;
  await writeFile(
    path.join(directory, "mixer-plugin.json"),
    JSON.stringify({
      id: "e2e-plugin",
      description: "Exercises the complete local plugin lifecycle",
      requirements: pluginRequirements,
    }),
  );
  await writeFile(path.join(directory, "index.client.tsx"), pluginSource("Plugin v1"));

  const catalog = observePluginCatalog(page);
  await gotoAppShell(page);
  await openPluginSettings(page);
  await catalog.waitForInitialFetch();
  await expect(page.getByRole("textbox", { name: "Plugin installation ID" })).toHaveCount(0);
  await expectPluginSourceDocsOpen(page);
  await client.patchDaemonConfig({ pluginsEnabled: false });
  await page.getByRole("switch", { name: "Enable plugins" }).click();
  await expect(page.getByText("Plugins enabled", { exact: true })).toBeVisible();
  await client.installPluginSource({ source: disabledDirectory });
  await client.disablePlugin("disabled-preview-plugin-with-a-long-name");
  await installFailedPlugin(page, client, failedDirectory);
  await page.getByLabel("Plugin source").fill(directory);
  await page.getByRole("button", { name: "Install plugin" }).click();
  await expect(page.getByText("Installed e2e-plugin", { exact: true })).toBeVisible();
  await expect(page.getByLabel("e2e-plugin running")).toBeVisible();
  await expect(page.getByText("Exercises the complete local plugin lifecycle")).toBeVisible();
  await expect(
    page.getByText("Keeps optional previews off until this plugin is enabled"),
  ).toBeVisible();
  await expect(page.getByText("Demonstrates a plugin that needs attention")).toBeVisible();
  await expect(page.getByLabel("disabled-preview-plugin-with-a-long-name disabled")).toBeVisible();
  await expect(page.getByLabel("failed-preview-plugin failed")).toBeVisible();
  await capturePluginInstallForm(page, testInfo, "wide");
  await openPluginActions(page, "e2e-plugin");
  await capturePluginInstallForm(page, testInfo, "wide-menu");
  await page.getByRole("menuitem", { name: "Logs", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("Logs: e2e-plugin");
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await openContributionFromSettings(page, "Plugin v1", "Plugin v1 cleanup 0");

  return directory;
}

async function reloadAndRecoverLocalPlugin(
  page: Page,
  client: PluginEnvironment["client"],
  directory: string,
) {
  await openPluginSettings(page);
  await reloadPlugin(page);
  await openContributionFromSettings(page, "Plugin v1", "Plugin v1 cleanup 1");

  await writeFile(path.join(directory, "index.client.tsx"), pluginSource("Plugin v2"));
  await openPluginSettings(page);
  await reloadPlugin(page);
  await openContributionFromSettings(page, "Plugin v2", "Plugin v2 cleanup 2");
  await expect(page.getByRole("button", { name: "Plugin v1", exact: true })).not.toBeVisible();

  await writeFile(
    path.join(directory, "index.client.tsx"),
    pluginSource("Broken surface", "render exploded"),
  );
  await openPluginSettings(page);
  await reloadPlugin(page);
  await openContributionFromSettings(page, "Broken surface", "Plugin failed: render exploded");
  await openContribution(page, "Healthy surface", "Healthy contribution");
  await openContribution(page, "Broken surface", "Plugin failed: render exploded");

  await writeFile(path.join(directory, "index.client.tsx"), pluginSource("Recovered surface"));
  await reloadActiveContribution(page, client, "Recovered surface cleanup 4");
  await expect(page.getByRole("button", { name: "Broken surface", exact: true })).not.toBeVisible();

  await writeFile(path.join(directory, "index.client.tsx"), "export default broken syntax !!!");
  await openPluginSettings(page);
  await selectPluginAction(page, "e2e-plugin", "Reload");
  await expect(page.getByTestId("plugin-management-feedback")).toContainText("Request failed");
  await expect(page.getByLabel("e2e-plugin failed")).toBeVisible();
  await leavePluginSettings(page);
  await expectContributionRemoved(page, "Recovered surface");

  await writeFile(path.join(directory, "index.client.tsx"), pluginSource("Plugin v3"));
  await openPluginSettings(page);
  await selectPluginAction(page, "e2e-plugin", "Reload");
  await expect(page.getByLabel("e2e-plugin running")).toBeVisible();
  await openContributionFromSettings(page, "Plugin v3", "Plugin v3 cleanup 5");
}

async function toggleRemoveAndReinstallLocalPlugin(page: Page, directory: string) {
  await openPluginSettings(page);
  await page.getByRole("switch", { name: "e2e-plugin: Disable", exact: true }).click();
  await expect(page.getByLabel("e2e-plugin disabled")).toBeVisible();
  await leavePluginSettings(page);
  await expectContributionRemoved(page, "Plugin v3");

  await openPluginSettings(page);
  await page.getByRole("switch", { name: "e2e-plugin: Enable", exact: true }).click();
  await expect(page.getByLabel("e2e-plugin running")).toBeVisible();
  await openContributionFromSettings(page, "Plugin v3", "Plugin v3 cleanup 6");

  await openPluginSettings(page);
  page.once("dialog", (dialog) => dialog.accept());
  await selectPluginAction(page, "e2e-plugin", "Remove");
  await expect(page.getByTestId("plugin-row-e2e-plugin")).toHaveCount(0);

  await installPlugin(page, directory);
  await expect(page.getByLabel("e2e-plugin running")).toBeVisible();
  await gotoAppShell(page);
  await openContribution(page, "Plugin v3", "Plugin v3 cleanup 7");
}

async function prepareCompactGitInstall(page: Page, pluginEnvironment: PluginEnvironment) {
  const root = pluginEnvironment.directory;
  const repository = await createGitPluginRepository(root);
  const longDirectory = await createDirectoryPlugin(
    pluginEnvironment.directory,
    "compact-plugin-with-a-realistically-long-name",
    "Shows how a realistically long plugin description wraps on a compact screen",
    "Compact long plugin",
  );
  const disabledDirectory = await createDirectoryPlugin(
    pluginEnvironment.directory,
    "compact-disabled-plugin",
    "Remains installed and ready to enable later",
    "Compact disabled plugin",
  );
  const missingSource = path.join(root, "missing-plugin");
  const { client } = pluginEnvironment;

  await page.setViewportSize({ width: 390, height: 844 });
  await client.installPluginSource({ source: longDirectory });
  await client.installPluginSource({ source: disabledDirectory });
  await client.disablePlugin("compact-disabled-plugin");
  await gotoAppShell(page);
  await openCompactPluginSettings(page);
  await expect(page.getByRole("textbox", { name: "Plugin installation ID" })).toHaveCount(0);
  await client.patchDaemonConfig({ pluginsEnabled: false });
  await page.getByRole("switch", { name: "Enable plugins" }).click();
  await expect(page.getByText("Plugins enabled", { exact: true })).toBeVisible();

  return { repository, missingSource };
}

async function retryGitInstallAndInspectRows(
  page: Page,
  source: { repository: string; missingSource: string },
  testInfo: TestInfo,
) {
  const { repository, missingSource } = source;

  await installPlugin(page, missingSource);
  await expect(page.getByTestId("plugin-management-feedback")).toContainText(
    `Plugin directory does not exist: ${missingSource}`,
  );
  await expect(page.getByLabel("Plugin source")).toHaveValue(missingSource);
  await capturePluginInstallForm(page, testInfo, "compact-error");

  await installPlugin(page, pathToFileURL(repository).href);
  await expect(page.getByText("Installed git-e2e-plugin", { exact: true })).toBeVisible();
  await expect(page.getByLabel("git-e2e-plugin running")).toBeVisible();
  await expect(
    page.getByText("Shows how a realistically long plugin description wraps on a compact screen"),
  ).toBeVisible();
  await expect(page.getByLabel("compact-disabled-plugin disabled")).toBeVisible();
  await expect(page.getByLabel("Plugin source")).toHaveValue("");
  await capturePluginInstallForm(page, testInfo, "compact-success");
  await openPluginActions(page, "git-e2e-plugin");
  const removeAction = page.getByRole("menuitem", { name: "Remove", exact: true });
  await expect(removeAction).toBeInViewport({ ratio: 1 });
  await waitForSettledPosition(removeAction);
  await capturePluginInstallForm(page, testInfo, "compact-menu");
  await page.keyboard.press("Escape");
}

async function prepareLegacyPluginHost(
  page: Page,
  pluginEnvironment: PluginEnvironment,
  sourceSupport: boolean | undefined,
) {
  const directory = await createDirectoryPlugin(
    pluginEnvironment.directory,
    "legacy-source-plugin",
    undefined,
    "Legacy plugin",
  );
  const { client } = pluginEnvironment;
  await client.patchDaemonConfig({ pluginsEnabled: true });
  await client.installPluginSource({ source: directory });
  await advertisePluginCapabilities(page, {
    pluginSourceInstallation: sourceSupport,
    pluginGitManagement: true,
  });
  await gotoAppShell(page);
  await openPluginSettings(page);

  return directory;
}

async function verifyLegacyPluginManagement(page: Page, directory: string) {
  await expect(
    page.getByText("Update this host to install plugins", { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Plugin source", exact: true })).toHaveCount(0);
  await expect(page.getByText(directory, { exact: true })).toBeVisible();
  await selectPluginAction(page, "legacy-source-plugin", "Reload");
  await expect(page.getByText("Reloaded legacy-source-plugin", { exact: true })).toBeVisible();
}

async function prepareNpmPluginHost(
  page: Page,
  pluginEnvironment: PluginEnvironment,
  viewport: { width: number; height: number },
) {
  const { client } = pluginEnvironment;
  await page.setViewportSize(viewport);
  await advertisePluginCapabilities(page, { pluginGitManagement: false });
  await client.patchDaemonConfig({ pluginsEnabled: true });
  await gotoAppShell(page);
  await openNpmPluginSettings(page, viewport.width);
}

async function retryNpmInstallAndInspectRow(page: Page, width: number, testInfo: TestInfo) {
  await installPlugin(page, "npm:missing-plugin");
  await expect(page.getByTestId("plugin-management-feedback")).toContainText("404");
  await expect(page.getByLabel("Plugin source")).toHaveValue("npm:missing-plugin");
  await installPlugin(page, "npm:@mixer-fixture/review@^2.0.0");
  await expect(page.getByText("Installed npm-review", { exact: true })).toBeVisible();
  await expect(page.getByLabel("npm-review running")).toBeVisible();
  await expectSourceHierarchy(
    page,
    "Installed from the npm fixture registry",
    "npm:@mixer-fixture/review · 2.0.0",
  );
  await expect(
    page.getByText("Installed from the npm fixture registry", { exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath(`npm-plugin-${width}.png`),
    animations: "disabled",
  });
}

async function reloadAndRemoveNpmPlugin(page: Page) {
  await selectPluginAction(page, "npm-review", "Reload");
  await expect(page.getByText("Reloaded npm-review", { exact: true })).toBeVisible();
  page.once("dialog", (dialog) => dialog.accept());
  await selectPluginAction(page, "npm-review", "Remove");
  await expect(page.getByText("Removed npm-review", { exact: true })).toBeVisible();
  await expect(page.getByLabel("npm-review running")).toHaveCount(0);
}

test("renders installed-plugin descriptions as plain text", async ({ page, pluginEnvironment }) => {
  const description = overviewCorpus.map(({ markdown }) => markdown).join("\n\n");
  await installPluginWithUntrustedDescription(pluginEnvironment, description);
  await gotoAppShell(page);
  await openPluginSettings(page);
  const text = page.getByText(description, { exact: true });
  await expect(text).toBeVisible();
  // This field must remain a text node, with no Markdown links, images, or HTML children.
  expect(await text.evaluate((element) => element.childElementCount)).toBe(0);
});

async function installPluginWithUntrustedDescription(
  environment: PluginEnvironment,
  description: string,
) {
  const directory = await createDirectoryPlugin(
    environment.directory,
    "plain-text-plugin",
    description,
    "Plain text plugin",
  );
  await environment.client.installPluginSource({ source: directory });
}

/** Waits for the reload request and the daemon's answer on the wire, so a scenario can measure it. */
function observePluginReload(page: Page) {
  const requests: number[] = [];
  const responses: number[] = [];
  const isSessionMessage = (payload: unknown, type: string): boolean => {
    if (typeof payload !== "string") return false;
    try {
      const envelope = JSON.parse(payload) as { type?: unknown; message?: { type?: unknown } };
      const message = envelope.type === "session" ? envelope.message : envelope;
      return message?.type === type;
    } catch {
      return false;
    }
  };
  page.on("websocket", (socket) => {
    // The reload request travels client -> daemon (outbound); the answer comes back inbound.
    socket.on("framesent", ({ payload }) => {
      if (isSessionMessage(payload, "plugin.reload.request")) requests.push(Date.now());
    });
    socket.on("framereceived", ({ payload }) => {
      if (isSessionMessage(payload, "plugin.reload.response")) responses.push(Date.now());
    });
  });
  return {
    waitForRequest: () => expect.poll(() => requests.length, { timeout: 30_000 }).toBe(1),
    waitForResponse: () => expect.poll(() => responses.length, { timeout: 120_000 }).toBe(1),
    requestedAt: () => requests[0]!,
    requestCount: () => requests.length,
  };
}

/** Starts a gated git install that holds the daemon's plugin lifecycle queue until it is released. */
async function holdPluginLifecycleQueue(
  client: PluginEnvironment["client"],
  root: string,
): Promise<{ release: () => Promise<void>; settle: () => Promise<void> }> {
  const gate = {
    started: path.join(root, "build-started"),
    release: path.join(root, "build-release"),
  };
  const repository = await createGatedBuildRepository(root, gate);
  const install = client.installPluginSource({ source: `git:${pathToFileURL(repository).href}` });
  // The marker wait below can outlive an early failure: a refused preparation, a dropped
  // connection, or a build command that exits before writing its marker. Handle that rejection now
  // so it never surfaces as an unhandled one, and drain the same promise in finish().
  const installDrained = install.catch(() => undefined);
  // Every path releases the gate and drains the install: a build still polling for its gate holds
  // the daemon's plugin lifecycle queue open, and the fixture's own plugin removal would stall.
  const finish = async () => {
    await writeFile(gate.release, "go").catch(() => undefined);
    await installDrained;
  };
  try {
    // Whichever comes first decides the scenario: the build reports that it started, or the setup
    // fails with the daemon's own error instead of a bare marker timeout.
    await Promise.race([
      expect.poll(() => existsSync(gate.started), { timeout: 30_000 }).toBe(true),
      install,
    ]);
  } catch (error) {
    // Setup that never reached the build must not hand the caller a queue it cannot settle.
    await finish();
    throw error;
  }
  return {
    release: () => writeFile(gate.release, "go"),
    settle: finish,
  };
}

function pluginRowActions(page: Page, pluginId: string) {
  return page.getByRole("button", { name: `Actions for ${pluginId}`, exact: true });
}

async function expectPluginRowPending(page: Page, pluginId: string): Promise<void> {
  await expect(pluginRowActions(page, pluginId)).toBeDisabled();
}

async function expectPluginRowSettled(page: Page, pluginId: string): Promise<void> {
  await expect(pluginRowActions(page, pluginId)).toBeEnabled();
  await expect(page.getByLabel(`${pluginId} running`)).toBeVisible();
}

async function capturePluginSurface(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  await page.screenshot({
    path: testInfo.outputPath(name),
    fullPage: true,
    animations: "disabled",
  });
}

/** The wait under test is the daemon's lifecycle queue, so the scenario has to spend real time. */
async function waitPastFormerReloadDeadline(page: Page, requestedAt: number): Promise<void> {
  const remaining = 66_000 - (Date.now() - requestedAt);
  if (remaining > 0) await page.waitForTimeout(remaining);
}

test("keeps Reload pending past a minute while the plugin queue is busy", async ({
  page,
  pluginEnvironment,
}, testInfo) => {
  test.setTimeout(180_000);
  const { client, directory } = pluginEnvironment;
  const pluginDirectory = await createDirectoryPlugin(
    directory,
    "e2e-plugin",
    "Exercises the complete local plugin lifecycle",
    "Plugin v1",
  );

  // Observe before the app loads: its daemon socket comes up with the page.
  const reload = observePluginReload(page);
  await gotoAppShell(page);
  await openPluginSettings(page);
  // Plugins on is a precondition here, not the subject: set it through the daemon instead of the
  // switch, whose transient "Plugins enabled" confirmation this scenario must not depend on.
  await client.patchDaemonConfig({ pluginsEnabled: true });
  await client.installPluginSource({ source: pluginDirectory });
  await expectPluginRowSettled(page, "e2e-plugin");

  const queue = await holdPluginLifecycleQueue(client, directory);
  try {
    await selectPluginAction(page, "e2e-plugin", "Reload");
    await reload.waitForRequest();
    // Pending: the row's actions stay disabled, so a second reload cannot be submitted.
    await expectPluginRowPending(page, "e2e-plugin");
    await capturePluginSurface(page, testInfo, "plugin-reload-pending.png");

    await waitPastFormerReloadDeadline(page, reload.requestedAt());

    // Past the former deadline the reload is still pending, the row shows its previous state, and
    // no timeout error reached the surface.
    await expectPluginRowPending(page, "e2e-plugin");
    await expect(page.getByLabel("e2e-plugin running")).toBeVisible();
    await expect(page.getByTestId("plugin-management-feedback")).toHaveCount(0);
    await capturePluginSurface(page, testInfo, "plugin-reload-past-deadline.png");

    await queue.release();
    // The daemon's answer only arrives once the plugin really started again; a request timeout
    // would have shown up as feedback during the wait above.
    await reload.waitForResponse();
    expect(reload.requestCount()).toBe(1);
    await expect(page.getByTestId("plugin-management-feedback")).toContainText(
      "Reloaded e2e-plugin",
    );
    await expectPluginRowSettled(page, "e2e-plugin");
    await capturePluginSurface(page, testInfo, "plugin-reload-completed.png");
  } finally {
    await queue.settle();
  }
});
