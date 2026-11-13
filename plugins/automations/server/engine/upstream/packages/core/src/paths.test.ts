import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";
import { ensureHome, resolvePaths } from "./paths.js";

const homes: string[] = [];
function home(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "roboplane-layout-"));
  homes.push(directory);
  return directory;
}
afterEach(() => {
  for (const directory of homes.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe("nested installation layout", () => {
  it("keeps automations and extensions at the outer home and private directories inside .roboplane", () => {
    const root = home();
    const paths = resolvePaths(root);
    ensureHome(paths);
    expect(fs.readdirSync(root).sort()).toEqual([".roboplane", "automations", "extensions"]);
    expect(fs.readdirSync(path.join(root, ".roboplane")).sort()).toEqual(["cases", "logs", "state", "workspaces"]);
    expect(paths.home).toBe(root);
    expect(paths.workflows).toBe(path.join(root, "automations"));
    expect(paths.extensions).toBe(path.join(root, "extensions"));
  });

  it("reads configuration only from the nested private directory", () => {
    const root = home();
    const paths = resolvePaths(root);
    fs.mkdirSync(path.join(root, ".roboplane"));
    fs.writeFileSync(path.join(root, "config.json"), '{"runtime":{"concurrency":5}}');
    fs.writeFileSync(path.join(root, ".roboplane", "config.json"), '{"runtime":{"concurrency":3}}');
    expect(loadConfig(paths).runtime.concurrency).toBe(3);
  });

});
