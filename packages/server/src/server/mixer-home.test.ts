import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";

import { resolveMixerHome } from "./mixer-home.js";
describe("resolveMixerHome", () => {
  test("resolves MIXER_HOME without creating it", () => {
    const parent = mkdtempSync(path.join(tmpdir(), "mixer-home-parent-"));
    const mixerHome = path.join(parent, "home");
    try {
      expect(resolveMixerHome({ MIXER_HOME: mixerHome })).toBe(mixerHome);
      expect(existsSync(mixerHome)).toBe(false);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });
});
