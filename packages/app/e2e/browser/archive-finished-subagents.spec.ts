import { installLocalDesktopHost } from "../support/helpers/local-desktop-host";
import type { ActionContextMenuRequest } from "../../../desktop/src/features/action-context-menu";
import { expect, test } from "../support/fixtures";
import { openAgentRoute } from "../support/helpers/mock-agent";
import { seedWorkspace, type SeededWorkspace } from "../support/helpers/seed-client";
import {
  archiveFinishedSubagents,
  expectArchiveFinishedInProgress,
  expectArchiveFinishedRetry,
  expectManagedSubagentArchived,
  expectManagedSubagentUnarchived,
  expectSubagentRowGone,
  expectSubagentRowVisible,
  holdManagedSubagentArchiveRequest,
  openSubagentsTrack,
  rejectNextManagedSubagentArchiveRequest,
  seedParentWithSubagent,
} from "../support/helpers/subagents";

test.describe("Archive finished subagents", () => {
  let workspace: SeededWorkspace;

  test.beforeAll(async () => {
    workspace = await seedWorkspace({ repoPrefix: "archive-finished-subagents-" });
  });

  test.afterAll(async () => {
    await workspace?.cleanup();
  });

  test("native subagent menu enables navigation and archive finished", async ({ page }) => {
    const agents = await seedParentWithSubagent(workspace, {
      parentTitle: "Native archive parent",
      childTitle: "Native finished child",
    });
    await workspace.client.waitForAgentUpsert(
      agents.child.id,
      (snapshot) => snapshot.status === "idle",
    );
    await installLocalDesktopHost(page, workspace.repoPath);
    let captured: ActionContextMenuRequest | undefined;
    await page.exposeFunction("selectSubagentArchive", (request: ActionContextMenuRequest) => {
      captured = request;
      for (const item of request.items) {
        if (item.label === "Archive finished subagents") return item.id;
      }
      return null;
    });
    await page.addInitScript(() => {
      const host = window as unknown as {
        mixerDesktop: { menu: unknown };
        selectSubagentArchive(request: unknown): Promise<string | null>;
      };
      host.mixerDesktop.menu = {
        showContextMenu: (request: unknown) => host.selectSubagentArchive(request),
      };
    });
    await openAgentRoute(page, { workspaceId: agents.workspaceId, agentId: agents.parent.id });
    await page.getByTestId("subagents-track-header").click();
    await expect
      .poll(() => {
        for (const item of captured?.items ?? []) {
          if (item.label === "Archive finished subagents") return !item.disabled;
        }
        return false;
      })
      .toBe(true);
    expect(
      captured?.items.some(
        (item) => item.label.includes("Native finished child") && !item.disabled,
      ),
    ).toBe(true);
    await expectManagedSubagentArchived(workspace, agents.child.id);
  });

  test("archives a finished managed child from the track", async ({ page }) => {
    const agents = await seedParentWithSubagent(workspace, {
      parentTitle: "Archive parent",
      childTitle: "Finished child",
    });
    await workspace.client.waitForAgentUpsert(
      agents.child.id,
      (snapshot) => snapshot.status === "idle",
    );

    const archiveGate = await holdManagedSubagentArchiveRequest(page, agents.child.id);
    await openAgentRoute(page, { workspaceId: agents.workspaceId, agentId: agents.parent.id });
    await openSubagentsTrack(page);
    await expectSubagentRowVisible(page, agents.child.id);

    await archiveFinishedSubagents(page);
    await archiveGate.waitForRequest();

    await expectSubagentRowGone(page, agents.child.id);
    await expectArchiveFinishedInProgress(page, 0, 1);
    await expectManagedSubagentUnarchived(workspace, agents.child.id);
    archiveGate.release();
    await expectManagedSubagentArchived(workspace, agents.child.id);
  });

  test("restores a failed child and retries the archive", async ({ page }) => {
    const agents = await seedParentWithSubagent(workspace, {
      parentTitle: "Retry parent",
      childTitle: "Retry child",
    });
    await workspace.client.waitForAgentUpsert(
      agents.child.id,
      (snapshot) => snapshot.status === "idle",
    );

    const rejection = await rejectNextManagedSubagentArchiveRequest(page, agents.child.id);
    await openAgentRoute(page, { workspaceId: agents.workspaceId, agentId: agents.parent.id });
    await openSubagentsTrack(page);
    await expectSubagentRowVisible(page, agents.child.id);

    await archiveFinishedSubagents(page);
    await rejection.waitForRejection();

    await expectSubagentRowVisible(page, agents.child.id);
    await expectArchiveFinishedRetry(page, 1, 1);
    await archiveFinishedSubagents(page);

    await expectSubagentRowGone(page, agents.child.id);
    await expectManagedSubagentArchived(workspace, agents.child.id);
  });
});
