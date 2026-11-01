import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { loadConfig } from "./config.js";

const roots: string[] = [];

async function createMixerHome(config: unknown): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "mixer-config-plugins-"));
  roots.push(root);
  const mixerHome = path.join(root, ".mixer");
  await mkdir(mixerHome, { recursive: true });
  await writeFile(path.join(mixerHome, "config.json"), JSON.stringify(config, null, 2));
  return mixerHome;
}

describe("daemon plugin config", () => {
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  test("defaults plugins off when config is absent", async () => {
    const home = await createMixerHome({ version: 1 });

    expect(loadConfig(home, { env: {} }).pluginsEnabled).toBe(false);
  });

  test("loads the explicit plugin opt-in", async () => {
    const home = await createMixerHome({ version: 1, pluginsEnabled: true });

    expect(loadConfig(home, { env: {} }).pluginsEnabled).toBe(true);
  });
});
