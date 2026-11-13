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
const backgroundPids = new Set<number>();
function home() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rp-nav-")); homes.push(root);
  for (const folder of ["automations", ".roboplane/state"]) fs.mkdirSync(path.join(root, folder), { recursive: true });
  fs.writeFileSync(path.join(root, ".roboplane", "config.json"), '{"extensions":{"github":{"enabled":false}}}');
  return root;
}
async function cli(root: string, args: string[], input?: string) {
  const child = spawn(process.execPath, [entry, ...args], { env: { ...process.env, MIXER_AUTOMATIONS_HOME: root, MIXER_AUTOMATIONS_SUBMISSION_TOKEN: undefined }, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = ""; let stderr = "";
  child.stdin.end(input);
  child.stdout.on("data", (chunk) => { stdout += chunk; }); child.stderr.on("data", (chunk) => { stderr += chunk; });
  const timer = setTimeout(() => child.kill("SIGKILL"), 8000);
  try {
    const code = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
    return { code, stdout, stderr };
  } finally { clearTimeout(timer); }
}
async function start(root: string) {
  const daemon = spawn(process.execPath, [entry, "start", "--foreground"], { env: { ...process.env, MIXER_AUTOMATIONS_HOME: root }, stdio: "ignore" });
  daemons.push(daemon);
  const deadline = Date.now() + 10_000;
  while (!fs.existsSync(path.join(root, ".roboplane", "state", "roboplane.sock")) && Date.now() < deadline) await delay(25);
  expect(fs.existsSync(path.join(root, ".roboplane", "state", "roboplane.sock"))).toBe(true);
}
async function inspect(root: string, runId: string) { return JSON.parse((await cli(root, ["automations", "inspect", runId, "--json"])).stdout); }
async function completed(root: string, runId: string) {
  for (let attempt = 0; attempt < 50; attempt++) {
    const value = await inspect(root, runId);
    if (["completed", "failed", "cancelled", "interrupted"].includes(value.run.status)) return value;
    await delay(25);
  }
  throw new Error("Run did not finish");
}
afterEach(async () => {
  for (const root of homes) fs.writeFileSync(path.join(root, "release"), "release");
  for (const daemon of daemons.splice(0)) if (daemon.exitCode === null && daemon.signalCode === null) {
    const closed = new Promise<void>((resolve) => daemon.once("close", () => resolve()));
    daemon.kill("SIGTERM");
    await closed;
  }
  for (const pid of backgroundPids) {
    try { process.kill(pid, "SIGTERM"); } catch { continue; }
    for (let attempt = 0; attempt < 200; attempt++) {
      try { process.kill(pid, 0); } catch { break; }
      await delay(25);
    }
  }
  backgroundPids.clear();
  for (const root of homes.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("CLI automation navigation and detached defaults", () => {
  it("lists versioned machine-readable history without exposing event payloads", async () => {
    const root = home();
    const empty = await cli(root, ["automations", "list", "--all", "--json"]);
    expect(empty.code, empty.stderr).toBe(0);
    expect(JSON.parse(empty.stdout)).toEqual({ schemaVersion: 1, runs: [] });
    fs.writeFileSync(path.join(root, "automations", "summary.yaml"), "on:\n  schedule:\n    cron: '0 0 1 1 *'\nsteps:\n  - id: hello\n    run: echo hello\n");
    await start(root);
    const submission = await cli(root, ["automations", "run", "summary.yaml", "--json", "--wait"]);
    expect(submission.code, submission.stderr).toBe(0);
    const result = await cli(root, ["automations", "list", "--all", "--json"]);
    expect(result.code, result.stderr).toBe(0);
    const history = JSON.parse(result.stdout);
    expect(history.schemaVersion).toBe(1);
    expect(history.runs).toHaveLength(1);
    expect(history.runs[0]).toMatchObject({ id: JSON.parse(submission.stdout).runId, workflowId: "summary.yaml", status: "completed", executor: "steps" });
    expect(Number.isFinite(Date.parse(history.runs[0].createdAt))).toBe(true);
    expect(Number.isFinite(Date.parse(history.runs[0].updatedAt))).toBe(true);
    expect(history.runs[0]).not.toHaveProperty("event");
  });
  it("starts and restarts in the background without waiting for an active automation to drain", async () => {
    const root = home();
    fs.writeFileSync(path.join(root, "automations", "gated.yaml"), 'on: {}\nsteps:\n  - run: while [ ! -f "$MIXER_AUTOMATIONS_HOME/release" ]; do sleep 0.02; done\n');
    const pidFile = path.join(root, ".roboplane", "state", "roboplane.pid");
    const started = await cli(root, ["start"]);
    expect(started.code, started.stderr).toBe(0);
    const original = Number(fs.readFileSync(pidFile, "utf8")); backgroundPids.add(original);
    const submission = await cli(root, ["automations", "run", "gated", "--json"]);
    expect(submission.code, submission.stderr).toBe(0);
    const runId = JSON.parse(submission.stdout).runId;
    for (let attempt = 0; attempt < 50 && (await inspect(root, runId)).run.status !== "running"; attempt++) await delay(25);
    expect((await inspect(root, runId)).run.status).toBe("running");
    const restarted = await cli(root, ["restart"]);
    expect(restarted.code, restarted.stderr).toBe(0);
    expect(restarted.stdout).toContain("restart requested");
    expect(Number(fs.readFileSync(pidFile, "utf8"))).toBe(original);
    expect(fs.existsSync(path.join(root, "release"))).toBe(false);
    fs.writeFileSync(path.join(root, "release"), "release");
    let replacement = original;
    for (let attempt = 0; attempt < 200; attempt++) {
      if (fs.existsSync(pidFile)) replacement = Number(fs.readFileSync(pidFile, "utf8"));
      if (replacement !== original && fs.existsSync(path.join(root, ".roboplane", "state", "roboplane.sock"))) break;
      await delay(25);
    }
    backgroundPids.add(replacement);
    expect(replacement).not.toBe(original);
    expect((await cli(root, ["status"])).code).toBe(0);
    const stopped = await cli(root, ["stop", "--wait"]);
    expect(stopped.code, stopped.stderr).toBe(0);
    expect(fs.existsSync(pidFile)).toBe(false);
  }, 25_000);

  it("exposes the new groups, removes old commands and flags, and reports a stopped daemon", async () => {
    const root = home();
    const help = await cli(root, ["--help"]);
    for (const group of ["automations", "events", "webhooks", "extensions", "actions"]) expect(help.stdout).toContain(group);
    for (const name of ["run", "replay", "ps", "plan", "validate", "add", "inspect", "cancel", "reroute", "event", "action"]) {
      const old = await cli(root, [name]);
      expect(old.code, name).toBe(1);
      expect(old.stderr, name).toContain(`unknown command '${name}'`);
    }
    const runHelp = await cli(root, ["automations", "run", "--help"]);
    expect(runHelp.stdout).toContain("--wait");
    expect(runHelp.stdout).not.toContain("--detach");
    expect(runHelp.stdout).toContain("--arg");
    expect((await cli(root, ["automations", "run", "missing", "--detach"])).stderr).toContain("unknown option");
    const stopped = await cli(root, ["automations", "run", "missing"]);
    expect(stopped.code).toBe(1);
    expect(stopped.stderr).toContain("Start it with `mixer-automations start`");
    expect(fs.existsSync(path.join(root, ".roboplane", "state", "roboplane.pid"))).toBe(false);
  }, 20_000);

  it("lists definitions separately from run history and shows disabled files and nested names", async () => {
    const root = home(); fs.mkdirSync(path.join(root, "automations", "nested"));
    fs.writeFileSync(path.join(root, "automations", "nested", "check.yaml"), "on: {}\nsteps: [{run: printf check}]\n");
    fs.writeFileSync(path.join(root, "automations", "disabled.yaml"), "disabled: true\non: {}\nsteps: [{run: printf disabled}]\n");
    const files = await cli(root, ["automations", "files"]);
    expect(files.code, files.stderr).toBe(0);
    expect(files.stdout).toContain("nested/check.yaml"); expect(files.stdout).toContain("status: disabled");
    const shown = await cli(root, ["automations", "show", "nested/check", "--json"]);
    expect(shown.code, shown.stderr).toBe(0);
    expect(JSON.parse(shown.stdout)).toMatchObject({ workflow: { id: "nested/check.yaml", workspace: "scratch", task: { kind: "steps" } }, errors: [] });
    const history = await cli(root, ["automations", "list"]);
    expect(history.stdout).toContain("AUTOMATION"); expect(history.stdout).not.toContain("nested/check");
    expect((await cli(root, ["extensions", "list"])).stdout).toContain("webhooks");
    expect((await cli(root, ["extensions", "validate", "steps"])).code).toBe(0);
  });

  it("returns before gated execution finishes, supports repository shortcuts, and detaches reruns", async () => {
    const root = home();
    const file = path.join(root, "automations", "triage.yaml");
    fs.writeFileSync(file, 'repository: [owner/one, owner/two]\nworkspace: scratch\non: {}\nsteps:\n  - run: while [ ! -f "$MIXER_AUTOMATIONS_HOME/release" ]; do sleep 0.02; done; printf original\n');
    await start(root);
    const submission = await cli(root, ["automations", "run", "triage", "-r", "owner/one", "--arg", "issue=123", "--arg", "note=a=b", "--json"]);
    expect(submission.code, submission.stderr).toBe(0);
    const first = JSON.parse(submission.stdout);
    expect(first).toMatchObject({ ok: true, status: "accepted" });
    expect(await inspect(root, first.runId)).toMatchObject({ run: { repository: "owner/one", event: { data: { issue: "123", note: "a=b" } } } });
    expect((await inspect(root, first.runId)).run.status).not.toBe("completed");
    fs.writeFileSync(path.join(root, "release"), "release");
    expect((await completed(root, first.runId)).run.status).toBe("completed");
    fs.unlinkSync(path.join(root, "release"));
    const rerun = await cli(root, ["automations", "rerun", first.runId, "--json"]);
    expect(rerun.code, rerun.stderr).toBe(0);
    const second = JSON.parse(rerun.stdout);
    expect(second).toMatchObject({ workflowMode: "snapshot", sourceRunId: first.runId });
    expect((await inspect(root, second.runId)).run.status).not.toBe("completed");
    fs.writeFileSync(path.join(root, "release"), "release");
    await completed(root, second.runId);
    fs.writeFileSync(file, 'repository: [owner/one, owner/two]\nworkspace: scratch\non: {}\nsteps: [{run: printf updated}]\n');
    expect((await cli(root, ["extensions", "reload", "steps"])).code).toBe(0);
    const current = await cli(root, ["automations", "rerun", first.runId, "--current", "--wait", "--json"]);
    expect(current.code, current.stderr).toBe(0);
    expect(JSON.parse(current.stdout)).toMatchObject({ status: "completed", workflowMode: "current" });
    const logs = await cli(root, ["automations", "logs", JSON.parse(current.stdout).runId]);
    expect(logs.code).toBe(0); expect(logs.stdout).toContain("updated");
    const human = await cli(root, ["automations", "run", "triage", "--repo", "owner/two"]);
    expect(human.code).toBe(0); expect(human.stdout).toMatch(/^Queued triage\nRun: rp_/);
  }, 25_000);

  it("uses --wait for final exit codes and reads structured JSON from files and stdin", async () => {
    const root = home();
    fs.writeFileSync(path.join(root, "automations", "success.yaml"), "on: {}\nsteps: [{run: printf success}]\n");
    fs.writeFileSync(path.join(root, "automations", "failure.yaml"), "on: {}\nsteps: [{run: exit 7}]\n");
    const payload = path.join(root, "payload.json"); fs.writeFileSync(payload, '{"issue":123,"enabled":true}');
    await start(root);
    for (const input of [["--input-file", payload], ["--input-file", "-"]]) {
      const result = await cli(root, ["automations", "run", "success", ...input, "--wait", "--json"], '{"issue":123,"enabled":true}');
      expect(result.code, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({ status: "completed" });
      expect(await inspect(root, JSON.parse(result.stdout).runId)).toMatchObject({ run: { event: { data: { issue: 123, enabled: true } } } });
    }
    const detached = await cli(root, ["automations", "run", "failure", "--json"]);
    expect(detached.code).toBe(0); expect(JSON.parse(detached.stdout).status).toBe("accepted");
    const waited = await cli(root, ["automations", "run", "failure", "--wait", "--json"]);
    expect(waited.code).toBe(1); expect(JSON.parse(waited.stdout).status).toBe("failed");
  }, 20_000);
});
