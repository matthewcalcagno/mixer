import { expect, type Locator, type Page } from "@playwright/test";

const CHANGELOG_SOURCE_URL =
  "https://raw.githubusercontent.com/matthewcalcagno/mixer/v0.1.0/CHANGELOG.md";

/**
 * Serves a changelog to the app instead of the repository's.
 *
 * The sheet renders whatever the document contains, so a fixture is how a test
 * states which authoring shapes it cares about.
 */
export async function serveChangelog(page: Page, lines: string[]): Promise<void> {
  await page.route("https://api.github.com/repos/matthewcalcagno/mixer/releases/latest", (route) =>
    route.fulfill({ json: { tag_name: "v0.1.0" } }),
  );
  await page.route(CHANGELOG_SOURCE_URL, (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/plain",
      body: "# Mixer Changelog\n\n" + lines.filter((line) => !line.startsWith("# ")).join("\n"),
    }),
  );
}

export async function openWhatsNew(page: Page): Promise<Locator> {
  await page.getByTestId("sidebar-help").click();
  await expect(page.getByTestId("sidebar-help-menu")).toBeVisible();
  await page.getByTestId("sidebar-help-changelog").click();

  const sheet = page.getByTestId("changelog-sheet");
  await expect(sheet).toBeVisible();
  return sheet;
}

export function release(sheet: Locator, version: string): Locator {
  return sheet.getByTestId(`changelog-release-${version}`);
}
