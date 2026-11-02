import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, test } from "vitest";
import { compilePlugin } from "../compiler.js";
import { readPluginManifest } from "../manifest.js";
import { DaemonClient } from "../../test-utils/daemon-client.js";
import { createTestMixerDaemon } from "../../test-utils/mixer-daemon.js";
import { BuiltinPluginLoader, builtinPlugins, resolveBuiltinPluginsRoot } from "./index.js";
import { randomUUID } from "node:crypto";
import { resultSchema } from "../../../../../../plugins/search/shared/search.js";

const roots: string[] = [];

test("every bundled plugin starts on the current Mixer release", async () => {
  const { version } = JSON.parse(
    readFileSync(new URL("../../../../../../package.json", import.meta.url), "utf8"),
  );
  const daemon = await createTestMixerDaemon({
    daemonVersion: version,
    pluginsEnabled: false,
    builtinPlugins: new BuiltinPluginLoader(resolveBuiltinPluginsRoot()),
  });
  const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws`, appVersion: version });
  try {
    await client.connect();
    expect((await client.getPluginCatalog()).map(({ id }) => id).sort()).toEqual(
      [...builtinPlugins].sort(),
    );
  } finally {
    await client.close();
    await daemon.close();
  }
}, 60_000);

test("Search is built-in, searches its owning workspace with bundled ripgrep, and reports invalid regex", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mixer-builtin-search-"));
  roots.push(root);
  await writeFile(path.join(root, "source.ts"), "const reference = 1;\n");
  const daemon = await createTestMixerDaemon({
    daemonVersion: "0.14.0-beta.1",
    pluginsEnabled: false,
    builtinPlugins: new BuiltinPluginLoader(resolveBuiltinPluginsRoot(), ["search"]),
  });
  const client = new DaemonClient({
    url: `ws://127.0.0.1:${daemon.port}/ws`,
    appVersion: "0.14.0-beta.1",
  });
  try {
    await client.connect();
    expect((await client.getPluginCatalog()).map((plugin) => plugin.id)).toEqual(["search"]);
    expect(await client.listPlugins()).toEqual([]);
    const created = await client.createWorkspace({ source: { kind: "directory", path: root } });
    if (!created.workspace) throw new Error("Workspace fixture was not created");
    const identity = {
      workspaceId: created.workspace.id,
      channelId: randomUUID(),
      requestId: randomUUID(),
    };
    const options = {
      query: "reference",
      regex: false,
      wholeWord: false,
      caseSensitive: false,
      includes: "",
      excludes: "",
      respectIgnore: true,
    };
    const result = resultSchema.parse(
      await client.invokePluginRpc("search", "search.text", { ...identity, options }),
    );
    expect(result.files).toEqual([
      {
        path: "source.ts",
        matches: [{ line: 1, column: 7, preview: "const reference = 1;", start: 6, end: 15 }],
      },
    ]);
    await expect(
      client.invokePluginRpc("search", "search.text", {
        ...identity,
        requestId: randomUUID(),
        options: { ...options, regex: true, query: "(" },
      }),
    ).rejects.toThrow(/regex parse error/);
  } finally {
    await client.close();
    await daemon.close();
  }
}, 60_000);

test("Source Control is available from the fork with external plugins disabled", async () => {
  const daemon = await createTestMixerDaemon({
    daemonVersion: "0.14.0-beta.1",
    pluginsEnabled: false,
    builtinPlugins: new BuiltinPluginLoader(resolveBuiltinPluginsRoot(), ["source-control"]),
  });
  const client = new DaemonClient({
    url: `ws://127.0.0.1:${daemon.port}/ws`,
    appVersion: "0.14.0-beta.1",
  });
  try {
    await client.connect();
    const catalog = await client.getPluginCatalog();
    expect(catalog.map((plugin) => plugin.id)).toEqual(["source-control"]);
    expect(catalog[0].clientBundle).toContain("Source Control");
    expect(await client.listPlugins()).toEqual([]);
  } finally {
    await client.close();
    await daemon.close();
  }
}, 60_000);

test("a built-in supersedes an old directory installation and survives disabling external plugins", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mixer-builtin-upgrade-"));
  roots.push(root);
  await fixture(root, "listed", true);
  const externalRoot = path.join(root, "external");
  const external = await fixture(externalRoot, "listed", true);
  await writeFile(
    path.join(external, "index.client.tsx"),
    "export default function contribute() { const marker = 'external-shadow-marker'; void marker; }",
  );
  const daemon = await createTestMixerDaemon({
    daemonVersion: "0.9.2",
    pluginsEnabled: true,
    plugins: { listed: { source: "directory", path: external, enabled: true } },
    builtinPlugins: new BuiltinPluginLoader(root, ["listed"]),
  });
  const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws`, appVersion: "0.9.2" });
  try {
    await client.connect();
    const catalog = await client.getPluginCatalog();
    expect(catalog.map((plugin) => plugin.id)).toEqual(["listed"]);
    expect(catalog[0].clientBundle).toContain("builtin-client-marker");
    expect(catalog[0].clientBundle).not.toContain("external-shadow-marker");
    expect(await client.listPlugins()).toEqual([]);
    await expect(client.disablePlugin("listed")).rejects.toThrow(/built-in/);
    await expect(client.reloadPlugin("listed")).rejects.toThrow(/built-in/);
    await client.patchDaemonConfig({ pluginsEnabled: false });
    await expect
      .poll(async () => (await client.getPluginCatalog()).map((plugin) => plugin.id))
      .toEqual(["listed"]);
  } finally {
    await client.close();
    await daemon.close();
  }
}, 60_000);
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(root: string, id: string, client = false): Promise<string> {
  const directory = path.join(root, id);
  await mkdir(directory, { recursive: true });
  await writeFile(
    path.join(directory, "mixer-plugin.json"),
    JSON.stringify({ id, requirements: { mixer: ">=0.9.2" } }),
  );
  await writeFile(
    path.join(directory, "index.server.ts"),
    "export default function contribute() { return () => {}; }",
  );
  if (client) {
    await writeFile(
      path.join(directory, "index.client.tsx"),
      "export default function contribute() { const marker = 'builtin-client-marker'; void marker; return () => {}; }",
    );
  }
  return directory;
}

test("listed built-ins resolve to matching manifests and compile", async () => {
  const root = resolveBuiltinPluginsRoot();
  for (const id of builtinPlugins) {
    const directory = path.join(root, id);
    expect((await readPluginManifest(directory)).id).toBe(id);
    const findEntry = async (names: string[]) => {
      for (const name of names) {
        const entry = path.join(directory, name);
        if ((await stat(entry).catch(() => null))?.isFile()) return entry;
      }
      return null;
    };
    const bundles = await compilePlugin({
      server: await findEntry(["index.server.ts", "index.server.tsx"]),
      client: await findEntry(["index.client.ts", "index.client.tsx"]),
    });
    expect(bundles.serverBundle).toBeTruthy();
  }
});

test("listed client bundle is published while plugins are disabled; unlisted directory is inert", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mixer-builtin-fixture-"));
  roots.push(root);
  await fixture(root, "listed", true);
  await fixture(root, "unlisted", true);
  const daemon = await createTestMixerDaemon({
    daemonVersion: "0.9.2",
    pluginsEnabled: false,
    builtinPlugins: new BuiltinPluginLoader(root, ["listed"]),
  });
  const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws`, appVersion: "0.9.2" });
  try {
    await client.connect();
    expect(await client.listPlugins()).toEqual([]);
    const catalog = await client.getPluginCatalog();
    expect(catalog.map(({ id }) => id)).toEqual(["listed"]);
    expect(catalog[0]?.clientBundle).toContain("builtin-client-marker");
  } finally {
    await client.close();
    await daemon.close();
  }
}, 60_000);

test("a repeated catalog fetch leaves out the client bundle the client already holds", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mixer-builtin-catalog-cache-"));
  roots.push(root);
  const directory = await fixture(root, "large", true);
  // About the size of a real plugin client bundle.
  await writeFile(
    path.join(directory, "index.client.tsx"),
    `const payload = ${JSON.stringify("x".repeat(1_000_000))};
export default function contribute() { void payload; return () => {}; }`,
  );
  const daemon = await createTestMixerDaemon({
    daemonVersion: "0.9.2",
    pluginsEnabled: false,
    builtinPlugins: new BuiltinPluginLoader(root, ["large"]),
  });
  const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws`, appVersion: "0.9.2" });
  const responseBytes: number[] = [];
  const unsubscribe = client.subscribeRawMessages((message) => {
    if (message.type === "plugin.catalog.get.response") {
      responseBytes.push(JSON.stringify(message).length);
    }
  });
  try {
    await client.connect();
    const first = await client.getPluginCatalog();
    const second = await client.getPluginCatalog();

    expect(second).toEqual(first);
    expect(second[0]?.clientBundle).toContain("x".repeat(1_000_000));
    expect(responseBytes).toHaveLength(2);
    expect(responseBytes[0]).toBeGreaterThan(1_000_000);
    expect(responseBytes[1]).toBeLessThan(500);
  } finally {
    unsubscribe();
    await client.close();
    await daemon.close();
  }
}, 60_000);

test("directory, Git, and npm installs reject a built-in ID", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mixer-builtin-install-"));
  roots.push(root);
  const directory = await fixture(root, "reserved");
  const gitDirectory = await fixture(root, "git-source");
  await writeFile(
    path.join(gitDirectory, "mixer-plugin.json"),
    JSON.stringify({ id: "reserved", requirements: { mixer: ">=0.9.2" } }),
  );
  execFileSync("git", ["init", "-q", gitDirectory]);
  execFileSync("git", [
    "-C",
    gitDirectory,
    "-c",
    "user.name=Mixer Tests",
    "-c",
    "user.email=mixer@example.test",
    "add",
    ".",
  ]);
  execFileSync("git", [
    "-C",
    gitDirectory,
    "-c",
    "user.name=Mixer Tests",
    "-c",
    "user.email=mixer@example.test",
    "commit",
    "-qm",
    "fixture",
  ]);
  const daemon = await createTestMixerDaemon({
    daemonVersion: "0.9.2",
    pluginsEnabled: false,
    builtinPlugins: new BuiltinPluginLoader(root, ["reserved"]),
  });
  const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws`, appVersion: "0.9.2" });
  try {
    await client.connect();
    await expect(client.installDirectoryPlugin(directory)).rejects.toThrow(
      /reserved for a built-in/,
    );
    await expect(
      client.installPluginSource({ source: pathToFileURL(gitDirectory).href }),
    ).rejects.toThrow(/reserved for a built-in/);
    await expect(
      client.installPluginSource({ source: "npm:unused-fixture", id: "reserved" }),
    ).rejects.toThrow(/reserved for a built-in/);
    expect(await client.listPlugins()).toEqual([]);
  } finally {
    await client.close();
    await daemon.close();
  }
}, 60_000);
