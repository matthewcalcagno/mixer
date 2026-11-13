import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { StateDatabase, ensureHome, resolvePaths } from "@roboplane/core";
import type { RunStatus } from "@mixer/automations-sdk";

const temporary: string[] = [];
const servers: net.Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise<void>(resolve => server.close(() => resolve()));
  for (const directory of temporary.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function fixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "rp-outcomes-"));
  temporary.push(home);
  const paths = resolvePaths(home);
  ensureHome(paths);
  const insert = (id: string, status: RunStatus, outcome?: string) => {
    const database = new StateDatabase(paths.state);
    const timestamp = new Date().toISOString();
    database.insertRun({ id, workflowId: "feedback.md", repository: "owner/repo", status,
      createdAt: timestamp, updatedAt: timestamp,
      event: { id: `event-${id}`, type: "github.pr.comment", source: "github", timestamp, data: {} } }, "fake", "host");
    if (outcome) database.db.prepare("UPDATE runs SET outcome_json = ? WHERE id = ?").run(JSON.stringify({ version: 1, outcome }), id);
    database.close();
  };
  const invoke = (args: string[]) => new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const command = fileURLToPath(new URL("./index.ts", import.meta.url));
    const child = spawn(process.execPath, ["--import", "tsx", command, ...args], {
      env: { ...process.env, MIXER_AUTOMATIONS_HOME: home }, stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", chunk => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", chunk => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", code => resolve({ code, stdout, stderr }));
  });
  const control = async () => {
    fs.writeFileSync(path.join(paths.state, "roboplane.pid"), String(process.pid));
    const server = net.createServer({ allowHalfOpen: true }, socket => {
      socket.on("data", () => {});
      socket.on("end", () => socket.end(JSON.stringify({ ok: true, runId: "rp_result", runIds: ["rp_result"],
        sourceRunId: "rp_source", rootRunId: "rp_source", workflowMode: "snapshot", eventId: "rerouted" }) + "\n"));
    });
    servers.push(server);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(path.join(paths.state, "roboplane.sock"), resolve);
    });
  };
  return { insert, invoke, control };
}

describe("CLI run outcomes", () => {
  it("shows task outcomes separately from execution status", async () => {
    const check = fixture();
    check.insert("rp_acted", "completed", "acted");
    check.insert("rp_noop", "completed", "no-op");
    check.insert("rp_blocked", "completed", "blocked");
    check.insert("rp_failed", "failed", "failed");
    check.insert("rp_active", "running");
    check.insert("rp_legacy", "completed");
    const result = await check.invoke(["automations", "list", "--all"]);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toMatch(/STATUS\s+OUTCOME\s+AGE/);
    for (const [id, status, outcome] of [
      ["rp_acted", "completed", "acted"], ["rp_noop", "completed", "no-op"], ["rp_blocked", "completed", "blocked"],
      ["rp_failed", "failed", "failed"], ["rp_active", "running", "-"], ["rp_legacy", "completed", "-"],
    ]) expect(result.stdout).toMatch(new RegExp(`${id}\\s+feedback\\s+owner/repo\\s+${status}\\s+${outcome}\\s+`));
  });

  it.each([["automations", "rerun"], ["events", "reroute"]])("returns a nonzero exit code for blocked %s %s --wait", async (group, command) => {
    const check = fixture();
    check.insert("rp_result", "completed", "blocked");
    await check.control();
    const result = await check.invoke([group, command, "rp_source", "--wait"]);
    expect(result.code, result.stderr).toBe(1);
  });

  it.each([
    { status: "completed", outcome: "acted", code: 0 },
    { status: "completed", outcome: "no-op", code: 0 },
    { status: "completed", outcome: "failed", code: 1 },
    { status: "failed", outcome: "failed", code: 1 },
    { status: "completed", outcome: undefined, code: 0 },
  ] satisfies Array<{ status: RunStatus; outcome: string | undefined; code: number }>)
  ("returns $code for replay of $status with outcome $outcome", async ({ status, outcome, code }) => {
    const check = fixture();
    check.insert("rp_result", status, outcome);
    await check.control();
    const result = await check.invoke(["automations", "rerun", "rp_source", "--wait"]);
    expect(result.code, result.stderr).toBe(code);
  });
});
