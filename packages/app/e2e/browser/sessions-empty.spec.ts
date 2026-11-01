import { randomUUID } from "node:crypto";
import { expect } from "@playwright/test";
import { metroTest as test } from "../support/fixtures";
import { expectSessionsEmptyState, openSessions } from "../support/helpers/archive-tab";
import { gotoAppShell } from "../support/helpers/app";
import { buildCreateAgentPreferences, buildSeededHost } from "../support/helpers/daemon-registry";
import { startIsolatedHostDaemon } from "../support/helpers/isolated-host-daemon";
import { seedWorkspace } from "../support/helpers/seed-client";

test("Sessions shows an empty placeholder when the host has no history", async ({ page }) => {
  const serverId = `srv_sessions_empty_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const daemon = await startIsolatedHostDaemon(serverId);
  let workspace: Awaited<ReturnType<typeof seedWorkspace>> | null = null;

  try {
    workspace = await seedWorkspace({
      repoPrefix: "sessions-empty-",
      port: daemon.port,
    });
    const host = buildSeededHost({
      serverId,
      endpoint: `127.0.0.1:${daemon.port}`,
      nowIso: new Date().toISOString(),
    });
    await page.route(/:6767\b/, (route) => route.abort());
    await page.routeWebSocket(/:6767\b/, async (webSocket) => {
      await webSocket.close({ code: 1008, reason: "Blocked developer daemon during e2e." });
    });
    await page.addInitScript(
      ({ seededHost, preferences }) => {
        localStorage.setItem("@mixer:e2e", "1");
        localStorage.setItem("@mixer:daemon-registry", JSON.stringify([seededHost]));
        localStorage.setItem("@mixer:create-agent-preferences", JSON.stringify(preferences));
      },
      { seededHost: host, preferences: buildCreateAgentPreferences() },
    );

    await gotoAppShell(page);
    await openSessions(page);
    await expectSessionsEmptyState(page);
    const empty = page.getByTestId("sessions-empty");
    const back = empty.getByRole("button", { name: "Back", exact: true });
    const importButton = empty.getByRole("button", { name: "Import session", exact: true });
    await expect(back).toBeVisible();
    await expect(importButton).toBeVisible();
    const backBounds = await back.boundingBox();
    const importBounds = await importButton.boundingBox();
    expect(backBounds).not.toBeNull();
    expect(importBounds).not.toBeNull();
    expect(backBounds?.y).toBe(importBounds?.y);
  } finally {
    await workspace?.cleanup();
    await daemon.close();
  }
});
