import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, type ChildProcess } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";

const entry = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const homes: string[] = [];
const daemons: ChildProcess[] = [];
function home() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rp-wh-cli-")); homes.push(root);
  for (const folder of ["automations", "webhooks", ".roboplane/state"]) fs.mkdirSync(path.join(root, folder), { recursive: true });
  fs.writeFileSync(path.join(root, ".roboplane", "config.json"), JSON.stringify({
    extensions: { github: { enabled: false }, webhooks: { listener: { enabled: false } } },
  }));
  return root;
}
async function cli(root: string, args: string[]) {
  const child = spawn(process.execPath, [entry, ...args], { env: { ...process.env, MIXER_AUTOMATIONS_HOME: root, MIXER_AUTOMATIONS_SUBMISSION_TOKEN: undefined }, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = ""; let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; }); child.stderr.on("data", (chunk) => { stderr += chunk; });
  const code = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
  return { code, stdout, stderr };
}
async function start(root: string) {
  const daemon = spawn(process.execPath, [entry, "start", "--foreground"], { env: { ...process.env, MIXER_AUTOMATIONS_HOME: root }, stdio: "ignore" });
  daemons.push(daemon);
  const deadline = Date.now() + 10_000;
  while (!fs.existsSync(path.join(root, ".roboplane", "state", "roboplane.sock")) && Date.now() < deadline && daemon.exitCode === null) await delay(25);
  expect(fs.existsSync(path.join(root, ".roboplane", "state", "roboplane.sock"))).toBe(true);
}
afterEach(async () => {
  for (const daemon of daemons.splice(0)) if (daemon.exitCode === null && daemon.signalCode === null) {
    const closed = new Promise<void>((resolve) => daemon.once("close", () => resolve()));
    daemon.kill("SIGTERM");
    await Promise.race([closed, delay(5000).then(() => { if (daemon.exitCode === null && daemon.signalCode === null) daemon.kill("SIGKILL"); })]);
  }
  for (const root of homes.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("built CLI webhook commands", () => {
  it("submits and deduplicates local events, executes matching scripts, and reloads endpoints without HTTP", async () => {
    const root = home();
    fs.writeFileSync(path.join(root, "webhooks", "alerts.yaml"), "handler: webhook.json\nauth:\n  type: bearer\n  secretEnv: UNUSED_SECRET\n");
    fs.writeFileSync(path.join(root, "automations", "react.yaml"), "on:\n  webhook.received:\n    endpoints: [alerts]\n    payload:\n      status: [failed]\nsteps:\n  - run: printf webhook-reacted\n");
    await start(root);
    const listing = await cli(root, ["webhooks", "list"]);
    expect(listing.code, listing.stderr).toBe(0);
    expect(JSON.parse(listing.stdout)).toMatchObject({ listener: null, endpoints: [{ name: "alerts", handler: "webhook.json" }] });
    const args = ["events", "emit", "alerts", "--id", "build-42", "--input", '{"status":"failed"}'];
    const first = await cli(root, args);
    expect(first.code, first.stderr).toBe(0);
    const accepted = JSON.parse(first.stdout);
    expect(accepted).toMatchObject({ status: "accepted" });
    expect(accepted.runIds).toHaveLength(1);
    const duplicate = await cli(root, args);
    expect(duplicate.code, duplicate.stderr).toBe(0);
    expect(JSON.parse(duplicate.stdout)).toMatchObject({ eventId: accepted.eventId, status: "duplicate" });
    let inspection;
    for (let attempt = 0; attempt < 50; attempt++) {
      inspection = await cli(root, ["automations", "inspect", accepted.runIds[0], "--json"]);
      if (JSON.parse(inspection.stdout).run.status === "completed") break;
      await delay(25);
    }
    expect(JSON.parse(inspection!.stdout)).toMatchObject({ run: { status: "completed" } });
    const logs = await cli(root, ["automations", "logs", accepted.runIds[0]]);
    expect(logs.stdout).toContain("webhook-reacted");
    const diagnostics = await cli(root, ["webhooks", "deliveries"]);
    expect(diagnostics.code, diagnostics.stderr).toBe(0);
    expect(JSON.parse(diagnostics.stdout)).toEqual(expect.arrayContaining([expect.objectContaining({ endpoint: "alerts", reason: "accepted", status: 202 })]));
    fs.unlinkSync(path.join(root, "webhooks", "alerts.yaml"));
    expect((await cli(root, ["webhooks", "reload"])).code).toBe(0);
    const unavailable = await cli(root, args);
    expect(unavailable.code).toBe(1);
    expect(unavailable.stderr).toContain("endpoint_not_found");
    expect(JSON.parse((await cli(root, ["webhooks", "list"])).stdout)).toMatchObject({ listener: null, endpoints: [] });
  }, 20_000);

  it("runs existing manual scripts with no endpoint definitions and rejects invalid emission options", async () => {
    const root = home();
    fs.writeFileSync(path.join(root, "automations", "manual.yaml"), "on: {}\nsteps: [{run: printf manual-still-works}]\n");
    await start(root);
    expect(JSON.parse((await cli(root, ["webhooks", "list"])).stdout)).toMatchObject({ listener: null, endpoints: [] });
    const manual = await cli(root, ["automations", "run", "manual", "--json", "--wait"]);
    expect(manual.code, manual.stderr).toBe(0);
    const invalid = await cli(root, ["events", "emit", "alerts", "--id", "1"]);
    expect(invalid.code).toBe(1);
    expect(invalid.stderr).toContain("Provide one of");
    expect((await cli(root, ["docs", "webhooks"])).stdout).toContain("Optional webhooks");
  }, 15_000);
});
