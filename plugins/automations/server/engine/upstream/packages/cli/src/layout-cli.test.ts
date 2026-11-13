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
function home(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rp-"));
  homes.push(root);
  return root;
}
function cli(root: string, args: string[]) {
  const child = spawn(process.execPath, [entry, ...args], {
    cwd: os.tmpdir(), env: { ...process.env, MIXER_AUTOMATIONS_HOME: root, MIXER_AUTOMATIONS_SUBMISSION_TOKEN: undefined },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}
afterEach(async () => {
  for (const daemon of daemons.splice(0)) if (daemon.exitCode === null && daemon.signalCode === null) {
    const closed = new Promise<void>((resolve) => daemon.once("close", () => resolve()));
    daemon.kill("SIGTERM");
    await closed;
  }
  for (const root of homes.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("built CLI installation layout", () => {
  it("initializes automations, extensions, and private storage, preserving settings and ignore rules", async () => {
    const root = home();
    fs.writeFileSync(path.join(root, ".gitignore"), "user-rule\n");
    const initialized = await cli(root, ["init"]);
    expect(initialized.code, initialized.stderr).toBe(0);
    expect(fs.readdirSync(root).sort()).toEqual([".gitignore", ".roboplane", "automations", "evaluations", "extensions", "webhooks"]);
    expect(fs.readdirSync(path.join(root, ".roboplane")).sort()).toEqual(["cases", "config.json", "logs", "state", "workspaces"]);
    const config = path.join(root, ".roboplane", "config.json");
    const settings = '{"runtime":{"concurrency":2},"extensions":{"github":{"enabled":false,"token":"${TOKEN}"}}}\n';
    fs.writeFileSync(config, settings);
    const repeated = await cli(root, ["init"]);
    expect(repeated.code, repeated.stderr).toBe(0);
    expect(fs.readFileSync(config, "utf8")).toBe(settings);
    expect(fs.readFileSync(path.join(root, ".gitignore"), "utf8")).toBe("user-rule\n/.roboplane/\n");
    if (process.platform !== "win32") expect(fs.statSync(config).mode & 0o777).toBe(0o600);
  });

  it("uses nested extension settings and executes outer workflows from another working directory", async () => {
    const root = home();
    expect((await cli(root, ["init"])).code).toBe(0);
    const config = path.join(root, ".roboplane", "config.json");
    fs.writeFileSync(config, JSON.stringify({ extensions: { github: { enabled: false, token: "${TOKEN}" } } }));
    for (const command of [["extensions", "create", "local", "--template", "workflow-field"], ["extensions", "disable", "local"], ["extensions", "enable", "local"]]) {
      const result = await cli(root, command);
      expect(result.code, result.stderr).toBe(0);
    }
    expect(fs.readFileSync(path.join(root, "extensions", "local", "index.ts"), "utf8")).toContain("defineExtension");
    expect(JSON.parse(fs.readFileSync(config, "utf8"))).toMatchObject({ extensions: { local: { enabled: true }, github: { token: "${TOKEN}" } } });
    // Disabled credentials are still interpolated, so remove this unused reference before validation.
    fs.writeFileSync(config, JSON.stringify({ extensions: { github: { enabled: false } } }));
    fs.writeFileSync(path.join(root, "automations", "check.yaml"), "on: {}\nsteps:\n  - run: printf nested-layout\n");
    const validation = await cli(root, ["automations", "validate", "check", "--json"]);
    expect(validation.code, validation.stderr).toBe(0);
    expect(JSON.parse(validation.stdout)).toMatchObject({ ok: true, workflows: ["check.yaml"], errors: [] });
    const daemon = spawn(process.execPath, [entry, "start", "--foreground"], { env: { ...process.env, MIXER_AUTOMATIONS_HOME: root }, stdio: "ignore" });
    daemons.push(daemon);
    const deadline = Date.now() + 10_000;
    while (!fs.existsSync(path.join(root, ".roboplane", "state", "roboplane.sock")) && Date.now() < deadline) await delay(25);
    expect(fs.existsSync(path.join(root, ".roboplane", "state", "roboplane.sock"))).toBe(true);
    const execution = await cli(root, ["automations", "run", "check", "--json", "--wait"]);
    expect(execution.code, execution.stderr).toBe(0);
    const runId = JSON.parse(execution.stdout).runId;
    const inspection = await cli(root, ["automations", "inspect", runId, "--json"]);
    expect(inspection.code, inspection.stderr).toBe(0);
    expect(JSON.parse(inspection.stdout)).toMatchObject({ run: { workflowId: "check.yaml", status: "completed" } });
    const explanation = await cli(root, ["events", "explain", JSON.parse(inspection.stdout).run.event.id, "--json"]);
    expect(explanation.code, explanation.stderr).toBe(0);
    expect(JSON.parse(explanation.stdout)).toMatchObject({ runs: [{ runId, status: "completed" }] });
    const logs = await cli(root, ["automations", "logs", runId]);
    expect(logs.code, logs.stderr).toBe(0);
    expect(logs.stdout).toContain("nested-layout");
    expect(fs.readdirSync(root).sort()).toEqual([".gitignore", ".roboplane", "automations", "evaluations", "extensions", "webhooks"]);
  }, 15_000);

  it("does not expose a migration command", async () => {
    const root = home();
    const initialized = await cli(root, ["init"]);
    expect(initialized.code, initialized.stderr).toBe(0);
    fs.writeFileSync(path.join(root, ".roboplane", "config.json"), '{"extensions":{"github":{"enabled":false}}}');
    const help = await cli(root, ["--help"]);
    expect(help.code, help.stderr).toBe(0);
    expect(help.stdout).toContain("init");
    expect(help.stdout).not.toContain("migrate");
    const rejected = await cli(root, ["migrate"]);
    expect(rejected.code).toBe(1);
    expect(rejected.stderr).toContain("unknown command 'migrate'");
  });
});
