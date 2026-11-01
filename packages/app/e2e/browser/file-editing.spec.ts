import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { expect, test, type Page } from "../support/fixtures";
import {
  expandFolder,
  openFileExplorer,
  openFileFromExplorer,
  expectFileTabOpen,
} from "../support/helpers/file-explorer";
import { installDaemonWebSocketGate } from "../support/helpers/daemon-websocket-gate";
import { gotoAppShell } from "../support/helpers/app";
import { openAgentRoute, seedMockAgentWorkspace } from "../support/helpers/mock-agent";
import { seedWorkspace } from "../support/helpers/seed-client";
import { getServerId } from "../support/helpers/server-id";
import { waitForSidebarHydration } from "../support/helpers/workspace-ui";
import {
  editorCommandSchema,
  type EditorConfiguration,
} from "../../src/file-panels/source/editor/monaco/messages";
import type { EditorPreferences } from "../../src/file-panels/source/editor/preferences";
// Keep Playwright's CommonJS transform out of the SDK's native-ESM dist dependency graph.
import { WorkspaceGitCommitResponseSchema } from "../../../protocol/src/editor-git";
import { ServerInfoStatusPayloadSchema } from "../../../protocol/src/messages";
import type { Locator } from "@playwright/test";
import { installDesktopRuntime } from "../../../desktop/e2e/support/runtime";
import { getE2EDaemonPort } from "../support/helpers/daemon-port";

for (const startupPlatform of ["darwin", "linux"] as const) {
  test(`desktop startup prepares Monaco and restores the active editor before revealing the IDE on ${startupPlatform}`, async ({
    page,
  }) => {
    test.skip(
      process.env.MIXER_WEB_PLATFORM !== "electron",
      "Exercises the bundled desktop editor",
    );
    const workspace = await seedWorkspace({
      repoPrefix: "startup-editor-",
      repo: { files: [{ path: "startup.txt", content: "Ready before opening\n" }] },
    });
    try {
      await installDesktopRuntime(page, {
        serverId: getServerId(),
        daemonListen: `127.0.0.1:${getE2EDaemonPort()}`,
        startupReadiness: true,
        platform: startupPlatform,
      });
      await gotoAppShell(page);
      await expect.poll(() => page.evaluate(() => window.__desktopStartupSignals?.length)).toBe(1);
      expect(await page.evaluate(() => window.__desktopStartupSignals?.[0])).toEqual({
        splash: false,
        warmup: false,
        editors: 0,
        readyEditors: 0,
      });
      await page
        .getByTestId(`sidebar-workspace-row-${getServerId()}:${workspace.workspaceId}`)
        .click();
      await openWorkspaceFile(page, "startup.txt");
      const source = page
        .getByTestId("file-source-editor")
        .filter({ visible: true })
        .first()
        .frameLocator("iframe");
      await expect(source.locator(".view-lines")).toContainText("Ready before opening");
      await page
        .getByTestId("workspace-tab-file_startup.txt")
        .first()
        .getByText("startup.txt", { exact: true })
        .dblclick();
      await page.reload();
      await expect.poll(() => page.evaluate(() => window.__desktopStartupSignals?.length)).toBe(1);
      expect(await page.evaluate(() => window.__desktopStartupSignals?.[0])).toEqual({
        splash: false,
        warmup: false,
        editors: 1,
        readyEditors: 1,
      });
      await expect(source.locator(".view-lines")).toContainText("Ready before opening");
      await expect(page.getByTestId("desktop-startup-recovery")).toHaveCount(0);
    } finally {
      await workspace.cleanup();
    }
  });
}

const APP_SETTINGS_KEY = "@mixer:app-settings";

function enrichEditorCommitFixture(message: string | Buffer): string | Buffer {
  if (typeof message !== "string") return message;
  const parsed = z
    .object({ message: WorkspaceGitCommitResponseSchema })
    .passthrough()
    .safeParse(JSON.parse(message));
  if (!parsed.success) return message;
  const details = parsed.data.message.payload.result;
  if (!details || !details.commit.summary.startsWith("Change second line")) return message;
  details.pullRequest = {
    number: 113,
    title: "Price formatting",
    url: "https://github.com/example/project/pull/113",
    state: "MERGED",
  };
  details.url = `https://github.com/example/project/commit/${details.commit.sha}`;
  details.authorAvatar =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aYZkAAAAASUVORK5CYII=";
  details.authorProfileUrl = "https://github.com/example";
  return JSON.stringify(parsed.data);
}

function stripLanguageProviderCapability(message: string | Buffer): string | Buffer {
  if (typeof message !== "string") return message;
  const parsed = z
    .object({
      message: z.object({ type: z.literal("status"), payload: ServerInfoStatusPayloadSchema }),
    })
    .passthrough()
    .safeParse(JSON.parse(message));
  if (!parsed.success) return message;
  parsed.data.message.payload.features = {
    ...parsed.data.message.payload.features,
    languageProviders: false,
  };
  return JSON.stringify(parsed.data);
}

function isInsideHoverViewport(element: Element): boolean {
  const bounds = element.getBoundingClientRect();
  const card = element.closest(".monaco-hover")?.getBoundingClientRect();
  return card ? bounds.top >= card.top && bounds.bottom <= card.bottom : false;
}

function gitHoverAlignment(element: Element): number[] {
  const paragraph = element.querySelector(".markdown-hover p");
  const preview = element.querySelector(".monaco-tokenized-source");
  const separator = element.querySelector("hr");
  if (!paragraph || !preview || !separator) throw new Error("Git card sections are missing");
  const left = paragraph.getBoundingClientRect().left;
  const previewStyle = getComputedStyle(preview);
  return [
    Math.abs(
      preview.getBoundingClientRect().left +
        parseFloat(previewStyle.paddingLeft) +
        parseFloat(previewStyle.borderLeftWidth) -
        left,
    ),
    Math.abs(separator.getBoundingClientRect().left - left),
  ];
}

function gitHoverDiffIsColored(element: Element): boolean {
  const spans = Array.from(element.querySelectorAll("span")).filter(
    (span) => span.children.length === 0,
  );
  const added = spans.find((span) =>
    span.textContent?.replace(/\u00a0/g, " ").includes("+const second = 3;"),
  );
  return !!added && getComputedStyle(added).color !== getComputedStyle(element).color;
}

function distinctSourceColorCount(element: Element): number {
  const spans = Array.from(element.querySelectorAll("span")).filter(
    (span) =>
      span.children.length === 0 && span.textContent?.trim() && !span.closest(".mixer-git-inline"),
  );
  return new Set(spans.map((span) => getComputedStyle(span).color)).size;
}

async function semanticSyntaxColors(lines: Locator) {
  return lines.evaluate((element) => {
    const spans = Array.from(element.querySelectorAll("span")).filter(
      (span) => span.children.length === 0,
    );
    return ["import", "ReactNode", "Example", "hello", "section", "{"].map((word) => {
      const span = spans.find((candidate) => (candidate.textContent ?? "").includes(word));
      if (!span) throw new Error(`Missing syntax probe ${word}`);
      return { word, color: getComputedStyle(span).color };
    });
  });
}

for (const colorScheme of ["dark", "light"] as const) {
  test(`Source Control diff syntax matches the normal file editor in ${colorScheme} mode`, async ({
    page,
  }) => {
    test.skip(
      process.env.MIXER_WEB_PLATFORM !== "electron",
      "Compares the desktop TextMate editors",
    );
    test.setTimeout(120_000);
    await page.emulateMedia({ colorScheme });
    await page.addInitScript((rainbowBrackets) => {
      localStorage.setItem("@mixer:app-settings", JSON.stringify({ editor: { rainbowBrackets } }));
    }, colorScheme === "light");
    const original =
      'import type { ReactNode } from "react";\ntype Props = { children: ReactNode };\nexport function Example({ children }: Props) {\n  const message = "hello";\n  return <section>{message}{children}</section>;\n}\n';
    const modified = `${original}// changed\n`;
    const session = await seedMockAgentWorkspace({
      repoPrefix: "scm-syntax-parity-",
      title: "Syntax parity",
      initialPrompt: "Inspect the change.",
      repo: { files: [{ path: "syntax.tsx", content: original }] },
    });
    try {
      await writeFile(path.join(session.cwd, "syntax.tsx"), modified);
      await openAgentRoute(page, session);
      await openWorkspaceFile(page, "syntax.tsx");
      const source = page
        .getByTestId("file-source-editor")
        .filter({ visible: true })
        .frameLocator("iframe");
      await expect(source.locator(".view-lines")).toContainText("Example", { timeout: 30_000 });
      const expected = await semanticSyntaxColors(source.locator(".view-lines"));
      await page
        .getByTestId("workspace-explorer-sidebar")
        .filter({ visible: true })
        .getByRole("button", { name: "Source Control", exact: true })
        .click();
      await page
        .getByTestId("source-control-panel")
        .filter({ visible: true })
        .getByRole("button", { name: "Open working tree diff for syntax.tsx", exact: true })
        .click();
      const diff = page.frameLocator('iframe[title="syntax.tsx diff editor"]');
      const diffTab = page.getByRole("button", { name: "syntax.tsx (Working Tree)", exact: true });
      const diffLabel = diffTab.getByText("syntax.tsx (Working Tree)", { exact: true });
      await expect(diffLabel).toHaveCSS("text-overflow", "clip");
      await expect
        .poll(() => diffLabel.evaluate((element) => element.scrollWidth - element.clientWidth))
        .toBeLessThanOrEqual(1);
      await expect(diff.locator(".editor.modified .view-lines")).toContainText("Example", {
        timeout: 30_000,
      });
      expect(await semanticSyntaxColors(diff.locator(".editor.original .view-lines"))).toEqual(
        expected,
      );
      expect(await semanticSyntaxColors(diff.locator(".editor.modified .view-lines"))).toEqual(
        expected,
      );
      await expect(diff.locator(".line-insert, .char-insert").first()).toBeVisible();
      expect(await readFile(path.join(session.cwd, "syntax.tsx"), "utf8")).toBe(modified);
      const input = diff.getByRole("textbox").last();
      await input.focus();
      await input.press("Control+End");
      await input.pressSequentially("// syntax save");
      await input.press("Control+s");
      await expect
        .poll(() => readFile(path.join(session.cwd, "syntax.tsx"), "utf8"))
        .toBe(`${modified}// syntax save`);
      await page.screenshot({
        path: test.info().outputPath(`source-control-syntax-${colorScheme}.png`),
      });
    } finally {
      await session.cleanup();
    }
  });
}

test("Files and Source Control share replaceable italic previews that become permanent", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  const session = await seedMockAgentWorkspace({
    repoPrefix: "preview-tabs-",
    title: "Preview tabs",
    initialPrompt: "Inspect the files.",
  });
  try {
    for (const filename of ["a.ts", "b.ts", "c.ts", "d.ts"])
      await writeFile(path.join(session.cwd, filename), "export const value = 1;\n");
    execFileSync("git", ["add", "a.ts", "b.ts", "c.ts", "d.ts"], { cwd: session.cwd });
    execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-m", "Preview fixtures"], {
      cwd: session.cwd,
    });
    for (const filename of ["a.ts", "b.ts", "c.ts", "d.ts"])
      await writeFile(path.join(session.cwd, filename), "export const value = 2;\n");
    await openAgentRoute(page, session);
    await openWorkspaceFile(page, "a.ts");
    const first = page.getByTestId("workspace-tab-file_a.ts").filter({ visible: true });
    await expect(first.getByText("a.ts", { exact: true })).toHaveCSS("font-style", "italic");
    await openWorkspaceFile(page, "b.ts");
    await expect(first).toHaveCount(0);
    const kept = page.getByTestId("workspace-tab-file_b.ts").filter({ visible: true });
    await kept.getByText("b.ts", { exact: true }).dblclick();
    await expect(kept.getByText("b.ts", { exact: true })).toHaveCSS("font-style", "normal");
    await openWorkspaceFile(page, "c.ts");
    await replaceEditorText(page, "export const edited = true;\n");
    const edited = page.getByTestId("workspace-tab-file_c.ts").filter({ visible: true });
    await expect(edited.getByText("c.ts", { exact: true })).toHaveCSS("font-style", "normal");
    await expect
      .poll(() => readFile(path.join(session.cwd, "c.ts"), "utf8"))
      .toBe("export const edited = true;\n");
    await openWorkspaceFile(page, "d.ts");
    await expect(kept).toBeVisible();
    await expect(edited).toBeVisible();
    await page
      .getByTestId("workspace-explorer-sidebar")
      .filter({ visible: true })
      .getByRole("button", { name: "Source Control", exact: true })
      .click();
    const scm = page.getByTestId("source-control-panel").filter({ visible: true });
    await scm.getByRole("button", { name: "Open working tree diff for a.ts", exact: true }).click();
    const diffA = page.getByRole("button", { name: "a.ts (Working Tree)", exact: true });
    await expect(diffA.getByText("a.ts (Working Tree)", { exact: true })).toHaveCSS(
      "font-style",
      "italic",
    );
    await expect(page.getByTestId("workspace-tab-file_d.ts").filter({ visible: true })).toHaveCount(
      0,
    );
    await scm.getByRole("button", { name: "Open working tree diff for b.ts", exact: true }).click();
    await expect(diffA).toHaveCount(0);
    const diffB = page.getByRole("button", { name: "b.ts (Working Tree)", exact: true });
    await diffB.getByText("b.ts (Working Tree)", { exact: true }).dblclick();
    await expect(diffB.getByText("b.ts (Working Tree)", { exact: true })).toHaveCSS(
      "font-style",
      "normal",
    );
    await scm.getByRole("button", { name: "Open working tree diff for c.ts", exact: true }).click();
    await expect(diffB).toBeVisible();
    await expect(
      page
        .getByRole("button", { name: "c.ts (Working Tree)", exact: true })
        .getByText("c.ts (Working Tree)", { exact: true }),
    ).toHaveCSS("font-style", "italic");
    const diffC = page.getByRole("button", { name: "c.ts (Working Tree)", exact: true });
    const diffEditor = page
      .frameLocator('iframe[title="c.ts diff editor"]')
      .getByRole("textbox")
      .last();
    await expect(diffEditor).toBeAttached();
    await expect(diffC.getByText("c.ts (Working Tree)", { exact: true })).toHaveCSS(
      "font-style",
      "italic",
    );
    await diffEditor.press("ControlOrMeta+End");
    await diffEditor.press("Enter");
    await diffEditor.pressSequentially("// keep this diff");
    await expect(diffC.getByText("c.ts (Working Tree)", { exact: true })).toHaveCSS(
      "font-style",
      "normal",
    );
    await scm.getByRole("button", { name: "Open working tree diff for d.ts", exact: true }).click();
    await expect(diffC).toBeVisible();
    for (const filename of ["e.ts", "f.ts", "g.ts"])
      await writeFile(path.join(session.cwd, filename), "export const untracked = true;\n");
    await scm.getByRole("button", { name: "Open file e.ts", exact: true }).click();
    const previewE = page.getByTestId("workspace-tab-file_e.ts").filter({ visible: true });
    await expect(previewE.getByText("e.ts", { exact: true })).toHaveCSS("font-style", "italic");
    await expect(
      page.getByRole("button", { name: "d.ts (Working Tree)", exact: true }),
    ).toHaveCount(0);
    await scm.getByRole("button", { name: "Open file f.ts", exact: true }).click();
    await expect(previewE).toHaveCount(0);
    const permanentF = page.getByTestId("workspace-tab-file_f.ts").filter({ visible: true });
    await permanentF.getByText("f.ts", { exact: true }).dblclick();
    await expect(permanentF.getByText("f.ts", { exact: true })).toHaveCSS("font-style", "normal");
    await scm.getByRole("button", { name: "Open file g.ts", exact: true }).click();
    const permanentG = page.getByTestId("workspace-tab-file_g.ts").filter({ visible: true });
    await expect(permanentG.getByText("g.ts", { exact: true })).toHaveCSS("font-style", "italic");
    await replaceEditorText(page, "export const editedUntracked = true;\n");
    await expect(permanentG.getByText("g.ts", { exact: true })).toHaveCSS("font-style", "normal");
    await scm.getByRole("button", { name: "Open file e.ts", exact: true }).click();
    await expect(permanentF).toBeVisible();
    await expect(permanentG).toBeVisible();
  } finally {
    await session.cleanup();
  }
});

test("file tabs display full names and scroll rather than compressing filenames", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1280, height: 900 });
  const filenames = [
    "locale-provider.tsx",
    "use-error-notifications.ts",
    "workspace-file-navigation-controller.ts",
  ];
  const longName = `${"an-exceptionally-long-component-name-".repeat(5)}view.tsx`;
  const session = await seedMockAgentWorkspace({
    repoPrefix: "full-file-tabs-",
    title: "File tab sizing",
    initialPrompt: "Show the files.",
    featureValues: {
      mockAssistantResponse: [...filenames, longName]
        .map((filename) => `[${filename}](${filename})`)
        .join("\n\n"),
    },
  });
  try {
    for (const filename of [...filenames, longName])
      await writeFile(path.join(session.cwd, filename), "export const example = true;\n");
    await openAgentRoute(page, session);
    for (const filename of filenames) {
      await page
        .getByTestId(`workspace-tab-agent_${session.agentId}`)
        .filter({ visible: true })
        .click();
      await page.getByRole("link", { name: filename, exact: true }).click();
      await expectFileTabOpen(page, filename);
      const tab = page.getByTestId(`workspace-tab-file_${filename}`).filter({ visible: true });
      const label = tab.getByText(filename, { exact: true });
      await expect(label).toHaveCSS("text-overflow", "clip");
      await expect
        .poll(() => label.evaluate((element) => element.scrollWidth - element.clientWidth))
        .toBeLessThanOrEqual(1);
      await tab.hover();
      await expect
        .poll(() => label.evaluate((element) => element.scrollWidth - element.clientWidth))
        .toBeLessThanOrEqual(1);
    }
    const first = page.getByTestId(`workspace-tab-file_${filenames[0]}`).filter({ visible: true });
    const originalWidth = (await first.boundingBox())?.width;
    await page
      .getByTestId(`workspace-tab-agent_${session.agentId}`)
      .filter({ visible: true })
      .click();
    await page.getByRole("link", { name: longName, exact: true }).click();
    await expectFileTabOpen(page, longName);
    const longTab = page.getByTestId(`workspace-tab-file_${longName}`).filter({ visible: true });
    await expect(longTab).toHaveCSS("width", "360px");
    await expect(longTab).toBeInViewport({ ratio: 1 });
    await expect(longTab.getByText(longName, { exact: true })).toHaveCSS("text-overflow", "clip");
    const scroll = longTab.locator('xpath=ancestor::*[@data-testid="workspace-tabs-scroll"][1]');
    expect(await scroll.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(
      true,
    );
    expect((await first.boundingBox())?.width).toBe(originalWidth);
    const rail = longTab.locator('xpath=ancestor::*[@data-testid="workspace-tabs-row"][1]');
    const plus = rail.getByTestId("workspace-new-tab-button");
    const more = rail.getByTestId("workspace-split-pane-menu");
    const before = { plus: (await plus.boundingBox())?.x, more: (await more.boundingBox())?.x };
    expect(
      await scroll.evaluate(
        (element) =>
          element.querySelector(
            '[data-testid="workspace-new-tab-button"], [data-testid="workspace-split-pane-menu"]',
          ) === null,
      ),
    ).toBe(true);
    await scroll.evaluate((element) => {
      element.scrollLeft = 0;
    });
    await expect.poll(() => scroll.evaluate((element) => element.scrollLeft)).toBe(0);
    expect((await plus.boundingBox())?.x).toBe(before.plus);
    expect((await more.boundingBox())?.x).toBe(before.more);
    await page.screenshot({ path: test.info().outputPath("full-filename-tabs.png") });
  } finally {
    await session.cleanup();
  }
});

test("VS Code-sized shell text leaves chat and editor font preferences independent", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await page.addInitScript((key) => {
    if (window !== window.top) return;
    localStorage.setItem(
      key,
      JSON.stringify({
        uiBaseFontSize: 14,
        contentFontSize: 19,
        codeFontSize: 17,
        editor: { fontSize: 21 },
      }),
    );
  }, APP_SETTINGS_KEY);
  const session = await seedMockAgentWorkspace({
    repoPrefix: "chrome-font-size-",
    title: "Independent UI typography",
    initialPrompt: "Show the typography check.",
    featureValues: { mockAssistantResponse: "Chat typography stays independent." },
  });
  try {
    await writeFile(path.join(session.cwd, "typography.ts"), "export const typography = true;\n");
    await openAgentRoute(page, session);
    await expect(page.getByText("Chat typography stays independent.", { exact: true })).toHaveCSS(
      "font-size",
      "19px",
    );
    await expect(
      page.getByText("New workspace", { exact: true }).filter({ visible: true }).first(),
    ).toHaveCSS("font-size", "13px");
    await openWorkspaceFile(page, "typography.ts");
    const tree = page.getByTestId("file-explorer-tree-scroll");
    await expect(tree.getByText("typography.ts", { exact: true })).toHaveCSS("font-size", "13px");
    await expect(page.getByTestId("files-root-folder-name")).toHaveCSS("font-size", "13px");
    const tab = page.getByTestId("workspace-tab-file_typography.ts").filter({ visible: true });
    await expect(tab.getByText("typography.ts", { exact: true })).toHaveCSS("font-size", "13px");
    const host = page.getByTestId("file-source-editor").filter({ visible: true });
    if (process.env.MIXER_WEB_PLATFORM === "electron")
      await expect(host.frameLocator("iframe").locator(".view-lines")).toHaveCSS(
        "font-size",
        "21px",
      );
    else await expect(host.locator(".cm-editor")).toHaveCSS("font-size", "21px");
    await page.screenshot({ path: test.info().outputPath("vscode-shell-font-size.png") });
    await page
      .getByTestId(`workspace-tab-agent_${session.agentId}`)
      .filter({ visible: true })
      .click();
    await expect(page.getByText("Chat typography stays independent.", { exact: true })).toHaveCSS(
      "font-size",
      "19px",
    );
  } finally {
    await session.cleanup();
  }
});

for (const colorScheme of ["dark", "light"] as const) {
  test(`desktop text selection stays neutral in ${colorScheme} mode`, async ({
    page,
    withWorkspace,
  }) => {
    test.skip(process.env.MIXER_WEB_PLATFORM !== "electron", "Uses Monaco selection rendering");
    await page.emulateMedia({ colorScheme });
    const workspace = await withWorkspace({ prefix: "editor-selection-color-" });
    await writeFile(
      path.join(workspace.repoPath, "selection.ts"),
      'export const selected = "syntax colors stay visible";\nexport const other = true;\n',
    );
    await workspace.navigateTo();
    await openWorkspaceFile(page, "selection.ts");
    const frame = page
      .getByTestId("file-source-editor")
      .filter({ visible: true })
      .frameLocator("iframe");
    await frame.locator(".view-line").first().click();
    await page.keyboard.press("Control+a");
    await expect(frame.locator(".margin-view-overlays .current-line-margin")).toHaveCount(0);
    const selection = frame.locator(".selected-text").first();
    await expect(selection).toBeVisible();
    const color = await selection.evaluate((element) => getComputedStyle(element).backgroundColor);
    const channels = z
      .array(z.coerce.number())
      .length(4)
      .parse(color.match(/[\d.]+/g));
    expect(channels[0]).toBe(channels[1]);
    expect(channels[1]).toBe(channels[2]);
    expect(channels[3]).toBeGreaterThan(0.1);
    expect(channels[3]).toBeLessThan(0.3);
    await page.screenshot({ path: test.info().outputPath(`selection-${colorScheme}.png`) });
    await page.getByTestId("files-root-folder-name").click();
    await expect(selection).toHaveCSS("background-color", color);
  });
}

test("desktop main tabs use a slimmer rail and retain working close controls", async ({
  page,
  withWorkspace,
}) => {
  const workspace = await withWorkspace({ prefix: "slim-editor-tabs-" });
  await writeFile(path.join(workspace.repoPath, "thin.ts"), "export const thin = true;\n");
  await workspace.navigateTo();
  await openWorkspaceFile(page, "thin.ts");
  const tab = page.getByTestId("workspace-tab-file_thin.ts").filter({ visible: true });
  const rail = tab.locator('xpath=ancestor::*[@data-testid="workspace-tabs-row"][1]');
  await expect(tab).toHaveCSS("height", "24px");
  await expect(rail).toHaveCSS("height", "32px");
  await expect(rail).toHaveCSS("border-bottom-width", "0px");
  await expect(
    page.getByTestId("workspace-explorer-sidebar").getByTestId("workspace-tabs-row"),
  ).toHaveCSS("border-bottom-width", "0px");
  const explorerDividers = await page
    .getByTestId("workspace-explorer-sidebar")
    .getByTestId("workspace-tab-files")
    .evaluate((icon) => {
      const dividers: string[] = [];
      let node = icon.parentElement;
      while (node && node.dataset.testid !== "workspace-explorer-sidebar") {
        if (parseFloat(getComputedStyle(node).borderBottomWidth) > 0) dividers.push("border");
        for (const child of node.children) {
          const style = getComputedStyle(child);
          if (
            style.position === "absolute" &&
            parseFloat(style.height) === 1 &&
            style.backgroundColor !== "rgba(0, 0, 0, 0)"
          )
            dividers.push("overlay");
        }
        node = node.parentElement;
      }
      return dividers;
    });
  expect(explorerDividers).toEqual([]);
  await tab.hover();
  const close = page.getByTestId(/^workspace-file-close-/).filter({ visible: true });
  await expect(close).toBeVisible();
  const labelBounds = await tab.getByText("thin.ts", { exact: true }).boundingBox();
  const closeBounds = await close.boundingBox();
  if (!labelBounds || !closeBounds) throw new Error("File label and close control must be visible");
  const closeGap = closeBounds.x - labelBounds.x - labelBounds.width;
  expect(closeGap).toBeGreaterThanOrEqual(0);
  expect(closeGap).toBeLessThanOrEqual(6);
  await page.screenshot({ path: test.info().outputPath("slim-editor-tabs.png") });
  await close.click();
  await expect(tab).toHaveCount(0);
});

async function observeEditorCommands(page: Page) {
  await page.addInitScript(() => {
    if (window === window.top) return;
    const messages: unknown[] = [];
    window.addEventListener("message", (event: MessageEvent<unknown>) => {
      if (event.source !== window.parent || event.origin !== location.origin) return;
      messages.push(event.data);
      document.documentElement.dataset.editorCommands = JSON.stringify(messages);
    });
  });
}

async function configureOpenEditor(
  page: Page,
  preferences: Partial<EditorPreferences>,
  overrides: Partial<Pick<EditorConfiguration, "gitAnnotations">> = {},
) {
  const frame = page
    .getByTestId("file-source-editor")
    .filter({ visible: true })
    .frameLocator("iframe");
  const commands = z
    .array(editorCommandSchema)
    .parse(JSON.parse((await frame.locator("html").getAttribute("data-editor-commands")) ?? "[]"));
  let configuration: EditorConfiguration | null = null;
  for (const command of commands) {
    if (command.type === "configure") configuration = command.configuration;
    if (command.type === "content" && configuration)
      configuration = { ...configuration, ...command };
  }
  if (!configuration) throw new Error("The editor has not received its initial settings");
  const next = {
    ...configuration,
    ...overrides,
    preferences: { ...configuration.preferences, ...preferences },
  };
  await frame.locator("body").evaluate((_body, updatedConfiguration) => {
    window.dispatchEvent(
      new MessageEvent("message", {
        source: window.parent,
        origin: location.origin,
        data: { type: "configure", configuration: updatedConfiguration },
      }),
    );
  }, next);
}

test("desktop editor settings update the live frame without resetting detected indentation or undo", async ({
  page,
  withWorkspace,
}) => {
  test.skip(
    process.env.MIXER_WEB_PLATFORM !== "electron",
    "Uses Monaco's live configuration boundary",
  );
  test.setTimeout(120_000);
  await observeEditorCommands(page);
  const workspace = await withWorkspace({ prefix: "editor-settings-live-" });
  const filename = path.join(workspace.repoPath, "audit.ts");
  const content = `export function audit(value: number) {\n  const repeated = value;\n  return { value: repeated, nested: [[value]] };\n}\n// ${"long ".repeat(80)}\n`;
  await writeFile(filename, content);
  await workspace.navigateTo();
  await openWorkspaceFile(page, "audit.ts");
  const frame = page
    .getByTestId("file-source-editor")
    .filter({ visible: true })
    .frameLocator("iframe");
  await expect(frame.locator(".view-lines")).toBeVisible();
  await frame.locator("html").evaluate((element) => {
    element.dataset.retainedEditor = "yes";
  });
  const edited = content.replace(/^  /gm, "    ");
  await writeFile(filename, edited);
  await expect
    .poll(async () => {
      const commands = z
        .array(editorCommandSchema)
        .parse(
          JSON.parse((await frame.locator("html").getAttribute("data-editor-commands")) ?? "[]"),
        );
      const latest = commands.findLast((command) => command.type === "content");
      return latest?.type === "content" ? latest.content : null;
    })
    .toBe(edited);
  await configureOpenEditor(page, {
    fontSize: 19,
    fontFamily: "monospace",
    lineHeight: 2,
    letterSpacing: 1.5,
    fontLigatures: true,
    wordWrap: "on",
    lineNumbers: "relative",
    renderWhitespace: "all",
    renderLineHighlight: "line",
    folding: false,
    minimap: true,
    stickyScroll: true,
    rainbowBrackets: false,
    bracketPairGuides: false,
    indentationGuides: false,
    matchBrackets: false,
    cursorStyle: "block",
    cursorBlinking: "solid",
    smoothCaret: true,
    smoothScrolling: true,
    scrollBeyondLastLine: false,
    mouseWheelZoom: true,
    autoClosingBrackets: false,
    autoClosingQuotes: false,
    quickSuggestions: false,
    suggestOnTriggerCharacters: false,
    parameterHints: false,
    selectionHighlight: false,
  });
  await expect(frame.locator(".view-lines")).toHaveCSS("font-size", "19px");
  await expect(frame.locator(".view-lines")).toHaveCSS("line-height", "38px");
  await expect(frame.locator(".view-lines")).toHaveCSS("letter-spacing", "1.5px");
  await expect(frame.locator(".view-lines")).toHaveCSS("font-family", /monospace/);
  await expect(frame.locator(".view-lines")).toHaveCSS("font-feature-settings", /liga/);
  await expect(frame.locator(".minimap")).toBeVisible();
  await expect(frame.locator('[class*="bracket-highlighting-"]')).toHaveCount(0);
  await expect(frame.locator(".codicon-folding-expanded, .codicon-folding-collapsed")).toHaveCount(
    0,
  );
  await expect(frame.locator("html")).toHaveAttribute("data-retained-editor", "yes");
  await frame
    .locator(".view-line")
    .first()
    .click({ position: { x: 1, y: 5 } });
  await page.keyboard.press("Home");
  await expect(frame.locator(".view-overlays .current-line")).not.toHaveCSS(
    "background-color",
    "rgba(0, 0, 0, 0)",
  );
  await page.keyboard.press("Tab");
  await page.keyboard.press("Control+s");
  await expect.poll(() => readFile(filename, "utf8")).toBe(`  ${edited}`);
  await page.keyboard.press("Control+z");
  await page.keyboard.press("Control+s");
  await expect.poll(() => readFile(filename, "utf8")).toBe(edited);
  await configureOpenEditor(page, { detectIndentation: false, tabSize: 3, insertSpaces: false });
  await frame
    .locator(".view-line")
    .first()
    .click({ position: { x: 1, y: 5 } });
  await page.keyboard.press("Home");
  await page.keyboard.press("Tab");
  await page.keyboard.press("Control+s");
  await expect.poll(() => readFile(filename, "utf8")).toBe(`\t${edited}`);
  await page.keyboard.press("Control+z");
  await page.keyboard.press("Control+s");
  await expect.poll(() => readFile(filename, "utf8")).toBe(edited);
  await configureOpenEditor(page, {
    rainbowBrackets: true,
    bracketPairGuides: true,
    indentationGuides: true,
    folding: true,
    minimap: false,
    wordWrap: "off",
    renderLineHighlight: "none",
  });
  await expect(frame.locator('[class*="bracket-highlighting-"]').first()).toBeVisible();
  await expect(frame.locator(".codicon-folding-expanded").first()).toBeAttached();
  await expect(frame.locator(".minimap")).not.toBeVisible();
  await expect(frame.locator(".view-overlays .current-line")).toHaveCount(0);
  expect(await readFile(filename, "utf8")).toBe(edited);
  await frame
    .locator(".view-line")
    .last()
    .click({ position: { x: 1, y: 5 } });
  await page.keyboard.press("End");
  await page.keyboard.type('("');
  await page.keyboard.press("Control+s");
  await expect.poll(() => readFile(filename, "utf8")).toBe(`${edited}("`);
  await page.keyboard.press("Backspace");
  await page.keyboard.press("Backspace");
  await page.keyboard.press("Control+s");
  await expect.poll(() => readFile(filename, "utf8")).toBe(edited);
  await configureOpenEditor(page, { autoClosingBrackets: true, autoClosingQuotes: true });
  await page.keyboard.type('("');
  await page.keyboard.press("Control+s");
  await expect.poll(() => readFile(filename, "utf8")).toBe(`${edited}("")`);
});

test("browser trailing whitespace uses markers rather than an error background", async ({
  page,
  withWorkspace,
}) => {
  test.skip(process.env.MIXER_WEB_PLATFORM === "electron", "Uses CodeMirror whitespace rendering");
  const workspace = await withWorkspace({ prefix: "editor-whitespace-" });
  await writeFile(path.join(workspace.repoPath, "whitespace.ts"), "const visible = true;    \n");
  await page.goto("/settings/editor");
  await page.getByRole("button", { name: "Whitespace: None", exact: true }).click();
  await page.getByRole("menuitem", { name: "Trailing", exact: true }).click();
  await workspace.navigateTo();
  await openWorkspaceFile(page, "whitespace.ts");
  const marks = page
    .getByTestId("file-source-editor")
    .filter({ visible: true })
    .locator(".cm-trailingSpace");
  await expect(marks).toHaveJSProperty("textContent", "    ");
  await expect(marks).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await expect(marks).toHaveCSS("background-image", /radial-gradient/);
});

test("editor preferences persist and control the workspace source editor", async ({
  page,
  withWorkspace,
}) => {
  test.setTimeout(120_000);
  const desktop = process.env.MIXER_WEB_PLATFORM === "electron";
  const workspace = await withWorkspace({ prefix: "editor-preferences-" });
  const filename = path.join(workspace.repoPath, "preferences.ts");
  const content = "export function example() {\n    return { nested: [1, 2, 3] };\n}\n";
  await writeFile(filename, content);
  await page.goto("/settings/editor");
  await page.getByRole("textbox", { name: "Font size (px)", exact: true }).fill("19");
  await page.getByRole("textbox", { name: "Font family", exact: true }).fill("monospace");
  await page.getByRole("textbox", { name: "Line height (multiplier)", exact: true }).fill("2");
  await page.getByRole("textbox", { name: "Tab size", exact: true }).fill("2");
  await page.getByRole("button", { name: "Line numbers: On", exact: true }).click();
  await page.getByRole("menuitem", { name: "Off", exact: true }).click();
  await page
    .getByRole("button", { name: "Word wrap: Automatic (wrap Markdown)", exact: true })
    .click();
  await page.getByRole("menuitem", { name: "On", exact: true }).click();
  if (desktop) {
    await page.getByRole("switch", { name: "Rainbow brackets", exact: true }).click();
    await page.getByRole("switch", { name: "Bracket pair guides", exact: true }).click();
    await page.getByRole("switch", { name: "Detect indentation from file", exact: true }).click();
    await page.getByRole("switch", { name: "Minimap", exact: true }).click();
  }
  await page.screenshot({ path: test.info().outputPath("editor-settings.png"), fullPage: true });
  await page.reload();
  await expect(page.getByRole("textbox", { name: "Font size (px)", exact: true })).toHaveValue(
    "19",
  );
  await expect(page.getByRole("button", { name: "Line numbers: Off", exact: true })).toBeVisible();
  if (desktop)
    await expect(
      page.getByRole("switch", { name: "Rainbow brackets", exact: true }),
    ).not.toBeChecked();
  await workspace.navigateTo();
  await openWorkspaceFile(page, "preferences.ts");
  const host = page.getByTestId("file-source-editor").filter({ visible: true });
  if (desktop) {
    const frame = host.frameLocator("iframe");
    await expect(frame.locator(".view-lines")).toHaveCSS("font-size", "19px");
    await expect(frame.locator(".view-lines")).toHaveCSS("line-height", "38px");
    await expect(frame.locator(".minimap")).toBeVisible();
    await expect(frame.locator(".line-numbers")).toHaveCount(0);
    await expect(frame.locator('[class*="bracket-highlighting-"]')).toHaveCount(0);
  } else {
    await expect(host.locator(".cm-editor")).toHaveCSS("font-size", "19px");
    await expect(host.locator(".cm-scroller")).toHaveCSS("line-height", "38px");
    await expect(host.locator(".cm-lineNumbers")).toHaveCount(0);
    await expect(host.locator(".cm-content")).toHaveClass(/cm-lineWrapping/);
  }
  expect(await readFile(filename, "utf8")).toBe(content);
  const firstLine = desktop
    ? host.frameLocator("iframe").locator(".view-line").first()
    : host.locator(".cm-line").first();
  await firstLine.click({ position: { x: 1, y: 5 } });
  await page.keyboard.press("Home");
  const modifier = desktop
    ? "Control"
    : await page.evaluate(() => (/Mac/.test(navigator.platform) ? "Meta" : "Control"));
  await page.keyboard.press("Tab");
  await page.keyboard.press(`${modifier}+s`);
  await expect.poll(() => readFile(filename, "utf8")).toBe(`  ${content}`);
  await page.keyboard.press(`${modifier}+z`);
  await page.keyboard.press(`${modifier}+s`);
  await expect.poll(() => readFile(filename, "utf8")).toBe(content);
  await page.goto("/settings/editor");
  await page.getByRole("button", { name: "Reset", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Font size (px)", exact: true })).toHaveValue("");
  await expect(page.getByRole("button", { name: "Line numbers: On", exact: true })).toBeVisible();
  await workspace.navigateTo();
  await openWorkspaceFile(page, "preferences.ts");
  if (desktop)
    await expect(
      page
        .getByTestId("file-source-editor")
        .filter({ visible: true })
        .frameLocator("iframe")
        .locator(".line-numbers")
        .first(),
    ).toBeVisible();
  else
    await expect(
      page.getByTestId("file-source-editor").filter({ visible: true }).locator(".cm-lineNumbers"),
    ).toBeVisible();
  expect(await readFile(filename, "utf8")).toBe(content);
});
const syntaxPaintSchema = z.object({
  commentColors: z.number(),
  codeColors: z.number(),
  commentColor: z.string().min(1),
  referenceColor: z.string().min(1),
});

async function observeFirstSyntaxPaint(page: Page, engine: "monaco" | "codemirror" = "monaco") {
  await page.addInitScript((kind) => {
    const native = kind === "monaco";
    if (native && window === window.top) return;
    if (
      !native &&
      (window !== window.top || sessionStorage.getItem("mixer-test-syntax") !== "enabled")
    )
      return;
    // Busy renderers can postpone idle tokenization. The opening viewport must not depend on it.
    const idle = window.requestIdleCallback.bind(window);
    const cancelIdle = window.cancelIdleCallback.bind(window);
    window.requestIdleCallback = (callback, options) => {
      if (!native && !document.querySelector('[data-testid="file-source-editor"]'))
        return idle(callback, options);
      return -1;
    };
    window.cancelIdleCallback = (id) => {
      if (id !== -1) cancelIdle(id);
    };
    function inspect() {
      const host = native
        ? document.getElementById("editor")
        : document.querySelector('[data-testid="file-source-editor"]');
      const frame = window.frameElement;
      const container = native
        ? frame?.parentElement?.parentElement
        : host?.parentElement?.parentElement;
      const covered = container?.querySelector('[data-testid="file-preview-loading"]');
      const lines = [
        ...document.querySelectorAll(native ? ".view-lines .view-line" : ".cm-content .cm-line"),
      ];
      // Monaco can render spaces as visible glyphs. Match semantic characters, not those glyphs.
      const compact = (line: Element) => (line.textContent ?? "").replace(/[^a-zA-Z0-9_]/g, "");
      const comment = lines.find((line) => compact(line) === "constinsidetext");
      const code = lines.find((line) => compact(line) === "exportconstsyntaxReady42");
      const reference = lines.find((line) => compact(line) === "referencecomment");
      const bounds = (native ? frame : host)?.getBoundingClientRect();
      if (
        host &&
        bounds &&
        !covered &&
        bounds.height > 0 &&
        getComputedStyle(host).visibility !== "hidden" &&
        comment &&
        code &&
        reference
      ) {
        const colors = (line: Element) => {
          const result = new Set<string>();
          const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
          let node = walker.nextNode();
          while (node) {
            if (/[a-zA-Z0-9_]/.test(node.textContent ?? "") && node.parentElement)
              result.add(getComputedStyle(node.parentElement).color);
            node = walker.nextNode();
          }
          return [...result];
        };
        const commentColors = colors(comment);
        document.documentElement.dataset.firstSyntaxPaint = JSON.stringify({
          commentColors: commentColors.length,
          codeColors: colors(code).length,
          commentColor: commentColors[0],
          referenceColor: colors(reference)[0],
        });
        return;
      }
      requestAnimationFrame(inspect);
    }
    requestAnimationFrame(inspect);
  }, engine);
}

async function editorRecords(page: Page, name: "drafts" | "views") {
  return page.evaluate(readEditorRecords, name);
}

function readEditorRecords(storeName: "drafts" | "views") {
  return new Promise<{ key: string; value: unknown }[]>((resolve, reject) => {
    const request = indexedDB.open("mixer-editor");
    request.addEventListener("error", () => reject(request.error));
    function opened() {
      const db = request.result;
      if (!db.objectStoreNames.contains(storeName)) {
        db.close();
        resolve([]);
        return;
      }
      const tx = db.transaction(storeName, "readonly");
      const store = tx.objectStore(storeName);
      const values: IDBRequest<unknown[]> = store.getAll();
      const keys = store.getAllKeys();
      function complete() {
        resolve(
          keys.result.map((key, index) => ({ key: String(key), value: values.result[index] })),
        );
        db.close();
      }
      tx.addEventListener("complete", complete);
      tx.addEventListener("error", () => {
        reject(tx.error);
        db.close();
      });
    }
    request.addEventListener("success", opened);
  });
}

async function savedEditorViews(page: Page, filePath: string) {
  return (await editorRecords(page, "views"))
    .filter((record) => record.key.includes(filePath))
    .map((record) => record.value);
}
async function savedEditorDrafts(page: Page) {
  return (await editorRecords(page, "drafts")).map((record) => record.value);
}

test.describe("Monaco Electron file editing", () => {
  test.skip(process.env.MIXER_WEB_PLATFORM !== "electron", "Uses the Electron editor overlay");
  for (const colorScheme of ["dark", "light"] as const) {
    test(`changes language mode from the right status bar with a VS Code-style quick picker in ${colorScheme} without losing edits or undo`, async ({
      page,
      withWorkspace,
    }) => {
      test.setTimeout(120_000);
      const ariaWarnings: string[] = [];
      page.on("console", (message) => {
        if (message.text().includes("Invalid ARIA attribute")) ariaWarnings.push(message.text());
      });
      await page.addInitScript((theme) => {
        localStorage.setItem("@mixer:app-settings", JSON.stringify({ theme }));
      }, colorScheme);
      const gate = await installDaemonWebSocketGate(page);
      const workspace = await withWorkspace({ prefix: "editor-language-mode-" });
      const filename = path.join(workspace.repoPath, "Example.ts");
      const original =
        'public class Example {\n  public static void main(String[] args) { System.out.println("kept"); }\n}\n';
      await writeFile(filename, original);
      await workspace.navigateTo();
      await openFileExplorer(page);
      await openFileFromExplorer(page, "Example.ts");
      const frame = page
        .getByTestId("file-source-editor")
        .filter({ visible: true })
        .frameLocator("iframe");
      const trigger = page.getByTestId("status-bar-language-mode");
      await expect(trigger).toHaveText("TypeScript", { timeout: 30_000 });
      const tabs = page.getByTestId("workspace-tabs-row").filter({ visible: true }).first();
      // Simulate window chrome above the tab strip; the picker must follow the panel, not the viewport.
      await tabs.evaluate((element) => {
        element.style.marginTop = "48px";
      });
      const origin = await frame.locator("#editor").evaluate(() => performance.timeOrigin);
      gate.holdNextClientRequest("fs.file.write.request");
      await frame.getByRole("textbox").focus();
      await page.keyboard.press("Control+Home");
      await page.keyboard.insertText("// unsaved\n");
      await gate.waitForHeldClientRequest();
      await trigger.click();
      const picker = page.getByTestId("combobox-desktop-container");
      await expect(picker.getByRole("button", { name: "Auto Detect", exact: true })).toBeVisible();
      await expect(picker.locator("[arialabel]")).toHaveCount(0);
      expect(ariaWarnings).toEqual([]);
      const box = await picker.boundingBox();
      const viewport = page.viewportSize();
      if (!box || !viewport) throw new Error("Missing picker viewport");
      const tabsBox = await tabs.boundingBox();
      const panelBox = await page
        .getByTestId("file-source-editor")
        .filter({ visible: true })
        .evaluate((element) => {
          const panel = element.closest("[data-editor-pane]");
          if (!panel) throw new Error("Missing editor pane");
          const rect = panel.getBoundingClientRect();
          return { x: rect.left, width: rect.width };
        });
      if (!tabsBox) throw new Error("Missing editor tab strip");
      expect(Math.abs(box.y - tabsBox.y - 12)).toBeLessThan(2);
      expect(Math.abs(box.x + box.width / 2 - panelBox.x - panelBox.width / 2)).toBeLessThan(2);
      const statusBox = await trigger.boundingBox();
      if (!statusBox) throw new Error("Missing status entry");
      expect(statusBox.x).toBeGreaterThan(viewport.width / 2);
      await page.screenshot({
        path: test.info().outputPath(`language-mode-picker-${colorScheme}.png`),
      });
      await page.getByPlaceholder("Select Language Mode", { exact: true }).fill("java");
      await page.keyboard.press("Enter");
      await expect(trigger).toHaveText("Java");
      await expect(frame.locator(".view-lines")).toContainText("// unsaved");
      await expect
        .poll(() => frame.locator(".view-lines").evaluate(distinctSourceColorCount))
        .toBeGreaterThan(2);
      expect(await frame.locator("#editor").evaluate(() => performance.timeOrigin)).toBe(origin);
      expect(await readFile(filename, "utf8")).toBe(original);
      await trigger.click();
      await page.getByPlaceholder("Select Language Mode", { exact: true }).fill("Plain Text");
      await page.getByTestId("language-mode-option-plaintext").click();
      await expect(trigger).toHaveText("Plain Text");
      await expect
        .poll(() => frame.locator(".view-lines").evaluate(distinctSourceColorCount))
        .toBe(1);
      await trigger.click();
      await page.keyboard.press("Escape");
      await expect(picker).toHaveCount(0);
      await expect(trigger).toHaveText("Plain Text");
      await trigger.click();
      await page.getByTestId("language-mode-option-auto").click();
      await expect(trigger).toHaveText("TypeScript");
      gate.releaseHeldClientRequest();
      await expect.poll(() => readFile(filename, "utf8")).toContain("// unsaved");
      await frame.getByRole("textbox").focus();
      await page.keyboard.press("Control+z");
      await expect(frame.locator(".view-lines")).not.toContainText("// unsaved");
      expect(await frame.locator("#editor").evaluate(() => performance.timeOrigin)).toBe(origin);
      await expect.poll(() => readFile(filename, "utf8")).toBe(original);
      await page.getByTestId("workspace-new-tab-button").filter({ visible: true }).click();
      await page.getByRole("menuitem", { name: /^Agent/ }).click();
      await expect(trigger).toHaveCount(0);
    });
  }
  test("persists file associations from the language picker and applies them to other matching files", async ({
    page,
    withWorkspace,
  }) => {
    test.setTimeout(120_000);
    const workspace = await withWorkspace({ prefix: "editor-language-association-" });
    const content = 'public class Example { String value = "kept"; }\n';
    await writeFile(path.join(workspace.repoPath, "one.demo"), content);
    await writeFile(path.join(workspace.repoPath, "two.demo"), content);
    await workspace.navigateTo();
    await openFileExplorer(page);
    await openFileFromExplorer(page, "one.demo");
    const trigger = page.getByTestId("status-bar-language-mode");
    await expect(trigger).toHaveText("Plain Text", { timeout: 30_000 });
    await trigger.click();
    await page.getByTestId("language-mode-option-association").click();
    await page.getByPlaceholder("Select Language Mode for '.demo'", { exact: true }).fill("java");
    await page.getByTestId("language-mode-option-java").click();
    await expect(trigger).toHaveText("Java");
    expect(
      await page.evaluate(
        () =>
          JSON.parse(localStorage.getItem("@mixer:app-settings") ?? "{}").editor.fileAssociations[
            ".demo"
          ],
      ),
    ).toBe("java");
    await openFileFromExplorer(page, "two.demo");
    await expect(trigger).toHaveText("Java");
    const frame = page
      .getByTestId("file-source-editor")
      .filter({ visible: true })
      .frameLocator("iframe");
    await expect
      .poll(() => frame.locator(".view-lines").evaluate(distinctSourceColorCount))
      .toBeGreaterThan(2);
    await trigger.click();
    await page.getByTestId("language-mode-option-association").click();
    await page.getByTestId("language-mode-option-clear").click();
    await expect(trigger).toHaveText("Plain Text");
    expect(await readFile(path.join(workspace.repoPath, "one.demo"), "utf8")).toBe(content);
    expect(await readFile(path.join(workspace.repoPath, "two.demo"), "utf8")).toBe(content);
  });
  test("automatically selects and highlights Java and Rust without requiring a language server", async ({
    page,
    withWorkspace,
  }) => {
    test.setTimeout(120_000);
    const workspace = await withWorkspace({ prefix: "editor-popular-languages-" });
    await writeFile(
      path.join(workspace.repoPath, "Example.java"),
      'public class Example { private String value = "hello"; }\n',
    );
    await writeFile(
      path.join(workspace.repoPath, "main.rs"),
      'fn main() { let message = "hello"; println!("{}", message); }\n',
    );
    await workspace.navigateTo();
    await openFileExplorer(page);
    await openFileFromExplorer(page, "Example.java");
    await expect(page.getByTestId("status-bar-language-mode")).toHaveText("Java", {
      timeout: 30_000,
    });
    const frame = page
      .getByTestId("file-source-editor")
      .filter({ visible: true })
      .frameLocator("iframe");
    await expect
      .poll(() => frame.locator(".view-lines").evaluate(distinctSourceColorCount))
      .toBeGreaterThan(2);
    await openFileFromExplorer(page, "main.rs");
    await expect(page.getByTestId("status-bar-language-mode")).toHaveText("Rust");
    await expect
      .poll(() => frame.locator(".view-lines").evaluate(distinctSourceColorCount))
      .toBeGreaterThan(2);
  });
  test("keeps a long Git blame hover inside the editor viewport above the status bar", async ({
    page,
    withWorkspace,
  }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 1280, height: 520 });
    const gate = await installDaemonWebSocketGate(page);
    gate.transformServerMessages(enrichEditorCommitFixture);
    const workspace = await withWorkspace({ prefix: "git-blame-hover-bounds-" });
    await writeFile(
      path.join(workspace.repoPath, "long-history.ts"),
      Array.from({ length: 60 }, (_, index) => `export const value${index} = ${index};`).join("\n"),
    );
    const message =
      "Change second line (#113)\n\n" +
      Array.from(
        { length: 45 },
        (_, index) => `* Change ${index}: detailed commit history entry`,
      ).join("\n") +
      "\n\nEnd of long commit";
    execFileSync("git", ["add", "long-history.ts"], { cwd: workspace.repoPath });
    execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-m", message], {
      cwd: workspace.repoPath,
    });
    await workspace.navigateTo();
    await openFileExplorer(page);
    await openFileFromExplorer(page, "long-history.ts");
    const iframe = page
      .getByTestId("file-source-editor")
      .filter({ visible: true })
      .locator("iframe");
    const frame = iframe.contentFrame();
    await expect(frame.locator("#editor")).toHaveAttribute("data-git-state", "ready", {
      timeout: 30_000,
    });
    await frame.getByRole("textbox").focus();
    await page.keyboard.press("Control+Home");
    for (let index = 0; index < 20; index++) await page.keyboard.press("ArrowDown");
    await page.keyboard.press("End");
    const annotation = frame.locator(".mixer-git-inline").first();
    await expect(annotation).toContainText("via PR #113", { timeout: 30_000 });
    await annotation.hover({ position: { x: 45, y: 8 } });
    const hover = frame.locator(".monaco-hover").filter({ visible: true });
    await expect(hover).toContainText("End of long commit");
    await expect
      .poll(async () => {
        const bounds = await hover.boundingBox();
        const viewport = await iframe.boundingBox();
        if (!bounds || !viewport) return false;
        return bounds.y >= viewport.y && bounds.y + bounds.height <= viewport.y + viewport.height;
      })
      .toBe(true);
    await hover.hover();
    await expect
      .poll(async () => {
        await page.mouse.wheel(0, 600);
        return hover.getByTitle("Copy SHA").evaluate(isInsideHoverViewport);
      })
      .toBe(true);
    await expect(hover.getByTitle("Copy SHA")).toBeInViewport();
    await page.screenshot({
      path: test.info().outputPath("long-git-blame-hover-above-status-bar.png"),
    });
  });
  test("keeps TypeScript language services on older hosts without requesting provider discovery", async ({
    page,
    withWorkspace,
  }) => {
    test.setTimeout(120_000);
    const gate = await installDaemonWebSocketGate(page);
    gate.transformServerMessages(stripLanguageProviderCapability);
    const workspace = await withWorkspace({ prefix: "editor-legacy-language-" });
    await writeFile(
      path.join(workspace.repoPath, "legacy.ts"),
      "const value = { preserved: 1 };\nvalue.\n",
    );
    await workspace.navigateTo();
    await openFileExplorer(page);
    await openFileFromExplorer(page, "legacy.ts");
    const frame = page
      .getByTestId("file-source-editor")
      .filter({ visible: true })
      .frameLocator("iframe");
    await expect(frame.locator("#editor")).toHaveAttribute("data-language-service", "typescript", {
      timeout: 30_000,
    });
    expect(gate.getClientRequestCount("workspace.language.providers.request")).toBe(0);
    await frame.getByRole("textbox").focus();
    await page.keyboard.press("Control+Home");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("End");
    await page.keyboard.press("Control+Space");
    await expect(frame.locator(".suggest-widget.visible")).toContainText("preserved");
  });
  test("uses a discovered C language server for project-aware completion without replacing the editor", async ({
    page,
    withWorkspace,
  }) => {
    test.skip(!existsSync("/usr/bin/clangd"), "Requires the host's clangd toolchain");
    test.setTimeout(120_000);
    const workspace = await withWorkspace({ prefix: "editor-clangd-" });
    await writeFile(
      path.join(workspace.repoPath, "main.c"),
      "struct User { int loyaltyPoints; };\nint main(void) {\n  struct User user;\n  user.\n}\n",
    );
    await workspace.navigateTo();
    await openFileExplorer(page);
    await openFileFromExplorer(page, "main.c");
    const frame = page
      .getByTestId("file-source-editor")
      .filter({ visible: true })
      .frameLocator("iframe");
    await expect(frame.locator("#editor")).toHaveAttribute("data-language-service", "clangd", {
      timeout: 30_000,
    });
    const origin = await frame.locator("#editor").evaluate(() => performance.timeOrigin);
    await frame.getByRole("textbox").focus();
    await page.keyboard.press("Control+Home");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("End");
    await page.keyboard.press("Control+Space");
    await expect(frame.locator(".suggest-widget.visible")).toContainText("loyaltyPoints", {
      timeout: 30_000,
    });
    expect(await frame.locator("#editor").evaluate(() => performance.timeOrigin)).toBe(origin);
  });
  for (const colorScheme of ["dark", "light"] as const) {
    test(`shows GitLens-style authorship, current-line blame and commit hover in ${colorScheme} without losing unsaved edits`, async ({
      page,
      withWorkspace,
    }) => {
      test.setTimeout(120_000);
      await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
      await observeEditorCommands(page);
      await page.addInitScript((theme) => {
        localStorage.setItem("@mixer:app-settings", JSON.stringify({ theme }));
      }, colorScheme);
      const gate = await installDaemonWebSocketGate(page);
      gate.transformServerMessages(enrichEditorCommitFixture);
      const workspace = await withWorkspace({ prefix: "editor-git-history-" });
      const filename = path.join(workspace.repoPath, "history.ts");
      const original = "const first = 1;\nconst second = 2;\nconsole.log(first, second);\n";
      const modified = original.replace("second = 2", "second = 3");
      const git = (args: string[]) =>
        execFileSync("git", args, { cwd: workspace.repoPath, encoding: "utf8" });
      await writeFile(filename, original);
      git(["add", "--", "history.ts"]);
      git([
        "-c",
        "user.name=Alice",
        "-c",
        "user.email=alice@example.test",
        "-c",
        "commit.gpgsign=false",
        "commit",
        "-m",
        "Add history fixture",
      ]);
      await writeFile(filename, modified);
      git(["add", "--", "history.ts"]);
      git([
        "-c",
        "user.name=Bob",
        "-c",
        "user.email=bob@example.test",
        "-c",
        "commit.gpgsign=false",
        "commit",
        "-m",
        "Change second line (#113)\n\nSigned-off-by: Bob <bob@example.test>\n\nCo-authored-by: Carol <carol@example.test>",
      ]);
      const sha = git(["rev-parse", "HEAD"]).trim();
      await workspace.navigateTo();
      await openFileExplorer(page);
      await openFileFromExplorer(page, "history.ts");
      const surface = page.getByTestId("file-source-editor").filter({ visible: true });
      const frame = surface.frameLocator("iframe");
      await expect(frame.locator("#editor")).toHaveAttribute("data-git-state", "ready", {
        timeout: 30_000,
      });
      await expect(frame.locator(".codelens-decoration")).toContainText(
        "2 authors (Alice and others)",
      );
      await frame.locator(".codelens-decoration a").first().click();
      await expect(frame.locator("#editor")).toHaveAttribute("data-git-line-author", "Bob");
      const timeOrigin = await frame.locator("#editor").evaluate(() => performance.timeOrigin);
      await frame.getByRole("textbox").focus();
      await page.keyboard.press("Control+Home");
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("End");
      await expect(frame.locator("#editor")).toHaveAttribute("data-git-line-author", "Bob");
      await expect(frame.locator("#editor")).toHaveAttribute("data-git-commit", sha);
      const activeLine = frame.locator(".view-overlays .current-line").first();
      await expect(activeLine).toHaveCSS(
        "background-color",
        colorScheme === "dark" ? "rgb(39, 42, 46)" : "rgb(234, 238, 242)",
      );
      expect(
        await activeLine.evaluate((element) => element.getBoundingClientRect().width > 400),
      ).toBe(true);
      await page.getByTestId("workspace-new-tab-button").filter({ visible: true }).focus();
      await expect(activeLine).toBeVisible();
      await expect(activeLine).toHaveCSS(
        "background-color",
        colorScheme === "dark" ? "rgb(39, 42, 46)" : "rgb(234, 238, 242)",
      );
      await frame.getByRole("textbox").focus();
      const annotation = frame.locator(".mixer-git-inline").first();
      await expect(annotation).toContainText("Bob,");
      await expect(annotation).toContainText("via PR #113", { timeout: 30_000 });
      const blameRequests = gate.getClientRequestCount("workspace.git.blame.request");
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("ArrowUp");
      expect(gate.getClientRequestCount("workspace.git.blame.request")).toBe(blameRequests);
      await annotation.hover({ position: { x: 60, y: 8 } });
      const hover = frame.locator(".monaco-hover").filter({ visible: true });
      await expect(hover).toContainText("Co-authored-by: Carol");
      await expect(hover).not.toContainText("Signed-off-by:");
      await expect(hover).not.toContainText("merged");
      await expect(hover).toContainText("GitHub Issue or Pull Request #113");
      await expect(hover).toContainText("const second = 3;");
      await expect(hover.locator(".monaco-tokenized-source")).not.toContainText("const first");
      await expect(hover.locator(".monaco-tokenized-source")).not.toContainText("console.log");
      await expect(hover.getByRole("img", { name: "Author avatar" })).toBeVisible();
      const cardAlignment = await hover.evaluate(gitHoverAlignment);
      expect(cardAlignment).toEqual([0, 0]);
      await expect.poll(() => hover.evaluate(gitHoverDiffIsColored)).toBe(true);
      await test.info().attach("git-hover.html", {
        body: await hover.evaluate((element) => element.outerHTML),
        contentType: "text/html",
      });
      await page.screenshot({
        path: test.info().outputPath(`git-line-history-${colorScheme}.png`),
      });
      await hover.getByTitle("Copy SHA").click();
      await expect(page.getByText("Copied Commit SHA", { exact: true })).toBeVisible();
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(sha);
      await page.keyboard.press("Escape");
      await page.getByTestId("workspace-new-tab-button").filter({ visible: true }).focus();
      gate.holdNextServerMessage("workspace.git.blame.response");
      await frame.getByRole("textbox").focus();
      await gate.waitForHeldServerMessage("workspace.git.blame.response");
      gate.holdNextClientRequest("fs.file.write.request");
      await page.keyboard.press("Control+Home");
      await page.keyboard.insertText("// unsaved\n");
      await page.keyboard.press("Control+Home");
      await page.keyboard.press("End");
      await gate.waitForHeldClientRequest();
      await expect(frame.locator("#editor")).toHaveAttribute(
        "data-git-line-author",
        "Not Committed Yet",
        { timeout: 30_000 },
      );
      expect(await readFile(filename, "utf8")).toBe(modified);
      gate.releaseHeldServerMessage("workspace.git.blame.response");
      await expect(frame.locator("#editor")).toHaveAttribute("data-git-commit", "0".repeat(40));
      gate.releaseHeldClientRequest();
      await expect.poll(() => readFile(filename, "utf8")).toContain("// unsaved");
      await page.keyboard.press("Control+z");
      await expect(frame.locator(".view-lines")).not.toContainText("// unsaved");
      await configureOpenEditor(page, { gitBlame: false, gitCodeLens: false, gitHover: false });
      await expect(annotation).toHaveCount(0);
      await expect(frame.locator(".codelens-decoration")).toHaveCount(0);
      expect(await frame.locator("#editor").evaluate(() => performance.timeOrigin)).toBe(
        timeOrigin,
      );
      const disabledRequests = gate.getClientRequestCount("workspace.git.blame.request");
      await configureOpenEditor(
        page,
        { gitBlame: true, gitCodeLens: true, gitHover: true },
        { gitAnnotations: false },
      );
      await expect(annotation).toContainText("Update host for Git history");
      expect(gate.getClientRequestCount("workspace.git.blame.request")).toBe(disabledRequests);
      await configureOpenEditor(
        page,
        { gitBlame: true, gitCodeLens: true, gitHover: true },
        { gitAnnotations: true },
      );
      await expect(frame.locator(".codelens-decoration")).toContainText("2 authors");
    });
  }

  test("Files preloads syntax resources without starting editors or language workers", async ({
    page,
    withWorkspace,
  }) => {
    const gate = await installDaemonWebSocketGate(page);
    const workers: string[] = [];
    page.on("worker", (worker) => {
      if (worker.url().includes("/monaco/")) workers.push(worker.url());
    });
    const workspace = await withWorkspace({ prefix: "editor-syntax-preload-" });
    await workspace.navigateTo();
    await openFileExplorer(page);
    await expect(
      page.locator('head link[data-mixer-editor-preload][href="/monaco/editor.js"]'),
    ).toBeAttached();
    await expect(
      page.locator('head link[data-mixer-editor-preload][href="/monaco/editor.css"]'),
    ).toHaveAttribute("as", "style");
    await expect(
      page.locator('head link[data-mixer-editor-preload][href="/monaco/editor.css"]'),
    ).toHaveAttribute("rel", "prefetch");
    expect(
      await page.locator('head link[rel="modulepreload"][data-mixer-editor-preload]').count(),
    ).toBeGreaterThanOrEqual(10);
    await expect(
      page.locator('head link[as="font"][data-mixer-editor-preload]').first(),
    ).toHaveAttribute("crossorigin", "anonymous");
    await expect(
      page.locator('head link[as="font"][data-mixer-editor-preload]').first(),
    ).toHaveAttribute("rel", "prefetch");
    await expect(page.locator('head link[rel="preload"][data-mixer-editor-preload]')).toHaveCount(
      0,
    );
    await expect(page.getByTestId("file-source-editor")).toHaveCount(0);
    expect(gate.getClientRequestCount("workspace.language.query.request")).toBe(0);
    expect(workers).toEqual([]);
  });

  test("the first visible syntax paint is colored and has correct deep-file comment context", async ({
    page,
    withWorkspace,
  }) => {
    test.setTimeout(120_000);
    await observeFirstSyntaxPaint(page);
    const workspace = await withWorkspace({ prefix: "editor-first-syntax-paint-" });
    await writeFile(path.join(workspace.repoPath, "entry.ts"), "export const entry = true;\n");
    const deepPath = path.join(workspace.repoPath, "deep.ts");
    const text = [
      "/*",
      ...Array.from({ length: 3998 }, () => "padding"),
      "const inside = 'text';",
      "*/",
      "export const syntaxReady = 42;",
      "// reference comment",
    ].join("\n");
    await writeFile(deepPath, text);
    await workspace.navigateTo();
    await openWorkspaceFile(page, "entry.ts");
    const entry = page
      .getByTestId("file-source-editor")
      .filter({ visible: true })
      .frameLocator("iframe");
    await expect(entry.locator(".view-lines")).toBeVisible();
    await entry
      .locator("body")
      .evaluate(
        (_body, uri) =>
          window.parent.postMessage(
            { type: "open-location", uri, lineStart: 4000, lineEnd: 4002 },
            window.location.origin,
          ),
        pathToFileURL(deepPath).href,
      );
    await expectFileTabOpen(page, "deep.ts");
    const source = page
      .getByTestId("file-source-editor")
      .filter({ visible: true })
      .frameLocator("iframe");
    await expect(source.locator("html")).toHaveAttribute(
      "data-first-syntax-paint",
      /commentColors/,
      { timeout: 30_000 },
    );
    const paint = syntaxPaintSchema.parse(
      JSON.parse((await source.locator("html").getAttribute("data-first-syntax-paint")) ?? "null"),
    );
    expect(paint.commentColors).toBe(1);
    expect(paint.codeColors).toBeGreaterThanOrEqual(3);
    expect(paint.commentColor).toBe(paint.referenceColor);
    expect(await readFile(deepPath, "utf8")).toBe(text);
  });

  test("opens files without loading text and gives slow reads delayed progress", async ({
    page,
    withWorkspace,
  }) => {
    const gate = await installDaemonWebSocketGate(page);
    const workspace = await withWorkspace({ prefix: "editor-quiet-open-" });
    await writeFile(path.join(workspace.repoPath, "quiet.ts"), "export const quiet = true;\n");
    gate.holdFileReads("quiet.ts");
    await workspace.navigateTo();
    await openWorkspaceFile(page, "quiet.ts");
    await gate.waitForHeldFileRead();
    await expect(page.getByTestId("file-preview-loading")).toBeVisible();
    await expect(page.getByText(/Loading file/)).toHaveCount(0);
    await expect(page.getByRole("progressbar", { name: /Loading file/ })).toBeVisible();
    gate.releaseHeldFileRead();
    await expect(page.getByTestId("file-preview-loading")).toHaveCount(0);
    await expect(
      page.getByTestId("file-source-editor").frameLocator("iframe").locator(".view-lines"),
    ).toContainText("quiet = true");
  });

  test("keeps the source editor alive across Preview switches", async ({ page, withWorkspace }) => {
    const workspace = await withWorkspace({ prefix: "editor-preview-continuity-" });
    const filename = path.join(workspace.repoPath, "notes.md");
    const text =
      "# Notes\n\n" +
      Array.from({ length: 100 }, (_, index) => `Line ${index + 1}`).join("\n") +
      "\nfinal marker";
    await writeFile(filename, text);
    await workspace.navigateTo();
    await openWorkspaceFile(page, "notes.md");
    await selectFileView(page, "Source");
    const source = page.getByTestId("file-source-editor").frameLocator("iframe");
    await expect(source.locator(".view-lines")).toBeVisible();
    const origin = await source.locator("body").evaluate(() => performance.timeOrigin);
    await source.getByRole("textbox", { name: "Editor content", exact: true }).focus();
    await page.keyboard.press("Control+End");
    await page.keyboard.press("Home");
    for (let index = 0; index < 5; index += 1) await page.keyboard.press("Shift+ArrowRight");
    await selectFileView(page, "Preview");
    await selectFileView(page, "Source");
    expect(await source.locator("body").evaluate(() => performance.timeOrigin)).toBe(origin);
    await expect(page.getByTestId("file-preview-loading")).toHaveCount(0);
    await expect(source.locator(".view-line").filter({ hasText: "final marker" })).toBeInViewport();
    await source.getByRole("textbox", { name: "Editor content", exact: true }).focus();
    await page.keyboard.insertText("saved");
    await expect
      .poll(() => readFile(filename, "utf8"))
      .toBe(text.replace("final marker", "saved marker"));
  });

  test("restores selection and viewport after a renderer reload", async ({
    page,
    withWorkspace,
  }) => {
    const workspace = await withWorkspace({ prefix: "editor-view-state-" });
    const filename = path.join(workspace.repoPath, "state.ts");
    const lines = Array.from({ length: 200 }, (_, index) => `// Line ${index + 1}`);
    lines.splice(0, 4, "export function folded() {", "  const value = 1;", "  return value;", "}");
    const text = lines.join("\n");
    await writeFile(filename, text);
    await workspace.navigateTo();
    await openWorkspaceFile(page, "state.ts");
    const source = page
      .getByTestId("file-source-editor")
      .filter({ visible: true })
      .frameLocator("iframe");
    await expect(source.locator(".view-lines")).toBeVisible();
    await source.getByRole("textbox", { name: "Editor content", exact: true }).focus();
    await page.keyboard.press("Control+Home");
    await page.keyboard.press("Control+Shift+[");
    await expect(source.locator(".codicon-folding-collapsed")).toHaveCount(1);
    await page.keyboard.press("Control+End");
    await page.keyboard.press("Home");
    for (let index = 0; index < 4; index += 1) await page.keyboard.press("Shift+ArrowRight");
    await expect
      .poll(() => savedEditorViews(page, "state.ts"))
      .toEqual([
        expect.objectContaining({
          kind: "monaco",
          state: expect.objectContaining({
            cursorState: [
              expect.objectContaining({
                selectionStart: { lineNumber: 200, column: 1 },
                position: { lineNumber: 200, column: 5 },
              }),
            ],
          }),
        }),
      ]);
    await page.reload();
    await expect(source.locator(".view-line").filter({ hasText: "// Line 200" })).toBeInViewport({
      timeout: 30_000,
    });
    await source.getByRole("textbox", { name: "Editor content", exact: true }).focus();
    await page.keyboard.insertText("restored");
    await expect
      .poll(() => readFile(filename, "utf8"))
      .toBe(text.replace("// Line 200", "restoredine 200"));
    await page.keyboard.press("Control+Home");
    await expect(source.locator(".codicon-folding-collapsed")).toHaveCount(1);
  });

  test("recovers a local draft after reload without overwriting newer disk content", async ({
    page,
    withWorkspace,
  }) => {
    const workspace = await withWorkspace({ prefix: "editor-draft-recovery-" });
    const filename = path.join(workspace.repoPath, "recover.ts");
    await writeFile(filename, "const disk = 1;\n");
    await workspace.navigateTo();
    await openWorkspaceFile(page, "recover.ts");
    const source = page
      .getByTestId("file-source-editor")
      .filter({ visible: true })
      .frameLocator("iframe");
    await expect(source.locator(".view-lines")).toBeVisible();
    await source.getByRole("textbox", { name: "Editor content", exact: true }).focus();
    await page.keyboard.press("Control+a");
    await page.keyboard.insertText("const local = 2;\n");
    await writeFile(filename, "const external = 3;\n");
    await expect(page.getByTestId("file-conflict-alert")).toBeVisible();
    await expect
      .poll(() => savedEditorDrafts(page))
      .toEqual([
        expect.objectContaining({ content: "const local = 2;\n", base: "const disk = 1;\n" }),
      ]);
    const sibling = await page.context().newPage();
    await sibling.goto(page.url());
    await expect(
      sibling
        .getByTestId("file-source-editor")
        .filter({ visible: true })
        .frameLocator("iframe")
        .locator(".view-lines"),
    ).toContainText("const external = 3;", { timeout: 30_000 });
    await expect(sibling.getByTestId("file-recovered-draft")).toHaveCount(0);
    await sibling.close();
    await page.reload();
    await expect(page.getByTestId("file-recovered-draft")).toBeVisible({ timeout: 30_000 });
    await expect(source.locator(".view-lines")).toContainText("const local = 2;");
    expect(await readFile(filename, "utf8")).toBe("const external = 3;\n");
    await page.getByRole("button", { name: "Overwrite", exact: true }).click();
    await expect.poll(() => readFile(filename, "utf8")).toBe("const local = 2;\n");
    await expect(page.getByTestId("file-recovered-draft")).toHaveCount(0);
    await expect.poll(() => editorRecords(page, "drafts")).toEqual([]);
  });

  test("recovers language services after a real crash without replacing the editor or its unsaved text", async ({
    page,
    withWorkspace,
  }) => {
    test.skip(
      process.platform !== "darwin",
      "Inspects the isolated test server's child cwd using macOS lsof",
    );
    test.setTimeout(120_000);
    const gate = await installDaemonWebSocketGate(page);
    const workspace = await withWorkspace({ prefix: "language-crash-recovery-" });
    const filename = path.join(workspace.repoPath, "recover.ts");
    const original = "const value = { fromDisk: 1 };\nvalue";
    await writeFile(filename, original);
    await workspace.navigateTo();
    await openFileExplorer(page);
    await openFileFromExplorer(page, "recover.ts");
    const surface = page.getByTestId("file-source-editor").filter({ visible: true });
    const frame = surface.frameLocator("iframe");
    await expect(frame.locator("#editor")).toHaveAttribute("data-language-service", "typescript", {
      timeout: 60_000,
    });
    const timeOrigin = await frame.locator("#editor").evaluate((element) => {
      element.setAttribute("data-recovery-proof", "same-editor");
      return performance.timeOrigin;
    });
    gate.holdNextClientRequest("fs.file.write.request");
    await frame.getByRole("textbox").focus();
    await page.keyboard.press("Control+a");
    await page.keyboard.insertText("const value = { unsavedOnly: 1 };\nvalue.");
    await gate.waitForHeldClientRequest();
    expect(await readFile(filename, "utf8")).toBe(original);
    const processes = execFileSync("ps", ["-axo", "pid=,command="], { encoding: "utf8" }).split(
      "\n",
    );
    const workspaceRoot = await realpath(workspace.repoPath);
    const candidates = processes.filter((line) =>
      line.includes("typescript-language-server/lib/cli.mjs"),
    );
    const pids = candidates
      .map((line) => Number(line.trim().split(/\s+/, 1)[0]))
      .filter((pid) => {
        const cwd = execFileSync("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"], {
          encoding: "utf8",
        });
        return cwd.split("\n").includes(`n${workspaceRoot}`);
      });
    expect(pids).toHaveLength(1);
    process.kill(pids[0], "SIGKILL");
    await expect(frame.locator("#editor")).toHaveAttribute("data-language-service-restarts", "1", {
      timeout: 30_000,
    });
    await expect(frame.locator("#editor")).toHaveAttribute("data-language-service-state", "ready", {
      timeout: 30_000,
    });
    await expect(frame.locator("#editor")).toHaveAttribute("data-recovery-proof", "same-editor");
    expect(await frame.locator("#editor").evaluate(() => performance.timeOrigin)).toBe(timeOrigin);
    await frame.getByRole("textbox").focus();
    await page.keyboard.press("Control+Space");
    await expect(
      frame.locator(".suggest-widget.visible").getByText("unsavedOnly", { exact: true }),
    ).toBeVisible({ timeout: 30_000 });
    await page.keyboard.press("Escape");
    expect(await readFile(filename, "utf8")).toBe(original);
    await frame.locator("#editor").evaluate(() => {
      window.parent.postMessage(
        { type: "language-error", message: "Retry language-service test" },
        window.location.origin,
      );
    });
    const requestCount = gate.getClientRequestCount("workspace.language.query.request");
    await surface.getByRole("button", { name: "Retry language services", exact: true }).click();
    await expect
      .poll(() => gate.getClientRequestCount("workspace.language.query.request"))
      .toBeGreaterThan(requestCount + 2);
    await expect(frame.locator("#editor")).toHaveAttribute("data-language-service", "typescript", {
      timeout: 30_000,
    });
    await expect(surface.getByText("Retry language-service test", { exact: false })).toHaveCount(0);
    await expect(frame.locator("#editor")).toHaveAttribute("data-recovery-proof", "same-editor");
    expect(await frame.locator("#editor").evaluate(() => performance.timeOrigin)).toBe(timeOrigin);
    gate.releaseHeldClientRequest();
    await expect.poll(() => readFile(filename, "utf8")).toContain("unsavedOnly");
    await frame.getByRole("textbox").focus();
    await page.keyboard.press("Control+z");
    await expect(frame.locator(".view-lines")).toContainText("fromDisk");
    await expect(frame.locator(".view-lines")).not.toContainText("unsavedOnly");
    await page.screenshot({ path: test.info().outputPath("language-services-recovered.png") });
  });

  test("uses project TypeScript completion, cross-file navigation and undoable local rename", async ({
    page,
    withWorkspace,
  }) => {
    test.setTimeout(120_000);
    const workspace = await withWorkspace({ prefix: "typescript-language-project-" });
    await mkdir(path.join(workspace.repoPath, "src"));
    await writeFile(
      path.join(workspace.repoPath, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: { strict: true, baseUrl: ".", paths: { "@/*": ["src/*"] } },
        include: ["src"],
      }),
    );
    const helper =
      "export function greet(name: string): string {\n  const prefix = 'Hello ';\n  return prefix + name;\n}\n";
    const helperPath = path.join(workspace.repoPath, "src/helper.ts");
    await writeFile(helperPath, helper);
    await writeFile(
      path.join(workspace.repoPath, "src/main.ts"),
      "import { greet } from '@/helper';\nconst message = greet('Ada');\nmessage",
    );
    await workspace.navigateTo();
    await openFileExplorer(page);
    await expandFolder(page, "src");
    await openFileFromExplorer(page, "main.ts");
    await expectFileTabOpen(page, "src/main.ts");
    const frame = page
      .getByTestId("file-source-editor")
      .filter({ visible: true })
      .frameLocator("iframe");
    await expect(frame.locator("#editor")).toHaveAttribute("data-language-service", "typescript", {
      timeout: 60_000,
    });
    await frame.locator(".view-lines").click();
    await page.keyboard.press("Control+End");
    await page.keyboard.type(".");
    await page.keyboard.type("toU");
    const suggestion = frame
      .locator(".suggest-widget.visible")
      .getByText("toUpperCase", { exact: true });
    await expect(suggestion).toBeVisible({ timeout: 30_000 });
    await suggestion.click();
    await expect
      .poll(() => readFile(path.join(workspace.repoPath, "src/main.ts"), "utf8"))
      .toContain("message.toUpperCase");
    await frame
      .locator(".view-line span")
      .filter({ hasText: /^greet$/ })
      .last()
      .click();
    await page.keyboard.press("F12");
    await expectFileTabOpen(page, "src/helper.ts");
    const definition = page
      .getByTestId("file-source-editor")
      .filter({ visible: true })
      .frameLocator("iframe");
    await expect(definition.locator("#editor")).toHaveAttribute(
      "data-language-service",
      "typescript",
      { timeout: 30_000 },
    );
    await definition
      .locator(".view-line span")
      .filter({ hasText: /^prefix$/ })
      .first()
      .click();
    await page.keyboard.press("F2");
    const rename = definition.locator(".rename-box input.rename-input");
    await expect(rename).toBeVisible();
    await rename.fill("salutation");
    await rename.press("Enter");
    await expect(page.getByTestId("workspace-edit-review")).toBeVisible();
    await page.getByRole("button", { name: "Apply changes", exact: true }).click();
    await expect
      .poll(() => readFile(helperPath, "utf8"))
      .toBe(helper.replaceAll("prefix", "salutation"));
    await definition.locator(".view-lines").click();
    await page.keyboard.press("Control+z");
    await expect.poll(() => readFile(helperPath, "utf8")).toBe(helper);

    await definition
      .locator(".view-line span")
      .filter({ hasText: /^greet$/ })
      .first()
      .click();
    await page.keyboard.press("F2");
    await rename.fill("welcome");
    await rename.press("Enter");
    const review = page.getByTestId("workspace-edit-review");
    await expect(review).toBeVisible();
    await expect(review.getByText("2 affected files", { exact: true })).toBeVisible();
    await expect(review.frameLocator("iframe").locator(".monaco-diff-editor")).toBeVisible();
    expect(await readFile(helperPath, "utf8")).toBe(helper);
    await review.getByRole("button", { name: "Apply changes", exact: true }).click();
    await expect
      .poll(() => readFile(helperPath, "utf8"))
      .toBe(helper.replaceAll("greet", "welcome"));
    const mainPath = path.join(workspace.repoPath, "src/main.ts");
    await expect.poll(() => readFile(mainPath, "utf8")).toContain("welcome('Ada')");
    await definition.locator(".view-lines").click();
    await page.keyboard.press("Control+z");
    await expect.poll(() => readFile(helperPath, "utf8")).toBe(helper);
    await expect.poll(() => readFile(mainPath, "utf8")).toContain("greet('Ada')");
    await page.screenshot({
      path: test.info().outputPath("typescript-project-language-service.png"),
    });
  });

  test("uses Python imports for completion and updates diagnostics after edits", async ({
    page,
    withWorkspace,
  }) => {
    test.setTimeout(120_000);
    const workspace = await withWorkspace({ prefix: "python-language-project-" });
    await writeFile(
      path.join(workspace.repoPath, "helpers.py"),
      "def greet(name: str) -> str:\n    return 'Hello ' + name\n",
    );
    const main = path.join(workspace.repoPath, "main.py");
    await writeFile(main, "from helpers import greet\nmessage = greet('Ada')\nmessage");
    await workspace.navigateTo();
    await openWorkspaceFile(page, "main.py");
    const frame = page
      .getByTestId("file-source-editor")
      .filter({ visible: true })
      .frameLocator("iframe");
    await expect(frame.locator("#editor")).toHaveAttribute("data-language-service", "python", {
      timeout: 60_000,
    });
    await frame.locator(".view-lines").click();
    await page.keyboard.press("Control+End");
    await page.keyboard.type(".");
    await page.keyboard.type("upp");
    const suggestion = frame.locator(".suggest-widget.visible").getByText("upper", { exact: true });
    await expect(suggestion).toBeVisible({ timeout: 30_000 });
    await suggestion.click();
    await frame.locator(".view-lines").click();
    await page.keyboard.press("Control+a");
    await page.keyboard.insertText("from helpers import greet\nwrong: int = greet('Ada')\n");
    await expect(frame.locator(".squiggly-error").first()).toBeVisible({ timeout: 30_000 });
    await page.keyboard.press("Control+a");
    const corrected = "from helpers import greet\nmessage: str = greet('Ada')\n";
    await page.keyboard.insertText(corrected);
    await expect(frame.locator(".squiggly-error")).toHaveCount(0, { timeout: 30_000 });
    await expect.poll(() => readFile(main, "utf8")).toBe(corrected);
  });

  test("reviews a file move with import updates and undoes the path and imports together", async ({
    page,
    withWorkspace,
  }) => {
    test.setTimeout(120_000);
    const workspace = await withWorkspace({ prefix: "typescript-file-move-" });
    await mkdir(path.join(workspace.repoPath, "src"));
    await writeFile(
      path.join(workspace.repoPath, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: { module: "ESNext", target: "ES2022" },
        include: ["**/*.ts"],
      }),
    );
    const helper = "export const greeting = 'Hello';\n";
    const main = "import { greeting } from './helper';\nconsole.log(greeting);\n";
    const oldPath = path.join(workspace.repoPath, "helper.ts");
    const newPath = path.join(workspace.repoPath, "src/greeting.ts");
    const mainPath = path.join(workspace.repoPath, "main.ts");
    await writeFile(oldPath, helper);
    await writeFile(mainPath, main);
    await workspace.navigateTo();
    await openWorkspaceFile(page, "helper.ts");
    const frame = page
      .getByTestId("file-source-editor")
      .filter({ visible: true })
      .frameLocator("iframe");
    await expect(frame.locator("#editor")).toHaveAttribute("data-language-service", "typescript", {
      timeout: 60_000,
    });
    await openFileExplorer(page);
    await page
      .getByTestId("file-explorer-tree-scroll")
      .getByText("helper.ts", { exact: true })
      .first()
      .click({ button: "right" });
    await page.getByText("Rename", { exact: true }).click();
    const destination = page.getByTestId("file-explorer-name-input");
    await destination.fill("src/greeting.ts");
    await destination.press("Enter");
    const review = page.getByTestId("workspace-edit-review");
    await expect(review).toBeVisible();
    expect(await readFile(oldPath, "utf8")).toBe(helper);
    expect(await readFile(mainPath, "utf8")).toBe(main);
    await review.getByRole("button", { name: "Apply changes", exact: true }).click();
    await expectFileTabOpen(page, "src/greeting.ts");
    await expect.poll(() => readFile(newPath, "utf8")).toBe(helper);
    await expect.poll(() => readFile(mainPath, "utf8")).toContain("'./src/greeting'");
    const moved = page
      .getByTestId("file-source-editor")
      .filter({ visible: true })
      .frameLocator("iframe");
    await expect(moved.locator("#editor")).toHaveAttribute("data-language-service", "typescript", {
      timeout: 30_000,
    });
    await moved.locator(".view-lines").click();
    await page.keyboard.press("Control+z");
    await expectFileTabOpen(page, "helper.ts");
    await expect.poll(() => readFile(oldPath, "utf8")).toBe(helper);
    await expect.poll(() => readFile(mainPath, "utf8")).toBe(main);
  });

  test("reviews an organize-imports language-server action before applying it", async ({
    page,
    withWorkspace,
  }) => {
    test.setTimeout(120_000);
    const workspace = await withWorkspace({ prefix: "typescript-reviewed-command-" });
    await writeFile(
      path.join(workspace.repoPath, "tsconfig.json"),
      JSON.stringify({ compilerOptions: { module: "ESNext" }, include: ["*.ts"] }),
    );
    await writeFile(
      path.join(workspace.repoPath, "values.ts"),
      "export const a = 1; export const b = 2;\n",
    );
    const sourcePath = path.join(workspace.repoPath, "main.ts");
    const original =
      "import { b } from './values';\nimport { a } from './values';\nconsole.log(b, a);\n";
    await writeFile(sourcePath, original);
    await workspace.navigateTo();
    await openWorkspaceFile(page, "main.ts");
    const frame = page
      .getByTestId("file-source-editor")
      .filter({ visible: true })
      .frameLocator("iframe");
    await expect(frame.locator("#editor")).toHaveAttribute("data-language-service", "typescript", {
      timeout: 60_000,
    });
    await frame.locator(".view-lines").click();
    await page.keyboard.press("Shift+Alt+o");
    const review = page.getByTestId("workspace-edit-review");
    await expect(review).toBeVisible();
    expect(await readFile(sourcePath, "utf8")).toBe(original);
    await review.getByRole("button", { name: "Apply changes", exact: true }).click();
    await expect
      .poll(() => readFile(sourcePath, "utf8"))
      .toBe("import { a, b } from './values';\nconsole.log(b, a);\n");
    await frame.locator(".view-lines").click();
    await page.keyboard.press("Control+z");
    await expect.poll(() => readFile(sourcePath, "utf8")).toBe(original);
  });

  test("rejects a stale cross-file preview without overwriting an external edit", async ({
    page,
    withWorkspace,
  }) => {
    test.setTimeout(120_000);
    const workspace = await withWorkspace({ prefix: "typescript-stale-review-" });
    await writeFile(
      path.join(workspace.repoPath, "tsconfig.json"),
      JSON.stringify({ include: ["*.ts"] }),
    );
    const sourcePath = path.join(workspace.repoPath, "helper.ts");
    const mainPath = path.join(workspace.repoPath, "main.ts");
    const source = "export const greeting = 'Hello';\n";
    const main = "import { greeting } from './helper';\nconsole.log(greeting);\n";
    await writeFile(sourcePath, source);
    await writeFile(mainPath, main);
    await workspace.navigateTo();
    await openWorkspaceFile(page, "helper.ts");
    const frame = page
      .getByTestId("file-source-editor")
      .filter({ visible: true })
      .frameLocator("iframe");
    await expect(frame.locator("#editor")).toHaveAttribute("data-language-service", "typescript", {
      timeout: 60_000,
    });
    await frame
      .locator(".view-line span")
      .filter({ hasText: /^greeting$/ })
      .first()
      .click();
    await page.keyboard.press("F2");
    const rename = frame.locator(".rename-box input.rename-input");
    await rename.fill("welcome");
    await rename.press("Enter");
    const review = page.getByTestId("workspace-edit-review");
    await expect(review).toBeVisible();
    const external = main + "// written by another process\n";
    await writeFile(mainPath, external);
    await expect(review.getByRole("alert")).toContainText("changed during review", {
      timeout: 30_000,
    });
    await expect(review.getByRole("button", { name: "Apply changes", exact: true })).toBeDisabled();
    expect(await readFile(sourcePath, "utf8")).toBe(source);
    expect(await readFile(mainPath, "utf8")).toBe(external);
    await review.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(review).toHaveCount(0);
  });

  test("keeps failed refactor saves visible and opens their unsaved buffers", async ({
    page,
    withWorkspace,
  }) => {
    test.setTimeout(120_000);
    const gate = await installDaemonWebSocketGate(page);
    const workspace = await withWorkspace({ prefix: "typescript-review-save-conflict-" });
    await writeFile(
      path.join(workspace.repoPath, "tsconfig.json"),
      JSON.stringify({ include: ["*.ts"] }),
    );
    const sourcePath = path.join(workspace.repoPath, "helper.ts");
    const mainPath = path.join(workspace.repoPath, "main.ts");
    const source = "export const greeting = 'Hello';\n";
    const main = "import { greeting } from './helper';\nconsole.log(greeting);\n";
    await writeFile(sourcePath, source);
    await writeFile(mainPath, main);
    await workspace.navigateTo();
    await openWorkspaceFile(page, "helper.ts");
    const frame = page
      .getByTestId("file-source-editor")
      .filter({ visible: true })
      .frameLocator("iframe");
    await expect(frame.locator("#editor")).toHaveAttribute("data-language-service", "typescript", {
      timeout: 60_000,
    });
    await frame
      .locator(".view-line span")
      .filter({ hasText: /^greeting$/ })
      .first()
      .click();
    await page.keyboard.press("F2");
    const rename = frame.locator(".rename-box input.rename-input");
    await rename.fill("welcome");
    await rename.press("Enter");
    const review = page.getByTestId("workspace-edit-review");
    await expect(review).toBeVisible();
    gate.holdNextReadyFileUpdate("main.ts");
    const external = main + "// written by another process\n";
    await writeFile(mainPath, external);
    await gate.waitForHeldReadyFileUpdate();
    await review.getByRole("button", { name: "Apply changes", exact: true }).click();
    await expect(review.getByRole("alert")).toContainText("1 file could not be saved");
    expect(await readFile(mainPath, "utf8")).toBe(external);
    await review.getByRole("button", { name: "Open unsaved files", exact: true }).click();
    await expectFileTabOpen(page, "main.ts");
    await expect(page.getByTestId("file-conflict-alert")).toBeVisible();
    await expect(page.getByTestId("workspace-tab-modified-file_main.ts")).toBeVisible();
    gate.releaseHeldReadyFileUpdate();
    expect(await readFile(mainPath, "utf8")).toBe(external);
  });

  test("reviews an Explorer rename without requiring the source file to be open", async ({
    page,
    withWorkspace,
  }) => {
    test.setTimeout(120_000);
    const workspace = await withWorkspace({ prefix: "typescript-explorer-rename-" });
    await writeFile(
      path.join(workspace.repoPath, "tsconfig.json"),
      JSON.stringify({ include: ["*.ts"] }),
    );
    const source = "export const greeting = 'Hello';\n";
    const main = "import { greeting } from './helper';\nconsole.log(greeting);\n";
    await writeFile(path.join(workspace.repoPath, "helper.ts"), source);
    await writeFile(path.join(workspace.repoPath, "main.ts"), main);
    await workspace.navigateTo();
    await openFileExplorer(page);
    const entry = page
      .getByTestId("file-explorer-tree-scroll")
      .getByText("helper.ts", { exact: true })
      .first();
    await entry.click({ button: "right" });
    await page.getByText("Rename", { exact: true }).click();
    const name = page.getByTestId("file-explorer-name-input");
    await name.fill("renamed.ts");
    await name.press("Enter");
    const review = page.getByTestId("workspace-edit-review");
    await expect(review).toBeVisible();
    await review.getByRole("button", { name: "Apply changes", exact: true }).click();
    await expect
      .poll(() => readFile(path.join(workspace.repoPath, "renamed.ts"), "utf8"))
      .toBe(source);
    await expect
      .poll(() => readFile(path.join(workspace.repoPath, "main.ts"), "utf8"))
      .toContain("'./renamed'");
  });

  test("auto-imports a TypeScript project export and shows parameter hints", async ({
    page,
    withWorkspace,
  }) => {
    test.setTimeout(120_000);
    const workspace = await withWorkspace({ prefix: "typescript-auto-import-" });
    await writeFile(
      path.join(workspace.repoPath, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: { strict: true, module: "ESNext", target: "ES2022" },
        include: ["*.ts"],
      }),
    );
    await writeFile(
      path.join(workspace.repoPath, "helpers.ts"),
      "export function getCustomer(name: string) { return { name }; }\n",
    );
    const main = path.join(workspace.repoPath, "main.ts");
    await writeFile(main, "const customer = getCust");
    await workspace.navigateTo();
    await openWorkspaceFile(page, "main.ts");
    const frame = page
      .getByTestId("file-source-editor")
      .filter({ visible: true })
      .frameLocator("iframe");
    await expect(frame.locator("#editor")).toHaveAttribute("data-language-service", "typescript", {
      timeout: 60_000,
    });
    await frame.locator(".view-lines").click();
    await page.keyboard.press("Control+End");
    await page.keyboard.press("Control+Space");
    const suggestion = frame
      .locator(".suggest-widget.visible")
      .getByText("getCustomer", { exact: true });
    await expect(suggestion).toBeVisible({ timeout: 30_000 });
    await suggestion.click();
    await page.keyboard.type("(");
    await expect(frame.locator(".parameter-hints-widget.visible")).toBeVisible({ timeout: 30_000 });
    await page.keyboard.type("'Ada');");
    await expect
      .poll(() => readFile(main, "utf8"))
      .toMatch(/import\s+\{\s*getCustomer\s*\}\s+from\s+['"]\.\/helpers['"]/);
    await expect.poll(() => readFile(main, "utf8")).toContain("getCustomer('Ada');");
  });

  test("scrolls the last line above the middle of the viewport without changing the file", async ({
    page,
    withWorkspace,
  }) => {
    const workspace = await withWorkspace({ prefix: "monaco-scroll-" });
    const sourcePath = path.join(workspace.repoPath, "scroll.ts");
    const content = Array.from({ length: 80 }, (_, index) => `// Line ${index + 1}`).join("\n");
    await writeFile(sourcePath, content, "utf8");
    await workspace.navigateTo();
    await openWorkspaceFile(page, "scroll.ts");
    const mainIsland = page.getByTestId("workspace-main-island");
    const tabRow = mainIsland.getByTestId("workspace-tabs-row").first();
    await expect(tabRow).toBeVisible();
    await expect(mainIsland.getByTestId("workspace-header-menu-trigger")).toHaveCount(0);
    await expect(mainIsland.getByTestId("changes-primary-cta")).toHaveCount(0);
    await expect(mainIsland.getByTestId("file-panel-bar")).toHaveCount(0);
    const islandBounds = await mainIsland.boundingBox();
    const tabsBounds = await tabRow.boundingBox();
    expect(islandBounds).not.toBeNull();
    expect(tabsBounds).not.toBeNull();
    expect(tabsBounds?.y).toBe((islandBounds?.y ?? 0) + 1);
    const frame = page.frameLocator('[data-testid="file-source-editor"] iframe');
    const editorViewport = frame.locator(".monaco-editor");
    await expect(frame.locator(".view-lines")).toBeVisible({ timeout: 30_000 });
    await frame.locator(".view-lines").click();
    await page.keyboard.press("Control+End");
    await editorViewport.hover();
    const lastLine = frame.locator(".view-line").filter({ hasText: /Line\s80$/ });
    await expect(lastLine).toBeVisible();
    await expect
      .poll(async () => {
        await page.mouse.wheel(0, 600);
        const viewport = await editorViewport.boundingBox();
        const line = await lastLine.boundingBox();
        return viewport && line ? (line.y - viewport.y) / viewport.height : 1;
      })
      .toBeLessThan(0.5);
    expect(await readFile(sourcePath, "utf8")).toBe(content);
    await page.screenshot({ path: test.info().outputPath("monaco-scroll-past-end.png") });
  });

  test("opens from Explorer with TextMate, TypeScript diagnostics, autosave and JSON LSP", async ({
    page,
    withWorkspace,
  }) => {
    test.setTimeout(120_000);
    await page.emulateMedia({ colorScheme: "dark" });
    const workspace = await withWorkspace({ prefix: "monaco-editing-" });
    const sourcePath = path.join(workspace.repoPath, "source.ts");
    await writeFile(sourcePath, "const answer: string = 42;\r\n", "utf8");
    await writeFile(path.join(workspace.repoPath, "invalid.json"), '{"answer": }\n', "utf8");
    await workspace.navigateTo();
    await openWorkspaceFile(page, "source.ts");
    const frame = page.frameLocator('[data-testid="file-source-editor"] iframe');
    const input = frame.locator(".view-lines");
    await expect(input).toBeVisible({ timeout: 30_000 });
    await expect(frame.locator(".squiggly-error")).toBeVisible({ timeout: 30_000 });
    const keyword = frame.locator(".view-line span").filter({ hasText: /^const$/ });
    await expect(keyword).toHaveCSS("color", "rgb(86, 156, 214)");
    await input.click();
    await page.keyboard.press("Control+a");
    await page.keyboard.insertText("const answer = 43;\n");
    await expect.poll(() => readFile(sourcePath, "utf8")).toBe("const answer = 43;\r\n");
    await writeFile(sourcePath, "const external = 44;\r\n", "utf8");
    await expect(frame.locator(".view-lines")).toContainText("external");
    await input.click();
    await page.keyboard.press("Control+a");
    await page.keyboard.insertText("const saved = 45;\n");
    await page.keyboard.press("Control+s");
    await expect.poll(() => readFile(sourcePath, "utf8")).toBe("const saved = 45;\r\n");
    await openWorkspaceFile(page, "invalid.json");
    const jsonFrame = page
      .getByTestId("file-source-editor")
      .filter({ visible: true })
      .frameLocator("iframe");
    await expect(jsonFrame.locator(".squiggly-error")).toBeVisible({ timeout: 30_000 });
    await page.screenshot({ path: test.info().outputPath("monaco-json-lsp.png") });
  });

  test("shows an asset loading failure and retries without losing the file", async ({
    page,
    withWorkspace,
  }) => {
    test.setTimeout(90_000);
    const workspace = await withWorkspace({ prefix: "monaco-retry-" });
    await writeFile(path.join(workspace.repoPath, "retry.ts"), "const preserved = 1;\n", "utf8");
    await page.route("**/monaco/editor.js", (route) => route.abort());
    await workspace.navigateTo();
    await openWorkspaceFile(page, "retry.ts");
    await expect(page.getByTestId("file-source-editor").getByRole("alert")).toContainText(
      "assets failed to load",
      {
        timeout: 30_000,
      },
    );
    await page.unroute("**/monaco/editor.js");
    await page.getByRole("button", { name: "Retry editor", exact: true }).click();
    const frame = page.frameLocator('[data-testid="file-source-editor"] iframe');
    await expect(frame.locator(".view-lines")).toContainText("preserved", { timeout: 30_000 });
  });
});

const RED_PIXEL = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII=",
  "base64",
);
const BLUE_PIXEL = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
const BLOCKED_PREVIEW_URL = "https://html-preview.invalid/leak";

interface LinkedFile {
  target: string;
  fileName: string;
  content: string;
}

function editor(page: Page) {
  return page.getByTestId("file-source-editor").filter({ visible: true }).locator(".cm-content");
}

function hasHorizontalOverflow(element: HTMLElement): boolean {
  return element.scrollWidth > element.clientWidth;
}

function fitsViewportWidth(element: HTMLElement): boolean {
  return element.scrollWidth === element.clientWidth;
}

async function replaceEditorText(page: Page, content: string): Promise<void> {
  await editor(page).fill(content);
}

async function openWorkspaceFile(page: Page, filename: string): Promise<void> {
  const tree = page.getByTestId("file-explorer-tree-scroll");
  if (!(await tree.isVisible())) await openFileExplorer(page);
  await openFileFromExplorer(page, filename);
  await expectFileTabOpen(page, filename);
}

function htmlPreview(page: Page) {
  return {
    host: page.getByTestId("file-html-preview"),
    document: page.frameLocator('[data-testid="file-html-preview"]'),
  };
}

async function selectFileView(page: Page, view: "Preview" | "Source"): Promise<void> {
  const option = page.getByTestId("file-panel-bar").getByRole("button", {
    name: view,
    exact: true,
  });
  await option.click();
  await expect(option).toHaveAttribute("aria-selected", "true");
}

/** How many times the app has read the file's contents from the daemon. */
function fileReadCount(
  gate: Awaited<ReturnType<typeof installDaemonWebSocketGate>>,
  fileName: string,
): number {
  return gate
    .getClientRequests("file_explorer_request")
    .filter((request) => request.mode === "file" && String(request.path).endsWith(fileName)).length;
}

async function expectMarkdownImageLoaded(page: Page, name: string): Promise<void> {
  const image = page.getByRole("button", { name, exact: true });
  await expect(image).toBeVisible();
  await expect
    .poll(() => image.evaluate((element: HTMLImageElement) => element.naturalWidth))
    .toBeGreaterThan(0);
}

function watchRequestsTo(page: Page, origin: string): string[] {
  const requests: string[] = [];
  page.on("request", (request) => {
    if (request.url().startsWith(origin)) requests.push(request.url());
  });
  return requests;
}

async function seedAgentWithFileLink(input: LinkedFile) {
  const session = await seedMockAgentWorkspace({
    repoPrefix: "file-editing-chat-link-",
    title: "Chat file link e2e",
    initialPrompt: [
      "Generate a title and a git branch name for a coding agent from the user prompt and attachments.",
      "Return JSON only with fields 'title' and 'branch'.",
      "",
      "<user-prompt>",
      `Open \`${input.target}\` now`,
      "</user-prompt>",
    ].join("\n"),
  });
  await writeFile(path.join(session.cwd, input.fileName), input.content, "utf8");
  return session;
}

test.describe("CodeMirror workspace file editing", () => {
  test("browser syntax is colored on the first visible restored frame", async ({
    page,
    withWorkspace,
  }) => {
    test.setTimeout(120_000);
    await observeFirstSyntaxPaint(page, "codemirror");
    const workspace = await withWorkspace({ prefix: "browser-first-syntax-paint-" });
    const filename = path.join(workspace.repoPath, "syntax-browser.ts");
    const text = [
      "/*",
      ...Array.from({ length: 3998 }, () => "padding"),
      "const inside = 'text';",
      "*/",
      "export const syntaxReady = 42;",
      "// reference comment",
    ].join("\n");
    await writeFile(filename, text);
    await workspace.navigateTo();
    await openWorkspaceFile(page, "syntax-browser.ts");
    await expect(editor(page)).toBeVisible();
    const modifier = await page.evaluate(() =>
      /Mac/.test(navigator.platform) ? "Meta" : "Control",
    );
    await editor(page).focus();
    await page.keyboard.press(`${modifier}+End`);
    await expect
      .poll(() => savedEditorViews(page, "syntax-browser.ts"))
      .toEqual([
        expect.objectContaining({
          kind: "codemirror",
          ranges: [{ anchor: text.length, head: text.length }],
        }),
      ]);
    await page.evaluate(() => sessionStorage.setItem("mixer-test-syntax", "enabled"));
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("data-first-syntax-paint", /commentColors/, {
      timeout: 30_000,
    });
    const paint = syntaxPaintSchema.parse(
      JSON.parse((await page.locator("html").getAttribute("data-first-syntax-paint")) ?? "null"),
    );
    expect(paint.commentColors).toBe(1);
    expect(paint.codeColors).toBeGreaterThanOrEqual(3);
    expect(paint.commentColor).toBe(paint.referenceColor);
    expect(await readFile(filename, "utf8")).toBe(text);
  });

  test("restores browser editor selection and scroll after reload", async ({
    page,
    withWorkspace,
  }) => {
    const mac = await page.evaluate(() => /Mac/.test(navigator.platform));
    const modifier = mac ? "Meta" : "Control";
    const workspace = await withWorkspace({ prefix: "browser-editor-state-" });
    const filename = path.join(workspace.repoPath, "browser-state.ts");
    const lines = Array.from({ length: 200 }, (_, index) => `// Line ${index + 1}`);
    lines.splice(0, 4, "export function folded() {", "  const value = 1;", "  return value;", "}");
    const text = lines.join("\n");
    await writeFile(filename, text);
    await workspace.navigateTo();
    await openWorkspaceFile(page, "browser-state.ts");
    await expect(editor(page)).toBeVisible();
    await editor(page).focus();
    await page.keyboard.press(`${modifier}+Home`);
    await page.keyboard.press(mac ? "Meta+Alt+[" : "Control+Shift+[");
    await expect(editor(page).locator(".cm-foldPlaceholder")).toHaveCount(1);
    await page.keyboard.press(`${modifier}+End`);
    await page.keyboard.press("Home");
    for (let index = 0; index < 4; index += 1) await page.keyboard.press("Shift+ArrowRight");
    const start = text.lastIndexOf("// Line 200");
    await expect
      .poll(() => savedEditorViews(page, "browser-state.ts"))
      .toEqual([
        expect.objectContaining({
          kind: "codemirror",
          ranges: [{ anchor: start, head: start + 4 }],
        }),
      ]);
    await page.reload();
    await expect(
      editor(page).locator(".cm-line").filter({ hasText: "// Line 200" }),
    ).toBeInViewport({ timeout: 30_000 });
    await editor(page).focus();
    await page.keyboard.insertText("restored");
    await expect
      .poll(() => readFile(filename, "utf8"))
      .toBe(text.replace("// Line 200", "restoredine 200"));
    await page.keyboard.press(`${modifier}+Home`);
    await expect(editor(page).locator(".cm-foldPlaceholder")).toBeVisible();
  });

  test("recovers a browser editor draft after reload", async ({ page, withWorkspace }) => {
    const workspace = await withWorkspace({ prefix: "browser-editor-recovery-" });
    const filename = path.join(workspace.repoPath, "browser-recover.ts");
    await writeFile(filename, "const disk = 1;\n");
    await workspace.navigateTo();
    await openWorkspaceFile(page, "browser-recover.ts");
    await replaceEditorText(page, "const local = 2;\n");
    await writeFile(filename, "const external = 3;\n");
    await expect(page.getByTestId("file-conflict-alert")).toBeVisible();
    await expect
      .poll(() => savedEditorDrafts(page))
      .toEqual([expect.objectContaining({ content: "const local = 2;\n" })]);
    await page.reload();
    await expect(page.getByTestId("file-recovered-draft")).toBeVisible({ timeout: 30_000 });
    await expect(editor(page)).toContainText("const local = 2;");
    expect(await readFile(filename, "utf8")).toBe("const external = 3;\n");
    await page.getByRole("button", { name: "Overwrite", exact: true }).click();
    await expect.poll(() => readFile(filename, "utf8")).toBe("const local = 2;\n");
    await expect.poll(() => editorRecords(page, "drafts")).toEqual([]);
  });

  test("opens explicit screenshot links and explains missing files", async ({ page }) => {
    const session = await seedMockAgentWorkspace({
      repoPrefix: "screenshot-markdown-link-",
      title: "Screenshot file links",
      initialPrompt: "Show screenshots",
      featureValues: {
        mockAssistantResponse:
          "[Capture](.dev/tablet-review/capture.png) [Missing capture](.dev/tablet-review/missing.png)",
      },
    });
    try {
      await mkdir(path.join(session.cwd, ".dev/tablet-review"), { recursive: true });
      await writeFile(path.join(session.cwd, ".dev/tablet-review/capture.png"), RED_PIXEL);
      await openAgentRoute(page, session);
      await test.step("Open the linked screenshot", async () => {
        await openAssistantMarkdownLink(page, "Capture");
        await expectFileTabOpen(page, ".dev/tablet-review/capture.png");
        await expect(page.getByTestId("image-file-preview-canvas")).toBeVisible();
      });
      await test.step("Explain why the missing screenshot cannot open", async () => {
        await returnToAssistant(page, session.agentId);
        await openAssistantMarkdownLink(page, "Missing capture");
        await expectFileTabOpen(page, ".dev/tablet-review/missing.png");
        await expect(page.getByText("File not found", { exact: true })).toBeVisible();
        await expect(page.getByRole("button", { name: "Retry", exact: true })).toBeVisible();
      });
    } finally {
      await session.cleanup();
    }
  });

  test("opens the non-ASCII file named by an assistant markdown link", async ({ page }) => {
    const session = await seedMockAgentWorkspace({
      repoPrefix: "encoded-markdown-link-",
      title: "Non-ASCII file link",
      initialPrompt: "Show the report link",
      featureValues: { mockAssistantResponse: "[报告](docs/reports/开户赠金.md)" },
    });
    try {
      await mkdir(path.join(session.cwd, "docs/reports"), { recursive: true });
      await writeFile(path.join(session.cwd, "docs/reports/开户赠金.md"), "# Report opened\n");
      await openAgentRoute(page, session);
      await openAssistantMarkdownLink(page, "报告");
      await expectFileTabOpen(page, "docs/reports/开户赠金.md");
      await expect(
        page
          .getByTestId("workspace-file-pane")
          .filter({ visible: true })
          .getByText("Report opened", { exact: true }),
      ).toBeVisible();
      await page.screenshot({ path: test.info().outputPath("non-ascii-file-opened.png") });
    } finally {
      await session.cleanup();
    }
  });

  for (const order of ["raw-first", "href-first"] as const) {
    test(`opens literal and encoded percent filenames independently ${order}`, async ({ page }) => {
      const session = await seedMockAgentWorkspace({
        repoPrefix: "percent-link-cache-",
        title: "Distinct file links",
        initialPrompt: "Show both filenames",
        featureValues: {
          mockAssistantResponse: "Raw `literal%20.md`. [Decoded](literal%20.md).",
        },
      });
      try {
        await writeFile(path.join(session.cwd, "literal%20.md"), "# Literal filename\n");
        await writeFile(path.join(session.cwd, "literal .md"), "# Decoded filename\n");
        await openAgentRoute(page, session);
        const links = order === "raw-first" ? ["raw", "href"] : ["href", "raw"];
        for (const link of links) {
          await returnToAssistant(page, session.agentId);
          if (link === "raw") {
            await openAssistantInlinePath(page, "literal%20.md");
            await expectFileTabOpen(page, "literal%20.md");
            await expectPreviewText(page, "Literal filename");
          } else {
            await openAssistantMarkdownLink(page, "Decoded");
            await expectFileTabOpen(page, "literal .md");
            await expectPreviewText(page, "Decoded filename");
          }
        }
      } finally {
        await session.cleanup();
      }
    });
  }

  test("jumps to each relative reference to the same file", async ({ page }) => {
    const session = await seedMockAgentWorkspace({
      repoPrefix: "relative-reference-qa-",
      title: "Relative line references",
      initialPrompt: "Show both references",
      featureValues: {
        mockAssistantResponse: "First `src/router.go:46`. Then `src/router.go:403`.",
      },
    });
    try {
      await mkdir(path.join(session.cwd, "src"));
      await writeFile(
        path.join(session.cwd, "src/router.go"),
        Array.from({ length: 450 }, (_, n) => `// line ${n + 1}`).join("\n"),
      );
      await openAgentRoute(page, session);
      for (const line of [46, 403, 46]) {
        await page
          .getByTestId(`workspace-tab-agent_${session.agentId}`)
          .filter({ visible: true })
          .click();
        await page.getByText(`src/router.go:${line}`, { exact: true }).click();
        await expect(page.getByLabel(`Line ${line}, column 1`)).toBeVisible();
      }
      await page.screenshot({ path: test.info().outputPath("relative-line-target.png") });
    } finally {
      await session.cleanup();
    }
  });

  test("shows an absolute POSIX assistant file link relative to the workspace on hover", async ({
    page,
  }) => {
    const workspace = await seedWorkspace({ repoPrefix: "file-link-tooltip-" });
    const filePath = path.join(workspace.repoPath, "src", "target.ts");
    try {
      const agent = await workspace.client.createAgent({
        provider: "mock",
        cwd: workspace.repoPath,
        workspaceId: workspace.workspaceId,
        title: "Absolute file link tooltip",
        modeId: "load-test",
        model: "e2e-fast-stream",
        initialPrompt: "Show the file link",
        featureValues: { mockAssistantResponse: `[Open target](${filePath}:42-45)` },
      });
      await gotoAppShell(page);
      await waitForSidebarHydration(page);
      const workspaceRow = page.getByTestId(
        `sidebar-workspace-row-${getServerId()}:${workspace.workspaceId}`,
      );
      await expect(workspaceRow).toBeVisible({ timeout: 30_000 });
      await workspaceRow.click();
      await page.getByTestId(`workspace-tab-agent_${agent.id}`).filter({ visible: true }).click();

      const fileLink = page.getByRole("link", { name: "Open target" }).first();
      await expect(fileLink).toBeVisible({ timeout: 15_000 });
      await fileLink.hover();
      await expect(fileLink).toHaveAttribute("title", "src/target.ts:42-45");
    } finally {
      await workspace.cleanup();
    }
  });

  test("renders a lockfile-sized read-only source with a bounded CodeMirror DOM", async ({
    page,
  }) => {
    const session = await seedMockAgentWorkspace({
      repoPrefix: "file-source-lockfile-",
      title: "Large source",
      initialPrompt: "Generate a title and a git branch name. Return JSON only.",
    });
    const lockfile = `${'{"packages":['}${Array.from({ length: 42_000 }, (_, index) => `{"name":"package-${index}","version":"1.0.0"}`).join(",")}]}`;
    await writeFile(path.join(session.cwd, "package-lock.json"), lockfile, "utf8");

    try {
      await openAgentRoute(page, session);
      await openWorkspaceFile(page, "package-lock.json");

      await expect(page.getByTestId("file-source-editor")).toBeVisible();
      await expect(editor(page)).toContainText('"package-0"');
      await expect.poll(() => page.locator(".cm-line").count()).toBeLessThan(200);
    } finally {
      await session.cleanup();
    }
  });

  test("keeps the app interactive around a plain 11 MB source", async ({ page }) => {
    const session = await seedMockAgentWorkspace({
      repoPrefix: "file-source-plain-",
      title: "Plain large source",
      initialPrompt: "Generate a title and a git branch name. Return JSON only.",
    });
    await writeFile(
      path.join(session.cwd, "plain.txt"),
      "plain source\n".repeat(1_050_000),
      "utf8",
    );

    try {
      await openAgentRoute(page, session);
      await openWorkspaceFile(page, "plain.txt");
      await expect(page.getByTestId("file-source-editor")).toBeVisible();
      await expect(editor(page)).toContainText("plain source");
      await expect.poll(() => page.locator(".cm-line").count()).toBeLessThan(200);

      await page.getByTestId(`workspace-tab-agent_${session.agentId}`).first().click();
      await expect(page.getByTestId("message-input-root")).toBeVisible();
      await page.getByTestId("workspace-tab-file_plain.txt").first().click();
      await expect(page.getByTestId("file-source-editor")).toBeVisible();
    } finally {
      await session.cleanup();
    }
  });

  test("refuses a file above the display budget and keeps its tab recoverable", async ({
    page,
  }) => {
    const session = await seedMockAgentWorkspace({
      repoPrefix: "file-source-unsupported-",
      title: "Unsupported large source",
      initialPrompt: "Generate a title and a git branch name. Return JSON only.",
    });
    await writeFile(path.join(session.cwd, "too-large.txt"), "x".repeat(51 * 1024 * 1024), "utf8");

    try {
      await openAgentRoute(page, session);
      await openWorkspaceFile(page, "too-large.txt");
      await expect(page.getByTestId("file-source-too-large")).toContainText(
        "This file is too large to display",
      );

      await page.getByTestId(`workspace-tab-agent_${session.agentId}`).first().click();
      await expect(page.getByTestId("message-input-root")).toBeVisible();
      await page.getByTestId("workspace-tab-file_too-large.txt").first().click();
      await expect(page.getByTestId("file-source-too-large")).toBeVisible();
    } finally {
      await session.cleanup();
    }
  });

  test("opens an assistant file link at its referenced line", async ({ page }) => {
    const target = "target.ts:42";
    const session = await seedAgentWithFileLink({
      target,
      fileName: "target.ts",
      content: Array.from(
        { length: 80 },
        (_, index) => `export const line${index + 1} = ${index + 1};`,
      ).join("\n"),
    });

    try {
      await openAgentRoute(page, session);

      const fileLink = page.getByText(target, { exact: true });
      await expect(fileLink).toBeVisible({ timeout: 15_000 });
      await fileLink.click();

      await expectFileTabOpen(page, "target.ts");
      await expect(page.getByTestId("file-source-editor")).toBeVisible();
      await expect(page.getByLabel("Line 42, column 1")).toBeVisible();
      await expect(
        page.getByTestId("file-source-editor").locator(".cm-line", { hasText: "line42 = 42" }),
      ).toBeVisible();

      const sourceEditor = editor(page);
      await sourceEditor.click();
      await sourceEditor.press("ControlOrMeta+Home");
      await expect(page.getByLabel(/^Line 1, column \d+$/)).toBeVisible();

      await page
        .getByTestId(`workspace-tab-agent_${session.agentId}`)
        .filter({ visible: true })
        .click();
      await expect(fileLink).toBeVisible();
      await fileLink.click();

      await expect(page.getByLabel("Line 42, column 1")).toBeVisible();
      await expect(
        page.getByTestId("file-source-editor").locator(".cm-line", { hasText: "line42 = 42" }),
      ).toBeVisible();
    } finally {
      await session.cleanup();
    }
  });

  test("clicking the editor focuses its pane beside an agent", async ({ page }) => {
    await page.addInitScript((settingsKey) => {
      localStorage.setItem(
        settingsKey,
        JSON.stringify({ openInSidePane: { explorerFiles: true } }),
      );
    }, APP_SETTINGS_KEY);
    const target = "target.ts:42";
    const session = await seedAgentWithFileLink({
      target,
      fileName: "target.ts",
      content: Array.from(
        { length: 80 },
        (_, index) => `export const line${index + 1} = ${index + 1};`,
      ).join("\n"),
    });

    try {
      await page.setViewportSize({ width: 1280, height: 900 });
      await openAgentRoute(page, session);

      await openWorkspaceFile(page, "target.ts");
      await expect(
        page
          .locator('[data-testid^="workspace-pane-"]')
          .getByTestId("workspace-tabs-row")
          .filter({ visible: true }),
      ).toHaveCount(2);

      await page
        .getByTestId(`workspace-tab-agent_${session.agentId}`)
        .filter({ visible: true })
        .click();
      await editor(page).click();
      await page.keyboard.press("Alt+Shift+W");

      await expect(page.getByTestId("workspace-tab-file_target.ts")).not.toBeVisible();
      await expect(
        page.getByTestId(`workspace-tab-agent_${session.agentId}`).filter({ visible: true }),
      ).toBeVisible();
    } finally {
      await session.cleanup();
    }
  });

  test("opens an HTML line target as source", async ({ page }) => {
    const target = "plan.html:2";
    const session = await seedAgentWithFileLink({
      target,
      fileName: "plan.html",
      content: [
        "<!doctype html>",
        "<h1>Review this source line</h1>",
        '<script>document.body.textContent = "This HTML executed";</script>',
      ].join("\n"),
    });

    try {
      await openAgentRoute(page, session);
      await page.getByText(target, { exact: true }).click();

      await expectFileTabOpen(page, "plan.html");
      await expect(page.getByTestId("file-source-editor")).toBeVisible();
      await expect(page.getByLabel("Line 2, column 1")).toBeVisible();
      await expect(page.getByTestId("file-html-preview")).toHaveCount(0);
    } finally {
      await session.cleanup();
    }
  });

  test("shows the full file path and keeps editor controls stable", async ({
    page,
    withWorkspace,
  }) => {
    await page.emulateMedia({ colorScheme: "dark" });
    const workspace = await withWorkspace({ prefix: "file-editing-visuals-" });
    const relativePath = "src/deep/visuals.md";
    const sourcePath = path.join(workspace.repoPath, relativePath);
    await mkdir(path.dirname(sourcePath), { recursive: true });
    await writeFile(
      sourcePath,
      [...Array.from({ length: 11 }, (_, index) => `line ${index + 1}`), "abcdefghijklmnop"].join(
        "\n",
      ),
      "utf8",
    );
    await workspace.navigateTo();
    await openFileExplorer(page);
    await page.getByTestId("file-explorer-tree-scroll").getByText("src", { exact: true }).click();
    await page.getByTestId("file-explorer-tree-scroll").getByText("deep", { exact: true }).click();
    await openFileFromExplorer(page, "visuals.md");
    await expectFileTabOpen(page, relativePath);

    const fileTab = page.getByTestId(`workspace-tab-file_${relativePath}`).first();
    await fileTab.hover();
    await expect(page.getByTestId(`workspace-tab-tooltip-file_${relativePath}`)).toHaveText(
      relativePath,
    );
    await expect(page.getByTestId("file-panel-bar")).not.toContainText("visuals.md");
    const modeControl = page.getByTestId("file-preview-mode");
    await expect(modeControl).toBeVisible();
    await selectFileView(page, "Source");

    const editorHost = page.getByTestId("file-source-editor");
    const content = editor(page);
    await expect(editorHost).toHaveAttribute("data-pmono", "");
    await expect(content).toHaveCSS("font-family", /SFMono-Regular/);

    await content.click();
    const cursor = editorHost.locator(".cm-cursor-primary");
    await expect(cursor).toBeVisible();
    await expect(cursor).toHaveCSS("border-left-color", "rgb(250, 250, 250)");

    const initialModeBox = await modeControl.boundingBox();
    expect(initialModeBox).not.toBeNull();
    const initialModeX = initialModeBox!.x;
    await content.press("ControlOrMeta+End");
    await expect(page.getByLabel(/Line 12, column \d+/)).toBeVisible();
    const movedModeBox = await modeControl.boundingBox();
    expect(movedModeBox).not.toBeNull();
    expect(movedModeBox!.x).toBe(initialModeX);

    await content.press("ControlOrMeta+a");
    const selection = editorHost.locator(".cm-selectionBackground").first();
    await expect(selection).toBeVisible();
    await expect(selection).toHaveCSS("background-color", "rgba(255, 255, 255, 0.2)");
  });

  test("applies the interface font to portaled tooltips", async ({ page, withWorkspace }) => {
    await page.addInitScript(() => {
      localStorage.setItem("@mixer:app-settings", JSON.stringify({ uiFontFamily: "monospace" }));
    });
    const workspace = await withWorkspace({ prefix: "file-tooltip-font-" });
    const relativePath = "tooltip-font.txt";
    await writeFile(path.join(workspace.repoPath, relativePath), "tooltip font\n", "utf8");
    await workspace.navigateTo();
    await openFileExplorer(page);
    await openFileFromExplorer(page, relativePath);
    await expectFileTabOpen(page, relativePath);

    await page.getByTestId(`workspace-tab-file_${relativePath}`).first().hover();

    await expect(
      page
        .getByTestId(`workspace-tab-tooltip-file_${relativePath}`)
        .getByText(relativePath, { exact: true }),
    ).toHaveCSS("font-family", "monospace");
  });

  test("wraps Markdown while source code remains horizontally scrollable", async ({
    page,
    withWorkspace,
  }) => {
    const workspace = await withWorkspace({ prefix: "file-editing-wrap-" });
    const longLine = "word ".repeat(300);
    await writeFile(path.join(workspace.repoPath, "notes.md"), `${longLine}\n`, "utf8");
    await writeFile(
      path.join(workspace.repoPath, "source.ts"),
      `const value = "${longLine}";\n`,
      "utf8",
    );
    await workspace.navigateTo();
    await openWorkspaceFile(page, "notes.md");
    await selectFileView(page, "Source");

    const markdownScroller = page
      .getByTestId("file-source-editor")
      .filter({ visible: true })
      .locator(".cm-scroller");
    await expect.poll(() => markdownScroller.evaluate(fitsViewportWidth)).toBe(true);

    await openWorkspaceFile(page, "source.ts");
    const sourceScroller = page
      .getByTestId("file-source-editor")
      .filter({ visible: true })
      .locator(".cm-scroller");
    await expect.poll(() => sourceScroller.evaluate(hasHorizontalOverflow)).toBe(true);
  });

  test("autosaves, saves immediately, resolves conflicts, and restores live updates after reconnect", async ({
    page,
    withWorkspace,
  }) => {
    test.setTimeout(120_000);
    const gate = await installDaemonWebSocketGate(page);
    const workspace = await withWorkspace({ prefix: "file-editing-source-" });
    const sourcePath = path.join(workspace.repoPath, "source.ts");
    await writeFile(sourcePath, "const initial = 1;\n", "utf8");
    await Promise.all(
      ["one.ts", "two.ts", "three.ts", "four.ts"].map((fileName) =>
        writeFile(path.join(workspace.repoPath, fileName), `// ${fileName}\n`, "utf8"),
      ),
    );
    await workspace.navigateTo();
    await openWorkspaceFile(page, "source.ts");

    await expect(page.getByTestId("file-source-editor")).toBeVisible();
    await expect(page.getByLabel(/File size/)).toHaveCount(0);
    await expect(page.getByLabel(/lines/)).toHaveCount(0);
    await expect(page.getByTestId("file-preview-mode")).toHaveCount(0);
    await expect(page.getByTestId("file-panel-bar")).toHaveCount(0);

    await replaceEditorText(page, "const autosaved = 2;\n");
    await expect(page.getByTestId("workspace-tab-modified-file_source.ts")).toBeVisible();
    await expect(page.getByTestId("workspace-tab-modified-file_source.ts")).not.toBeVisible();
    await expect.poll(() => readFile(sourcePath, "utf8")).toBe("const autosaved = 2;\n");

    await replaceEditorText(page, "const immediate = 3;\n");
    await editor(page).press("Control+s");
    await expect.poll(() => readFile(sourcePath, "utf8")).toBe("const immediate = 3;\n");

    await writeFile(sourcePath, "const external = 4;\nconst line = 2;\n", "utf8");
    await expect(editor(page)).toContainText("const external = 4;");
    await expect(editor(page)).toContainText("const line = 2;");

    await replaceEditorText(page, "const localWins = 5;\n");
    await writeFile(sourcePath, "const diskLoses = 6;\n", "utf8");
    await expect(page.getByTestId("file-conflict-alert")).toBeVisible();
    await page.getByRole("button", { name: "Overwrite", exact: true }).click();
    await expect.poll(() => readFile(sourcePath, "utf8")).toBe("const localWins = 5;\n");
    for (const fileName of ["one.ts", "two.ts", "three.ts", "four.ts"]) {
      await openWorkspaceFile(page, fileName);
    }
    await openWorkspaceFile(page, "source.ts");
    await expect(editor(page)).toContainText("const localWins = 5;");

    await replaceEditorText(page, "const discarded = 7;\n");
    await writeFile(sourcePath, "const diskWins = 8;\n", "utf8");
    await expect(page.getByTestId("file-conflict-alert")).toBeVisible();
    page.once("dialog", (dialog) => dialog.accept());
    await page.getByRole("button", { name: "Reload", exact: true }).click();
    await expect(editor(page)).toContainText("const diskWins = 8;");

    const subscriptionCount = gate.getClientRequestCount("fs.file.subscribe.request");
    await gate.drop();
    gate.restore();
    await expect
      .poll(() => gate.getClientRequestCount("fs.file.subscribe.request"), { timeout: 30_000 })
      .toBeGreaterThan(subscriptionCount);
    await writeFile(sourcePath, "const afterReconnect = 9;\n", "utf8");
    await expect(editor(page)).toContainText("const afterReconnect = 9;");
  });

  test("preserves a UTF-8 BOM and uses the first line separator after saving", async ({
    page,
    withWorkspace,
  }) => {
    const workspace = await withWorkspace({ prefix: "file-editing-encoding-" });
    const sourcePath = path.join(workspace.repoPath, "windows.ts");
    await writeFile(
      sourcePath,
      Buffer.from("\uFEFFconst initial = true;\r\nconst mixed = true;\n", "utf8"),
    );
    await workspace.navigateTo();
    await openWorkspaceFile(page, "windows.ts");

    await replaceEditorText(page, "const saved = true;\nconst normalized = true;\n");
    await editor(page).press("Control+s");

    const expected = Buffer.from(
      "\uFEFFconst saved = true;\r\nconst normalized = true;\r\n",
      "utf8",
    ).toString("hex");
    await expect.poll(async () => (await readFile(sourcePath)).toString("hex")).toBe(expected);
  });

  test("warns before closing a panel with an unsaved draft", async ({ page, withWorkspace }) => {
    const workspace = await withWorkspace({ prefix: "file-editing-draft-" });
    const sourcePath = path.join(workspace.repoPath, "draft.ts");
    await writeFile(sourcePath, "const initial = 1;\n", "utf8");
    await workspace.navigateTo();
    await openWorkspaceFile(page, "draft.ts");

    await replaceEditorText(page, "const local = 2;\n");
    await writeFile(sourcePath, "const external = 3;\n", "utf8");
    await expect(page.getByTestId("file-conflict-alert")).toBeVisible();
    await expect(page.getByTestId("workspace-tab-modified-file_draft.ts")).toBeVisible();

    let closePrompt = "";
    page.once("dialog", async (dialog) => {
      closePrompt = dialog.message();
      await dialog.dismiss();
    });
    await page
      .getByTestId("workspace-tab-file_draft.ts")
      .filter({ visible: true })
      .first()
      .click({ button: "right" });
    await page.getByRole("menuitem", { name: "Close", exact: true }).click();
    expect(closePrompt).toContain("Closing it will discard the draft.");

    await expect(page.getByTestId("file-source-editor")).toBeVisible();
    await expect(page.getByTestId("workspace-tab-modified-file_draft.ts")).toBeVisible();
  });

  test("refreshes Markdown and images while preserving Preview and Source behavior", async ({
    page,
    withWorkspace,
  }) => {
    test.setTimeout(90_000);
    const gate = await installDaemonWebSocketGate(page);
    const workspace = await withWorkspace({ prefix: "file-editing-preview-" });
    const markdownPath = path.join(workspace.repoPath, "notes.md");
    const imagePath = path.join(workspace.repoPath, "pixel.png");
    await writeFile(markdownPath, "# First heading\n", "utf8");
    await writeFile(imagePath, RED_PIXEL);
    await workspace.navigateTo();
    await openWorkspaceFile(page, "notes.md");

    const visibleFilePane = page.getByTestId("workspace-file-pane").filter({ visible: true });
    const toolbar = page.getByTestId("file-panel-bar").filter({ visible: true });
    await expect(visibleFilePane.getByText("First heading", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Preview", exact: true })).toBeVisible();
    await expect(toolbar.getByLabel(/^File size/)).toHaveCount(0);
    await writeFile(markdownPath, "# Updated heading\n", "utf8");
    await expect(visibleFilePane.getByText("Updated heading", { exact: true })).toBeVisible();

    // Source shows the same read in the editor; the file is not read again.
    const reads = fileReadCount(gate, "notes.md");
    await selectFileView(page, "Source");
    await expect(page.getByTestId("file-source-editor")).toBeVisible();
    await expect(editor(page)).toContainText("# Updated heading");
    await expect(toolbar.getByLabel("Line 1, column 1")).toHaveCount(0);
    expect(fileReadCount(gate, "notes.md")).toBe(reads);

    // Preview shows the edits made in Source.
    await replaceEditorText(page, "# Saved from source\n");
    await expect(page.getByTestId("workspace-tab-modified-file_notes.md")).toBeVisible();
    await selectFileView(page, "Preview");
    await expect(
      visibleFilePane.getByText("Saved from source", { exact: true }).filter({ visible: true }),
    ).toBeVisible();
    await expect(toolbar.getByLabel("Line 1, column 1")).toHaveCount(0);
    await expect.poll(() => readFile(markdownPath, "utf8")).toBe("# Saved from source\n");
    await expect(page.getByTestId("workspace-tab-modified-file_notes.md")).not.toBeVisible();

    await openWorkspaceFile(page, "pixel.png");
    const image = visibleFilePane.locator("img");
    await expect(image).toBeVisible();
    const imageCanvas = page.getByTestId("image-file-preview-canvas");
    await expect(imageCanvas).toBeVisible();
    await imageCanvas.hover();
    const transformedContent = imageCanvas.locator(":scope > div").first();
    const fittedImageBox = await transformedContent.boundingBox();
    expect(fittedImageBox).not.toBeNull();
    await page.getByRole("button", { name: "Zoom in", exact: true }).click();
    await expect
      .poll(async () => (await transformedContent.boundingBox())?.width ?? 0)
      .toBeGreaterThan(fittedImageBox!.width * 1.2);
    const initialSource = await image.getAttribute("src");
    await writeFile(imagePath, BLUE_PIXEL);
    await expect.poll(() => image.getAttribute("src")).not.toBe(initialSource);
  });

  test("renders local relative images inside Markdown preview", async ({ page, withWorkspace }) => {
    test.setTimeout(90_000);
    const workspace = await withWorkspace({ prefix: "file-md-relative-image-" });
    await mkdir(path.join(workspace.repoPath, "docs"), { recursive: true });
    await mkdir(path.join(workspace.repoPath, "data", "cache"), { recursive: true });
    await writeFile(path.join(workspace.repoPath, "docs", "sibling.png"), RED_PIXEL);
    await writeFile(path.join(workspace.repoPath, "data", "cache", "hero.png"), RED_PIXEL);
    await writeFile(
      path.join(workspace.repoPath, "docs", "guide.md"),
      [
        "# Guide",
        "",
        "![sibling](./sibling.png)",
        "",
        "![hero](../data/cache/hero.png?v=2#preview)",
        "",
      ].join("\n"),
      "utf8",
    );
    await workspace.navigateTo();
    await openFileExplorer(page);
    await expandFolder(page, "docs");
    await openFileFromExplorer(page, "guide.md");
    await expectFileTabOpen(page, "docs/guide.md");

    const visibleFilePane = page.getByTestId("workspace-file-pane").filter({ visible: true });
    await expect(visibleFilePane.getByText("Guide", { exact: true })).toBeVisible();
    await expectMarkdownImageLoaded(page, "sibling");
    await expectMarkdownImageLoaded(page, "hero");
    await visibleFilePane.screenshot({
      path: test.info().outputPath("markdown-relative-images.png"),
    });
  });

  test("previews and refreshes an HTML plan while preserving source access", async ({
    page,
    withWorkspace,
  }) => {
    test.setTimeout(90_000);
    const workspace = await withWorkspace({ prefix: "file-editing-html-preview-" });
    const htmlPath = path.join(workspace.repoPath, "plan.html");
    await writeFile(
      htmlPath,
      "<!doctype html><html><body><h1>Visual plan</h1></body></html>",
      "utf8",
    );
    await workspace.navigateTo();
    await openWorkspaceFile(page, "plan.html");

    const preview = htmlPreview(page);
    await expect(preview.host).toBeVisible();
    await expect(preview.host).toHaveAttribute("sandbox", /allow-scripts/);
    await expect(preview.host).not.toHaveAttribute("sandbox", /allow-same-origin/);
    await expect(preview.document.getByRole("heading", { name: "Visual plan" })).toBeVisible();

    await writeFile(
      htmlPath,
      "<!doctype html><html><body><h1>Updated plan</h1></body></html>",
      "utf8",
    );
    await expect(preview.document.getByRole("heading", { name: "Updated plan" })).toBeVisible();

    await selectFileView(page, "Source");
    await expect(page.getByTestId("file-source-editor")).toBeVisible();
    await expect(preview.host).toHaveCount(0);
    await selectFileView(page, "Preview");
    await expect(preview.host).toBeVisible();
  });

  test("runs inline scripts without allowing fetch egress", async ({ page, withWorkspace }) => {
    test.setTimeout(90_000);
    const workspace = await withWorkspace({ prefix: "file-editing-html-csp-" });
    await writeFile(
      path.join(workspace.repoPath, "probe.html"),
      `<!doctype html><html><head><title>probe</title></head><body>
<h1 id="script-result">Inline script did not run</h1>
<p id="network-result">Network request not attempted</p>
<p id="document-mode">Standards mode not detected</p>
<script>
  document.getElementById("script-result").textContent = "Inline script ran";
  if (document.compatMode === "CSS1Compat") {
    document.getElementById("document-mode").textContent = "Standards mode enabled";
  }
  var networkResult = document.getElementById("network-result");
  fetch("${BLOCKED_PREVIEW_URL}", { method: "POST", body: "repo-content" })
    .then(function () { networkResult.textContent = "Network request allowed"; })
    .catch(function () { networkResult.textContent = "Network request blocked"; });
</script>
</body></html>`,
      "utf8",
    );
    await workspace.navigateTo();

    const blockedRequests = watchRequestsTo(page, BLOCKED_PREVIEW_URL);

    await openWorkspaceFile(page, "probe.html");

    const preview = htmlPreview(page);
    await expect(
      preview.document.getByRole("heading", { name: "Inline script ran" }),
    ).toBeVisible();
    await expect(
      preview.document.getByText("Standards mode enabled", { exact: true }),
    ).toBeVisible();
    await expect(
      preview.document.getByText("Network request blocked", { exact: true }),
    ).toBeVisible();
    expect(blockedRequests).toEqual([]);
  });

  test("isolates HTML plans from the app origin and storage", async ({ page, withWorkspace }) => {
    test.setTimeout(90_000);
    const workspace = await withWorkspace({ prefix: "file-editing-html-origin-" });
    await writeFile(
      path.join(workspace.repoPath, "origin.html"),
      `<!doctype html><html><body>
<p id="parent">?</p><p id="storage">?</p><p id="cookie">?</p>
<script>
  function report(id, label, probe) {
    try { probe(); document.getElementById(id).textContent = label + " reachable"; }
    catch (error) { document.getElementById(id).textContent = label + " blocked"; }
  }
  report("parent", "Parent DOM", function () { return parent.document.body; });
  report("storage", "Storage", function () { return localStorage.length; });
  report("cookie", "Cookies", function () { return document.cookie; });
</script>
</body></html>`,
      "utf8",
    );
    await workspace.navigateTo();
    await openWorkspaceFile(page, "origin.html");

    const preview = htmlPreview(page);
    await expect(preview.document.getByText("Parent DOM blocked", { exact: true })).toBeVisible();
    await expect(preview.document.getByText("Storage blocked", { exact: true })).toBeVisible();
    await expect(preview.document.getByText("Cookies blocked", { exact: true })).toBeVisible();
  });

  test("persists Vim keybindings and reports Vim mode with cursor position", async ({
    page,
    withWorkspace,
  }) => {
    test.setTimeout(90_000);
    const workspace = await withWorkspace({ prefix: "file-editing-vim-" });
    await writeFile(path.join(workspace.repoPath, "vim.ts"), "const vim = true;\n", "utf8");

    await page.goto("/settings/editor");
    const toggle = page.getByRole("switch", { name: "Vim keybindings" });
    await expect(toggle).toBeVisible();
    await toggle.click();
    await expect(toggle).toBeChecked();
    await page.reload();
    await expect(page.getByRole("switch", { name: "Vim keybindings" })).toBeChecked();

    await workspace.navigateTo();
    await openWorkspaceFile(page, "vim.ts");
    await expect(page.getByLabel("Vim mode NORMAL")).toBeVisible();
    await expect(page.getByLabel("Line 1, column 1")).toBeVisible();
    await editor(page).click();
    await editor(page).press("i");
    await expect(page.getByLabel("Vim mode INSERT")).toBeVisible();
    await editor(page).press("Escape");
    await expect(page.getByLabel("Vim mode NORMAL")).toBeVisible();
  });
});

async function openAssistantMarkdownLink(page: Page, name: string): Promise<void> {
  await page.getByRole("link", { name, exact: true }).first().click();
}

async function returnToAssistant(page: Page, agentId: string): Promise<void> {
  await page.getByTestId(`workspace-tab-agent_${agentId}`).filter({ visible: true }).click();
}

async function openAssistantInlinePath(page: Page, token: string): Promise<void> {
  await page.getByText(token, { exact: true }).click();
}

async function expectPreviewText(page: Page, text: string): Promise<void> {
  await expect(
    page
      .getByTestId("workspace-file-pane")
      .filter({ visible: true })
      .getByText(text, { exact: true }),
  ).toBeVisible();
}
