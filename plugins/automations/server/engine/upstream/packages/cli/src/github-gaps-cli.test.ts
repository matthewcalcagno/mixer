import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import { StateDatabase, ensureHome, resolvePaths } from "@roboplane/core";

const execute = promisify(execFile);
const entry = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const homes: string[] = [];
afterEach(() => { for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true }); });

it("lists and acknowledges a legacy history gap through the built CLI without moving its cursor", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "rp-gap-cli-"));
  homes.push(home);
  const paths = resolvePaths(home);
  ensureHome(paths);
  const database = new StateDatabase(paths.state);
  const state = database.state("github");
  const gap = { cursor: "expired", oldestAvailable: "1", newestAvailable: "3" };
  state.set("events:owner/repo:gap", gap);
  state.set("events:owner/repo:cursor", "10");
  const cli = (...args: string[]) => execute(process.execPath, [entry, "github", "gaps", ...args], {
    timeout: 8_000, env: { ...process.env, MIXER_AUTOMATIONS_HOME: home, MIXER_AUTOMATIONS_SUBMISSION_TOKEN: undefined },
  });
  try {
    const listed = await cli("--json");
    expect(listed.stderr).toBe("");
    const incidents = JSON.parse(listed.stdout);
    expect(incidents).toEqual([expect.objectContaining({ repository: "owner/repo", cursor: "expired", detectedAt: null, acknowledgedAt: null })]);
    const id = incidents[0].id;
    const acknowledged = await cli("acknowledge", "--id", id, "--reason", "Reviewed affected work");
    expect(acknowledged.stdout).toContain("Missing events were not recovered; ingestion cursor unchanged.");
    const after = await cli("--json");
    expect(JSON.parse(after.stdout)).toEqual([expect.objectContaining({ id, acknowledgedAt: expect.any(String), acknowledgmentReason: "Reviewed affected work" })]);
    expect(state.get("events:owner/repo:cursor")).toBe("10");
    expect(state.get("events:owner/repo:gap")).toEqual(gap);
    await cli("acknowledge", "--id", id, "--reason", "Duplicate");
    expect((await cli("--json")).stdout).toBe(after.stdout);
  } finally { database.close(); }
});
