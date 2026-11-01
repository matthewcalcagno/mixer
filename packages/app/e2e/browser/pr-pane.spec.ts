import { expect, test, type Page } from "../support/fixtures";
import { z } from "zod";
import { seedWorkspace } from "../support/helpers/seed-client";
import { installDaemonWebSocketGate } from "../support/helpers/daemon-websocket-gate";
import { gotoAppShell } from "../support/helpers/app";
import { waitForSidebarHydration } from "../support/helpers/workspace-ui";
import { selectWorkspaceInSidebar } from "../support/helpers/sidebar";
import { openFileExplorer } from "../support/helpers/file-explorer";
import {
  openPrPane,
  expectPrPaneTitle,
  expectPrPaneState,
  expectPrPaneChecks,
  expectPrPaneActivity,
} from "../support/helpers/pr-pane";
import { gotoWorkspace } from "../support/helpers/launcher";
import {
  hasGithubAuth,
  createTempGithubRepo,
  type GhRepoFixture,
} from "../support/helpers/github-fixtures";
import {
  connectWorkspaceSetupClient,
  openProjectViaDaemon,
  type WorkspaceSetupDaemonClient,
} from "../support/helpers/workspace-setup";

const GITHUB_AUTH = hasGithubAuth();

async function moveActivityDivider(page: Page, offset: number) {
  const divider = page.getByTestId("pr-pane-activity-divider").getByRole("separator");
  const bounds = await divider.boundingBox();
  if (!bounds) throw new Error("Missing Activity resize handle");
  const x = bounds.x + bounds.width / 2;
  const y = bounds.y + bounds.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x, y + offset, { steps: 10 });
  await page.mouse.up();
}

test("Pull request keeps refresh in its content without a View toolbar", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ colorScheme: "dark" });
  const workspace = await seedWorkspace({ repoPrefix: "pr-content-header-" });
  const gate = await installDaemonWebSocketGate(page);
  gate.transformServerMessages((message) => {
    if (typeof message !== "string") return message;
    const parsed = z
      .object({
        message: z
          .object({ type: z.string(), payload: z.record(z.string(), z.unknown()) })
          .passthrough(),
      })
      .passthrough()
      .safeParse(JSON.parse(message));
    if (!parsed.success) return message;
    const response = parsed.data.message;
    if (response.type === "checkout_pr_status_response") {
      response.payload = {
        ...response.payload,
        error: null,
        githubFeaturesEnabled: true,
        forge: "github",
        status: {
          forge: "github",
          number: 528,
          url: "https://github.com/acme/repo/pull/528",
          title: "Add tenant and store",
          state: "open",
          isMerged: false,
          isDraft: true,
          baseRefName: "main",
          headRefName: "feature",
          mergeable: "UNKNOWN",
          checks: Array.from({ length: 24 }, (_, index) => ({
            name:
              index === 0 ? "A very long check name that competes for row width" : `Check ${index}`,
            status: "success",
            url: null,
            workflow: index % 2 === 0 ? "CI" : "a-very-long-workflow-name-for-constrained-rows",
            duration: "1s",
          })),
          reviewDecision: null,
          repoOwner: "acme",
          repoName: "repo",
        },
      };
    } else if (response.type === "pull_request_timeline_response") {
      response.payload = {
        ...response.payload,
        prNumber: 528,
        items: [],
        truncated: false,
        error: null,
        githubFeaturesEnabled: true,
      };
    } else return message;
    return JSON.stringify(parsed.data);
  });
  try {
    await gotoAppShell(page);
    await waitForSidebarHydration(page);
    await selectWorkspaceInSidebar(page, workspace.workspaceId);
    await openFileExplorer(page);
    const tab = page.getByTestId("workspace-tab-pull_request").filter({ visible: true });
    await expect(tab).toHaveAttribute("aria-label", "Pull request #528", { timeout: 15_000 });
    await tab.click();
    const pane = page.getByTestId("pr-pane").filter({ visible: true });
    await expect(pane.getByTestId("pr-pane-title")).toContainText("Add tenant and store");
    const iconSizes = await pane.getByTestId("pr-pane-check-row").evaluateAll((rows) =>
      rows.map((row) => {
        const icon = row.querySelector("svg");
        if (!icon) throw new Error("Missing check status icon");
        const bounds = icon.getBoundingClientRect();
        return { width: bounds.width, height: bounds.height };
      }),
    );
    expect(iconSizes).toEqual(Array.from({ length: 24 }, () => ({ width: 14, height: 14 })));
    await expect(
      pane.getByTestId("pr-pane-header").getByText("acme/repo", { exact: true }),
    ).toHaveCount(0);
    await expect(pane.getByTestId("pr-pane-toolbar")).toHaveCount(0);
    await expect(pane.getByTestId("pr-pane-view-pr")).toHaveCount(0);
    const refresh = pane.getByTestId("pr-pane-header").getByTestId("pr-pane-refresh");
    await expect(refresh).toBeVisible();
    const before = gate.getClientRequestCount("checkout.refresh.request");
    await refresh.click();
    await expect
      .poll(() => gate.getClientRequestCount("checkout.refresh.request"))
      .toBeGreaterThan(before);
    await expect(refresh).toBeEnabled();
    const activity = pane.getByTestId("pr-pane-activity-section");
    const expandedBounds = await activity.boundingBox();
    if (!expandedBounds) throw new Error("Missing expanded Activity");
    const details = pane.getByTestId("pr-pane-details-scroll");
    const initialDetails = await details.boundingBox();
    if (!initialDetails) throw new Error("Missing PR details");
    await expect(pane.getByText("Check 15", { exact: true })).not.toBeInViewport();
    await activity.getByText("Activity", { exact: true }).click();
    await expect(activity.getByText("No activity yet", { exact: true })).toHaveCount(0);
    await expect
      .poll(async () => {
        const paneBounds = await pane.boundingBox();
        const activityBounds = await activity.boundingBox();
        if (!paneBounds || !activityBounds) return -1;
        return Math.round(
          paneBounds.y + paneBounds.height - activityBounds.y - activityBounds.height,
        );
      })
      .toBe(0);
    await expect
      .poll(async () => (await details.boundingBox())?.height ?? 0)
      .toBeGreaterThan(initialDetails.height + 200);
    await expect(pane.getByText("Check 15", { exact: true })).toBeInViewport();
    await page.mouse.move(700, 300);
    await page.screenshot({ path: test.info().outputPath("pull-request-collapsed-activity.png") });
    await activity.getByText("Activity", { exact: true }).click();
    await expect(activity.getByText("No activity yet", { exact: true })).toBeVisible();
    await expect
      .poll(async () => (await activity.boundingBox())?.y)
      .toBeCloseTo(expandedBounds.y, 0);
    await moveActivityDivider(page, -100);
    await expect
      .poll(async () => (await activity.boundingBox())?.y ?? Infinity)
      .toBeLessThan(expandedBounds.y - 70);
    const raisedBounds = await activity.boundingBox();
    if (!raisedBounds) throw new Error("Missing resized Activity");
    await moveActivityDivider(page, 160);
    await expect
      .poll(async () => (await activity.boundingBox())?.y ?? 0)
      .toBeGreaterThan(raisedBounds.y + 100);
    await activity.getByText("Activity", { exact: true }).click();
    await expect(activity.getByText("No activity yet", { exact: true })).toHaveCount(0);
    await moveActivityDivider(page, -140);
    await expect(activity.getByText("No activity yet", { exact: true })).toBeVisible();
    await page.mouse.move(700, 300);
    await page.screenshot({ path: test.info().outputPath("pull-request-content-refresh.png") });
  } finally {
    await workspace.cleanup();
  }
});

test.describe("PR pane", () => {
  test.describe.configure({ retries: 1 });

  let seedClient: WorkspaceSetupDaemonClient;
  let repoFixture: GhRepoFixture;
  const workspaceByTitle = new Map<string, string>();

  test.beforeAll(async () => {
    if (!GITHUB_AUTH) return;

    seedClient = await connectWorkspaceSetupClient();

    repoFixture = await createTempGithubRepo({
      category: "pr-pane",
      prs: [
        { title: "Review selected start ref", state: "open" },
        { title: "Merged feature branch", state: "merged" },
        { title: "Closed without merge", state: "closed" },
        { title: "Work in progress", state: "draft" },
        {
          title: "PR with mixed checks",
          state: "open",
          checks: [
            { context: "build-1", state: "success" },
            { context: "build-2", state: "success" },
            { context: "deploy", state: "failure" },
            { context: "security", state: "pending" },
          ],
        },
        { title: "PR with reviews", state: "open", commentCount: 3 },
      ],
    });

    for (const pr of repoFixture.prs) {
      const workspace = await openProjectViaDaemon(seedClient, pr.localPath);
      workspaceByTitle.set(pr.title, workspace.id);
    }
  });

  test.afterAll(async () => {
    await repoFixture?.cleanup().catch(() => undefined);
    await seedClient?.close().catch(() => undefined);
  });

  test.beforeEach(async () => {
    test.skip(!GITHUB_AUTH, "Requires GitHub authentication (gh auth login)");
    test.setTimeout(60_000);
  });

  test("renders an open PR with title, state, and repo line", async ({ page }) => {
    await gotoWorkspace(page, workspaceByTitle.get("Review selected start ref")!);
    await openPrPane(page);

    await expectPrPaneTitle(page, "Review selected start ref");
    await expectPrPaneState(page, "open");
  });

  test("renders merged state label and icon", async ({ page }) => {
    await gotoWorkspace(page, workspaceByTitle.get("Merged feature branch")!);
    await openPrPane(page);

    await expectPrPaneState(page, "merged");
    await expectPrPaneTitle(page, "Merged feature branch");
  });

  test("renders closed state label and icon", async ({ page }) => {
    await gotoWorkspace(page, workspaceByTitle.get("Closed without merge")!);
    await openPrPane(page);

    await expectPrPaneState(page, "closed");
    await expectPrPaneTitle(page, "Closed without merge");
  });

  test("renders draft state label and icon", async ({ page }) => {
    await gotoWorkspace(page, workspaceByTitle.get("Work in progress")!);
    await openPrPane(page);

    await expectPrPaneState(page, "draft");
    await expectPrPaneTitle(page, "Work in progress");
  });

  test("renders seeded checks in their success, failure, and pending groups", async ({ page }) => {
    await gotoWorkspace(page, workspaceByTitle.get("PR with mixed checks")!);
    await openPrPane(page);

    await expectPrPaneChecks(page, {
      success: ["build-1", "build-2"],
      failure: ["deploy"],
      pending: ["security"],
    });
  });

  test("renders every seeded activity comment", async ({ page }) => {
    await gotoWorkspace(page, workspaceByTitle.get("PR with reviews")!);
    await openPrPane(page);

    await expectPrPaneActivity(page, ["Test comment 1", "Test comment 2", "Test comment 3"]);
  });
});
