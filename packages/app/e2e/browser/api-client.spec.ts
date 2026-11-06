import { createServer } from "node:http";
import { once } from "node:events";
import { expect, test } from "../support/fixtures";

// Uses the bundled plugin and the worker's isolated daemon; requests leave the renderer via RPC.
test("API Client sends requests and restores collections, variables, history, and tabs", async ({
  page,
}, testInfo) => {
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    if (request.url === "/html") {
      response.setHeader("Content-Type", "text/html");
      response.end(
        "<!DOCTYPE html><html><head><style>body { color: #1a73e8; }</style><script>const value = 42;</script></head><body><h1>Hello</h1></body></html>",
      );
      return;
    }
    if (request.url === "/slow") {
      const timer = setTimeout(() => response.end("late"), 5000);
      response.once("close", () => clearTimeout(timer));
      return;
    }
    response.setHeader("Content-Type", "application/json");
    response.end(
      JSON.stringify({
        method: request.method,
        url: request.url,
        body: Buffer.concat(chunks).toString(),
        authorization: request.headers.authorization,
      }),
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No HTTP fixture address");
  const origin = `http://127.0.0.1:${address.port}`;
  try {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto("/");
    const sidebar = page
      .getByTestId("plugin-sidebar-api-client-api-client")
      .filter({ visible: true });
    await expect(sidebar).toBeVisible({ timeout: 30000 });
    await sidebar.click();
    const client = page.getByTestId("api-client");
    await expect(client).toBeVisible();
    await expect(client.locator("main").getByLabel("Active environment")).toHaveCount(0);
    await expect(
      page
        .getByRole("complementary", { name: "API Client library" })
        .getByLabel("Active environment"),
    ).toBeVisible();
    await expect(client).toHaveCSS("font-size", "13px");
    const mainIsland = page.getByTestId("api-client-main-island");
    const libraryIsland = page.getByTestId("api-client-library-island");
    await expect(mainIsland).toHaveCSS("border-top-width", "1px");
    await expect(libraryIsland).toHaveCSS("border-top-width", "1px");
    await expect(page.getByTestId("plugin-main-island")).toHaveCSS("border-top-width", "0px");
    const mainBounds = await mainIsland.boundingBox();
    const libraryBounds = await libraryIsland.boundingBox();
    expect(mainBounds).not.toBeNull();
    expect(libraryBounds).not.toBeNull();
    expect(libraryBounds!.x - (mainBounds!.x + mainBounds!.width)).toBeCloseTo(6, 0);
    const method = client.getByLabel("HTTP method");
    const arrow = client.locator(".ac-method-chevron");
    expect(await arrow.evaluate((element) => getComputedStyle(element).color)).not.toBe(
      await method.evaluate((element) => getComputedStyle(element).color),
    );
    const resize = page.getByTestId("workspace-explorer-sidebar-resize-handle");
    const resizeBounds = await resize.boundingBox();
    if (!resizeBounds) throw new Error("Library resize handle is missing");
    await page.mouse.move(resizeBounds.x + resizeBounds.width / 2, resizeBounds.y + 150);
    await page.mouse.down();
    await page.mouse.move(resizeBounds.x - 70, resizeBounds.y + 150);
    await page.mouse.up();
    await expect
      .poll(async () => (await libraryIsland.boundingBox())!.width)
      .toBeGreaterThan(libraryBounds!.width + 50);
    const resizedWidth = (await libraryIsland.boundingBox())!.width;
    await client.getByLabel("Request URL").focus();
    await page.keyboard.press("Control+Backquote");
    await expect(libraryIsland).toBeHidden();
    await page.keyboard.press("Control+Backquote");
    await expect(libraryIsland).toBeVisible();
    expect((await libraryIsland.boundingBox())!.width).toBeCloseTo(resizedWidth, 0);
    const library = page.getByRole("complementary", { name: "API Client library" });
    await library.getByRole("tab", { name: "Environments", exact: true }).click();
    await library.getByRole("button", { name: "New environment", exact: true }).click();
    await page.getByLabel("Environment name", { exact: true }).fill("Local");
    await page.getByRole("button", { name: "Add variable", exact: true }).click();
    await page.getByLabel("variable key 1", { exact: true }).fill("baseUrl");
    await page.getByLabel("variable value 1", { exact: true }).fill(origin);
    await page.getByRole("button", { name: "Save variables", exact: true }).click();
    await client.getByLabel("Active environment").selectOption({ label: "Local" });
    await client.getByLabel("Request URL", { exact: true }).fill("{{baseUrl}}/echo?hello=world");
    await expect(client.getByLabel("parameter key 1", { exact: true })).toHaveValue("hello");
    await client.getByLabel("parameter value 1", { exact: true }).fill("updated");
    await expect(client.getByLabel("Request URL", { exact: true })).toHaveValue(
      "{{baseUrl}}/echo?hello=updated",
    );
    await client.getByLabel("parameter value 1", { exact: true }).fill("world");
    await client.getByLabel("HTTP method").selectOption("GET");
    const getColor = await client
      .getByLabel("HTTP method")
      .evaluate((element) => getComputedStyle(element).color);
    await client.getByLabel("HTTP method").selectOption("POST");
    await expect
      .poll(() =>
        client.getByLabel("HTTP method").evaluate((element) => getComputedStyle(element).color),
      )
      .not.toBe(getColor);
    await client
      .locator(".ac-request-options")
      .getByRole("tab", { name: "Body", exact: true })
      .click();
    await client.getByRole("radio", { name: "raw", exact: true }).check();
    await client.getByLabel("Raw body format").selectOption("json");
    await client.getByLabel("Request body", { exact: true }).fill('{"broken": }');
    await expect(client.locator(".ac-code-error")).toContainText("Unexpected token");
    await page.screenshot({ path: testInfo.outputPath("api-client-json-diagnostics.png") });
    await client.getByLabel("Request body", { exact: true }).fill('{"message":"hello"}');
    await expect(client.locator(".ac-code-error")).toHaveCount(0);
    await client.getByRole("button", { name: "Format", exact: true }).click();
    await expect(client.getByLabel("Request body", { exact: true })).toContainText(
      '"message": "hello"',
    );
    await client.getByLabel("Request body", { exact: true }).fill('{"message":"hello"}');
    await client.getByRole("radio", { name: "form-data", exact: true }).check();
    await client.getByLabel("field key 1", { exact: true }).fill("upload");
    await client.getByLabel("field file 1", { exact: true }).setInputFiles({
      name: "sample.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("upload payload"),
    });
    await expect(client.getByRole("button", { name: "sample.txt", exact: true })).toBeVisible();
    await expect(client.getByLabel("field value 1", { exact: true })).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath("api-client-multipart.png") });
    await client.getByRole("radio", { name: "raw", exact: true }).check();
    await client.getByRole("tab", { name: "Authorization", exact: true }).click();
    await client.getByLabel("Authorization type").selectOption("api-key");
    await expect(client.getByLabel("Authorization configured", { exact: true })).toHaveCount(0);
    await client.getByLabel("API key name", { exact: true }).fill("X-API-Key");
    await client.getByLabel("API key value", { exact: true }).fill("fixture-key");
    await client.getByLabel("API key location", { exact: true }).selectOption("query");
    await expect(client.getByLabel("Authorization configured", { exact: true })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("api-client-api-key.png") });
    await client.getByLabel("Authorization type").selectOption("basic");
    await client.getByLabel("Auth username", { exact: true }).fill("fixture");
    await client.getByLabel("Auth password", { exact: true }).fill("fixture-password");
    await client.getByLabel("Authorization type").selectOption("bearer");
    await client.getByLabel("Bearer token").fill("fixture-token");
    await expect(client.getByLabel("Authorization configured", { exact: true })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("api-client-authorization.png") });
    await client
      .locator(".ac-request-options")
      .getByRole("tab", { name: "Headers", exact: true })
      .click();
    await client.getByRole("button", { name: /\d+ hidden/ }).click();
    await expect(
      client.locator(".ac-generated-header").filter({ hasText: "User-Agent" }),
    ).toContainText("Mixer");
    await client.getByLabel("header key 1", { exact: true }).fill("X-UI-Test");
    await client.getByLabel("header value 1", { exact: true }).fill("present");
    await expect(client.getByLabel("Headers configured", { exact: true })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("api-client-generated-headers.png") });
    await client
      .locator(".ac-request-options")
      .getByRole("tab", { name: "Settings", exact: true })
      .click();
    await expect(client.getByText("Request timeout", { exact: true })).toBeVisible();
    await expect(client.getByText("Automatically follow redirects", { exact: true })).toBeVisible();
    const followRedirects = client.getByRole("switch", {
      name: "Automatically follow redirects",
      exact: true,
    });
    await expect(followRedirects).toBeChecked();
    await followRedirects.click();
    await expect(followRedirects).not.toBeChecked();
    await followRedirects.click();
    await page.screenshot({ path: testInfo.outputPath("api-client-request-settings.png") });

    await client.getByRole("button", { name: "Send", exact: true }).click();
    await expect(client.getByTestId("api-response-status")).toContainText("200");
    await expect(client.getByLabel("Response body", { exact: true })).toBeVisible();
    await expect
      .poll(() => client.getByLabel("Response body", { exact: true }).locator("span").count())
      .toBeGreaterThan(0);
    await expect(client.getByRole("region", { name: "Response" })).toContainText(
      "Bearer fixture-token",
    );
    await expect(client.getByRole("region", { name: "Response" })).toContainText("hello=world");
    await client.getByRole("button", { name: "Save", exact: true }).click();
    await page.getByLabel("Saved request name").fill("Echo JSON");
    await expect(page.locator(".ac-dialog")).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    await expect(page.locator(".ac-dialog")).toHaveCSS("font-size", "14px");
    await page.screenshot({ path: testInfo.outputPath("api-client-save-dialog.png") });
    await page.getByRole("button", { name: "Save request", exact: true }).click();
    await library.getByRole("tab", { name: "Collections", exact: true }).click();
    await expect(
      library.getByRole("button", { name: "POST Echo JSON", exact: true }),
    ).toBeVisible();
    await client
      .locator(".ac-request-options")
      .getByRole("tab", { name: "Body", exact: true })
      .click();
    await page.screenshot({ path: testInfo.outputPath("api-client-request.png") });
    const divider = client.getByRole("separator", { name: "Resize request and response" });
    await divider.focus();
    await divider.press("ArrowDown");
    await expect(divider).toHaveAttribute("aria-valuenow", "53");
    const handle = await divider.boundingBox();
    if (!handle) throw new Error("Split handle is missing");
    await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
    await page.mouse.down();
    await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2 + 50);
    await page.mouse.up();
    await expect.poll(() => divider.getAttribute("aria-valuenow").then(Number)).toBeGreaterThan(53);
    await client.getByRole("button", { name: "Show request and response side by side" }).click();
    await expect(divider).toHaveAttribute("aria-orientation", "vertical");
    await page.screenshot({ path: testInfo.outputPath("api-client-columns.png") });
    await client.getByRole("button", { name: "Stack request and response" }).click();
    const splitBounds = await client.locator(".ac-editor-split").boundingBox();
    const bottomHandle = await divider.boundingBox();
    if (!splitBounds || !bottomHandle) throw new Error("Split bounds are missing");
    await page.mouse.move(
      bottomHandle.x + bottomHandle.width / 2,
      bottomHandle.y + bottomHandle.height / 2,
    );
    await page.mouse.down();
    await page.mouse.move(
      bottomHandle.x + bottomHandle.width / 2,
      splitBounds.y + splitBounds.height - 2,
    );
    await page.mouse.up();
    await expect(client.getByRole("region", { name: "Response" })).toHaveAttribute(
      "data-collapsed",
      "true",
    );
    await expect(client.getByRole("tablist", { name: "Response sections" })).toBeVisible();
    await expect(client.getByTestId("api-response-body")).toBeHidden();
    await expect(client.getByTestId("api-response-status")).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("api-client-response-collapsed.png") });
    await divider.press("ArrowUp");
    await expect(client.getByTestId("api-response-body")).toBeVisible();

    await client.getByRole("button", { name: "New API request", exact: true }).click();
    await client.getByLabel("Request URL", { exact: true }).fill(`${origin}/slow`);
    const closeDialog = page.waitForEvent("dialog");
    page.once("dialog", (dialog) => void dialog.dismiss());
    await client.getByRole("button", { name: "Close Untitled request", exact: true }).click();
    expect((await closeDialog).message()).toContain("Close request?");
    await expect(client.getByLabel("Request URL", { exact: true })).toHaveValue(`${origin}/slow`);
    await client.getByRole("button", { name: "Send", exact: true }).click();
    await client.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(client.getByRole("alert")).toContainText("cancelled");
    await page.reload();
    await expect(client).toBeVisible({ timeout: 30000 });
    await expect(
      client.getByRole("tablist", { name: "API request tabs" }).getByRole("tab"),
    ).toHaveCount(2);
    await expect(client.getByLabel("Active environment")).toHaveValue(/.+/);
    await library.getByRole("tab", { name: "History", exact: true }).click();
    await expect(library.getByText("Last 2 requests", { exact: true })).toBeVisible();
    await library.getByRole("tab", { name: "Collections", exact: true }).click();
    await library.getByRole("button", { name: "POST Echo JSON", exact: true }).click();
    await expect(client.getByLabel("Request body", { exact: true })).toHaveCount(0);
    await client
      .locator(".ac-request-options")
      .getByRole("tab", { name: "Body", exact: true })
      .click();
    await expect(client.getByLabel("Request body", { exact: true })).toHaveText(
      '{"message":"hello"}',
    );
    await client.getByRole("button", { name: "Send", exact: true }).click();
    await expect(client.getByTestId("api-response-status")).toContainText("200");
    const lightBackground = await mainIsland.evaluate(
      (element) => getComputedStyle(element).backgroundColor,
    );
    await page.evaluate(() => {
      const key = "@mixer:app-settings";
      const settings = JSON.parse(localStorage.getItem(key) ?? "{}");
      localStorage.setItem(key, JSON.stringify({ ...settings, theme: "dark" }));
    });
    await page.reload();
    await expect(client).toBeVisible({ timeout: 30000 });
    await expect(client).toHaveCSS("color-scheme", "dark");
    await expect
      .poll(() => mainIsland.evaluate((element) => getComputedStyle(element).backgroundColor))
      .not.toBe(lightBackground);
    await client.getByRole("button", { name: "Send", exact: true }).click();
    await expect(client.getByTestId("api-response-status")).toContainText("200");
    await client
      .locator(".ac-request-options")
      .getByRole("tab", { name: "Body", exact: true })
      .click();
    await client.getByRole("button", { name: "Show request and response side by side" }).click();
    await expect(client.getByLabel("Request body", { exact: true })).toContainText("message");
    await expect(client.getByLabel("Response body", { exact: true })).toContainText(
      "Bearer fixture-token",
    );
    await page.screenshot({ path: testInfo.outputPath("api-client-dark.png") });
    await client.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByLabel("Saved request name")).toHaveCount(0);
    await client.getByLabel("Request URL", { exact: true }).fill(`${origin}/html`);
    await client.getByRole("button", { name: "Send", exact: true }).click();
    await expect(client.getByLabel("Response body", { exact: true })).toContainText(
      "<!DOCTYPE html>",
    );
    await expect
      .poll(() => client.getByLabel("Response body", { exact: true }).locator("span").count())
      .toBeGreaterThan(0);
    await expect(
      client
        .getByLabel("Response body", { exact: true })
        .locator("span")
        .filter({ hasText: "#1a73e8" }),
    ).toBeVisible();
    await expect(
      client
        .getByLabel("Response body", { exact: true })
        .locator("span")
        .filter({ hasText: /^42$/ }),
    ).toBeVisible();
    await expect
      .poll(() => client.getByLabel("Response body", { exact: true }).locator(".cm-line").count())
      .toBeGreaterThan(5);
    await page.screenshot({ path: testInfo.outputPath("api-client-html-response.png") });
    await client.getByLabel("Response format").selectOption("raw");
    await expect(
      client.getByLabel("Response body", { exact: true }).locator(".cm-line"),
    ).toHaveCount(1);
    await client.getByLabel("Response format").selectOption("pretty");
    await client.getByLabel("Request URL", { exact: true }).fill("{{baseUrl}}/echo?hello=world");
    await client.getByRole("button", { name: "Send", exact: true }).click();
    await expect(client.getByLabel("Response body", { exact: true })).toContainText(
      "Bearer fixture-token",
    );
    await page.setViewportSize({ width: 820, height: 900 });
    await expect(library).toHaveCount(0);
    await expect(client.getByLabel("Request URL", { exact: true })).toBeVisible();
    await client.getByRole("button", { name: "Toggle API Client library" }).click();
    await expect(library).toBeVisible();
    await expect(client.getByRole("button", { name: "Close API Client library" })).toBeVisible();
    await client.getByRole("button", { name: "Close API Client library" }).click();
    await page.screenshot({ path: testInfo.outputPath("api-client-compact.png") });
    await page.evaluate(() => {
      const key = "@mixer:app-settings";
      const settings = JSON.parse(localStorage.getItem(key) ?? "{}");
      localStorage.setItem(key, JSON.stringify({ ...settings, uiBaseFontSize: 18 }));
    });
    await page.reload();
    await expect(client).toBeVisible({ timeout: 30000 });
    await expect
      .poll(() => client.evaluate((element) => parseFloat(getComputedStyle(element).fontSize)))
      .toBeGreaterThan(13);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("API Client manages nested collection folders and compact resource menus", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/");
  await page.getByTestId("plugin-sidebar-api-client-api-client").filter({ visible: true }).click();
  const client = page.getByTestId("api-client");
  const library = page.getByRole("complementary", { name: "API Client library" });
  const menu = async (name: string, action: string) => {
    await library.getByRole("button", { name, exact: true }).first().hover();
    await library
      .getByRole("button", {
        name: `Actions for ${name.replace(/^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS) /, "")}`,
        exact: true,
      })
      .first()
      .click();
    await page.getByRole("menuitem", { name: action, exact: true }).click();
  };
  const rename = async (name: string) => {
    await page.getByRole("textbox", { name: "Name", exact: true }).fill(name);
    await page.getByRole("button", { name: "Rename", exact: true }).click();
  };
  const createFolder = async (name: string) => {
    await expect(page.getByRole("textbox", { name: "Folder name", exact: true })).toBeFocused();
    await page.getByRole("textbox", { name: "Folder name", exact: true }).fill(name);
    await page.getByRole("button", { name: "Create", exact: true }).click();
  };
  await menu("My collection", "Add folder");
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(library.locator('[data-kind="folder"]')).toHaveCount(0);
  await menu("My collection", "Add folder");
  await createFolder("Accounts");
  await menu("Accounts", "Add folder");
  await createFolder("Users");
  await menu("Users", "Add request");
  await expect(client.getByLabel("Request URL")).toBeVisible();
  await menu("GET Untitled request", "Rename");
  await rename("List users");
  await client.getByLabel("Request URL").fill("https://example.com/users");
  await client.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByLabel("Saved request name")).toHaveCount(0);
  await page.reload();
  await expect(client.getByLabel("Request URL")).toHaveValue("https://example.com/users");
  await client.getByLabel("Request URL").fill("https://example.com/users?updated=true");
  await client.getByLabel("Request URL").press("ControlOrMeta+s");
  await expect(page.getByLabel("Saved request name")).toHaveCount(0);
  await page.reload();
  await expect(client.getByLabel("Request URL")).toHaveValue(
    "https://example.com/users?updated=true",
  );
  await expect(library.getByRole("button", { name: "GET List users", exact: true })).toBeVisible();
  await library.getByRole("button", { name: "Users", exact: true }).click();
  await expect(library.getByRole("button", { name: "GET List users", exact: true })).toHaveCount(0);
  await library.getByRole("tab", { name: "Environments", exact: true }).click();
  await expect(library.locator(".ac-section-label")).toHaveText("Environments");
  await expect(library.locator(".ac-section-label")).toHaveCSS("text-transform", "none");
  await library.getByRole("tab", { name: "Collections", exact: true }).click();
  await expect(library.getByRole("button", { name: "Users", exact: true })).toHaveAttribute(
    "aria-expanded",
    "false",
  );
  await library.getByRole("button", { name: "My collection", exact: true }).click();
  await page.reload();
  await expect(library.getByRole("button", { name: "My collection", exact: true })).toHaveAttribute(
    "aria-expanded",
    "false",
  );
  await expect(library.locator(".ac-section-label")).toHaveText("Collections");
  await expect(library.locator(".ac-section-label")).toHaveCSS("text-transform", "none");
  await library.getByRole("button", { name: "My collection", exact: true }).click();
  await expect(library.getByRole("button", { name: "Users", exact: true })).toHaveAttribute(
    "aria-expanded",
    "false",
  );
  await library.getByRole("button", { name: "Users", exact: true }).click();
  await menu("Accounts", "Duplicate");
  await expect(library.getByRole("button", { name: "Accounts copy", exact: true })).toBeVisible();
  await menu("GET List users", "Move…");
  await page.getByLabel("Destination folder").selectOption({ label: "My collection (root)" });
  await page.getByRole("button", { name: "Move", exact: true }).click();
  const originalRequest = library
    .getByRole("button", { name: "GET List users", exact: true })
    .last()
    .locator("..");
  const accounts = library.getByRole("button", { name: "Accounts", exact: true }).locator("..");
  await originalRequest.dragTo(accounts);
  await expect(client.locator(".ac-request-identity")).toContainText("Accounts");
  await library.getByRole("button", { name: "New collection", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Collection name", exact: true })).toBeFocused();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(library.locator('[data-kind="collection"]')).toHaveCount(1);
  await library.getByRole("button", { name: "New collection", exact: true }).click();
  await page.getByRole("textbox", { name: "Collection name", exact: true }).fill("Team API");
  await page.getByRole("textbox", { name: "Collection name", exact: true }).press("Enter");
  await expect(library.getByRole("button", { name: "Team API", exact: true })).toBeVisible();
  const team = library.getByRole("button", { name: "Team API", exact: true }).locator("..");
  await accounts.dragTo(team);
  await expect(client.locator(".ac-request-identity")).toContainText("Team API / Accounts");
  await page.reload();
  await expect(library.getByRole("button", { name: "Accounts", exact: true })).toBeVisible();
  await expect(library.getByRole("button", { name: "Users", exact: true })).toHaveCount(2);
  await page.screenshot({ path: testInfo.outputPath("api-client-collection-tree.png") });
});

test("API Client tab menus close ranges and confirm unsaved changes once", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/");
  const entry = page.getByTestId("plugin-sidebar-api-client-api-client").filter({ visible: true });
  await expect(entry).toBeVisible({ timeout: 30000 });
  await entry.click();
  const client = page.getByTestId("api-client");
  const tabs = client.getByRole("tablist", { name: "API request tabs" }).getByRole("tab");
  await tabs.first().click({ button: "right" });
  await expect(
    page.getByRole("menuitem", { name: "Close to the left", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("menuitem", { name: "Close to the right", exact: true }),
  ).toBeDisabled();
  await page.keyboard.press("Escape");
  await client.getByRole("button", { name: "New API request", exact: true }).click();
  await client.getByRole("button", { name: "New API request", exact: true }).click();
  await tabs.nth(1).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Close to the right", exact: true }).click();
  await expect(tabs).toHaveCount(2);
  await tabs.nth(1).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Close to the left", exact: true }).click();
  await expect(tabs).toHaveCount(1);
  await client.getByRole("button", { name: "New API request", exact: true }).click();
  await client.getByLabel("Request URL").fill("https://example.com/unsaved");
  await client.getByRole("button", { name: "New API request", exact: true }).click();
  await tabs.first().click({ button: "right" });
  const canceled = page.waitForEvent("dialog");
  page.once("dialog", (dialog) => void dialog.dismiss());
  await page.getByRole("menuitem", { name: "Close other tabs", exact: true }).click();
  expect((await canceled).message()).toContain("1 request has unsaved changes");
  await expect(tabs).toHaveCount(3);
  await tabs.first().click({ button: "right" });
  const accepted = page.waitForEvent("dialog");
  page.once("dialog", (dialog) => void dialog.accept());
  await page.getByRole("menuitem", { name: "Close other tabs", exact: true }).click();
  expect((await accepted).message()).toContain("Close requests?");
  await expect(tabs).toHaveCount(1);
  await tabs.first().click({ button: "right" });
  await page.getByRole("menuitem", { name: "Close all tabs", exact: true }).click();
  await expect(tabs).toHaveCount(1);
  await expect(client.getByLabel("Request URL")).toHaveValue("");
});

test("API Client highlights unresolved variables and edits active environment values", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/");
  const entry = page.getByTestId("plugin-sidebar-api-client-api-client").filter({ visible: true });
  await expect(entry).toBeVisible({ timeout: 30000 });
  await entry.click();
  const client = page.getByTestId("api-client");
  const library = page.getByRole("complementary", { name: "API Client library" });
  await client.getByLabel("Request URL").fill("https://example.com/{{id}}");
  await expect(client.locator('.ac-variable-trigger[data-variable="id"]')).toHaveAttribute(
    "data-resolved",
    "false",
  );
  await client.getByRole("button", { name: "Set {{id}}", exact: true }).click();
  await page.getByLabel("Variable value", { exact: true }).fill("global-id");
  await page.getByRole("button", { name: "Save variable", exact: true }).click();
  await expect(client.locator('.ac-variable-trigger[data-variable="id"]')).toHaveAttribute(
    "data-resolved",
    "true",
  );
  await expect(client.locator(".ac-variable-status")).toHaveCount(0);
  await client.getByLabel("Request URL").fill("https://example.com/{{i");
  await expect(client.locator("datalist option")).toHaveAttribute(
    "value",
    "https://example.com/{{id}}",
  );
  await client.getByLabel("Request URL").fill("https://example.com/{{id}}");
  await library.getByRole("tab", { name: "Environments", exact: true }).click();
  await library.getByRole("button", { name: "New environment", exact: true }).click();
  await page.getByLabel("Environment name", { exact: true }).fill("Development");
  await page.getByLabel("variable key 1", { exact: true }).fill("id");
  await page.getByLabel("variable value 1", { exact: true }).fill("local-id");
  await page.getByRole("button", { name: "Save variables", exact: true }).click();
  await expect(client.getByLabel("Active environment")).not.toHaveValue("");
  await client.locator('.ac-variable-trigger[data-variable="id"]').hover();
  await expect(page.locator(".ac-variable-preview")).toContainText("Development");
  await expect(page.locator(".ac-variable-preview")).toContainText("local-id");
  await page.getByRole("button", { name: "Edit variable", exact: true }).click();
  await page.getByLabel("Variable value", { exact: true }).fill("edited-id");
  await page.getByRole("button", { name: "Save variable", exact: true }).click();
  await client.getByLabel("Request URL").fill("https://example.com/{{missing}}");
  await client.locator('.ac-variable-trigger[data-variable="missing"]').hover();
  await expect(page.locator(".ac-variable-preview")).toContainText("Unresolved variable");
  await page.screenshot({ path: testInfo.outputPath("api-client-missing-variable.png") });
  await page.getByRole("button", { name: "Set variable", exact: true }).click();
  await expect(page.getByLabel("Variable scope")).toHaveValue(/.+/);
  await page.getByLabel("Variable value", { exact: true }).fill("fixed");
  await page.getByRole("button", { name: "Save variable", exact: true }).click();
  await expect(client.locator('.ac-variable-trigger[data-variable="missing"]')).toHaveAttribute(
    "data-resolved",
    "true",
  );
  await client.getByLabel("Active environment").selectOption("");
  await expect(client.locator('.ac-variable-trigger[data-variable="missing"]')).toHaveAttribute(
    "data-resolved",
    "false",
  );
  await client.locator('.ac-variable-trigger[data-variable="missing"]').hover();
  await expect(page.locator(".ac-variable-preview")).toContainText("Unresolved variable");
  await expect(page.locator(".ac-variable-preview")).toContainText("No environment selected");
  await expect(
    page.locator(".ac-variable-preview").getByRole("button", { name: /^Use / }),
  ).toHaveCount(0);
  await expect(page.locator(".ac-variable-preview")).not.toContainText("Development");
  await expect(client.getByLabel("Active environment")).toHaveValue("");
  await client
    .locator(".ac-request-options")
    .getByRole("tab", { name: "Headers", exact: true })
    .click();
  await client.getByLabel("header key 1", { exact: true }).fill("X-Id");
  await client.getByLabel("header value 1", { exact: true }).fill("{{id}}");
  await expect(client.locator('.ac-variable-trigger[data-variable="id"]')).toHaveAttribute(
    "data-resolved",
    "true",
  );
  await client
    .locator(".ac-request-options")
    .getByRole("tab", { name: "Body", exact: true })
    .click();
  await client.getByRole("radio", { name: "raw", exact: true }).check();
  await client.getByLabel("Request body", { exact: true }).fill("{{id}} {{unknown}}");
  await expect(client.locator(".cm-variable-resolved")).toContainText("{{id}}");
  await expect(client.locator(".cm-variable-missing")).toContainText("{{unknown}}");
});

test("API Client replays scoped history with all 600 supported variables", async ({ page }) => {
  const server = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ path: request.url }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing scoped history server");
  try {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto("/");
    const entry = page
      .getByTestId("plugin-sidebar-api-client-api-client")
      .filter({ visible: true });
    await expect(entry).toBeVisible({ timeout: 30000 });
    await entry.click();
    const client = page.getByTestId("api-client");
    await client.getByLabel("Request URL").fill("{{baseUrl}}/original");
    await page.evaluate((origin) => {
      const key = Object.keys(localStorage).find((candidate) =>
        candidate.startsWith("mixer:api-client:v1:"),
      );
      if (!key) throw new Error("API Client state was not persisted");
      const state = JSON.parse(localStorage.getItem(key)!);
      const pair = (name: string, value: string) => ({
        id: crypto.randomUUID(),
        key: name,
        value,
        enabled: true,
      });
      const rows = (prefix: string) =>
        Array.from({ length: 200 }, (_, index) => pair(`${prefix}${index}`, String(index)));
      state.tabs[0].name = "Scoped request";
      state.collections[0].requests = [structuredClone(state.tabs[0])];
      state.globals = rows("global");
      state.collections[0].variables = [
        pair("baseUrl", origin),
        ...rows("collection").slice(0, 199),
      ];
      state.environments = [{ id: "dev", name: "Development", variables: rows("environment") }];
      state.activeEnvironmentId = "dev";
      localStorage.setItem(key, JSON.stringify(state));
    }, `http://127.0.0.1:${address.port}`);
    await page.reload();
    await expect(client).toBeVisible({ timeout: 30000 });
    await client.getByRole("button", { name: "Send", exact: true }).click();
    await expect(client.getByTestId("api-response-status")).toContainText("200");
    const library = page.getByRole("complementary", { name: "API Client library" });
    await library.getByRole("tab", { name: "History", exact: true }).click();
    await library.locator(".ac-history-item").first().click();
    await expect(
      client.getByRole("tablist", { name: "API request tabs" }).getByRole("tab"),
    ).toHaveCount(2);
    await expect(client.locator(".ac-request-identity")).toContainText("My collection");
    await expect(client.locator('.ac-variable-trigger[data-variable="baseUrl"]')).toHaveAttribute(
      "data-resolved",
      "true",
    );
    await expect(client.getByLabel("Active environment")).toHaveValue("dev");
    await client.getByLabel("Request URL").fill("{{baseUrl}}/history-edit");
    await page.reload();
    await expect(client.getByLabel("Request URL")).toHaveValue("{{baseUrl}}/history-edit");
    await expect(client.locator('.ac-variable-trigger[data-variable="baseUrl"]')).toHaveAttribute(
      "data-resolved",
      "true",
    );
    await client.getByRole("button", { name: "Send", exact: true }).click();
    await expect(client.getByTestId("api-response-status")).toContainText("200");
    await expect(client.getByLabel("Response body", { exact: true })).toContainText("history-edit");
    await library.getByRole("button", { name: "GET Scoped request", exact: true }).click();
    await expect(client.getByLabel("Request URL")).toHaveValue("{{baseUrl}}/original");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
