import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { StateDatabase, ensureHome, resolvePaths } from "@roboplane/core";
import type { RunStatus } from "@mixer/automations-sdk";

const entry = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const homes: string[] = [];
afterEach(() => { for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true }); });

function fixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "rp-status-"));
  homes.push(home);
  const paths = resolvePaths(home);
  const insert = ({ id, status, source = "manual", hoursAgo = 0, outcome, workflowId = `${id}.md` }: {
    id: string; status: RunStatus; source?: string; hoursAgo?: number; outcome?: string; workflowId?: string;
  }) => {
    ensureHome(paths);
    const database = new StateDatabase(paths.state);
    const timestamp = new Date(Date.now() - hoursAgo * 3_600_000).toISOString();
    database.insertRun({ id, workflowId, status, createdAt: timestamp, updatedAt: timestamp,
      event: { id: `event-${id}`, source, type: `${source}.run`, timestamp, data: {} } }, "fake", "host");
    if (outcome) database.db.prepare("UPDATE runs SET outcome_json = ? WHERE id = ?").run(JSON.stringify({ outcome }), id);
    database.close();
  };
  const cli = async (args: string[] = []) => {
    const child = spawn(process.execPath, [entry, ...args], {
      env: { ...process.env, MIXER_AUTOMATIONS_HOME: home, MIXER_AUTOMATIONS_SUBMISSION_TOKEN: undefined }, stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = ""; let stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    const timer = setTimeout(() => child.kill("SIGKILL"), 8000);
    try {
      const code = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
      return { code, stdout, stderr };
    } finally { clearTimeout(timer); }
  };
  return { home, paths, insert, cli };
}

describe("CLI status overview", () => {
  it("shows the same overview for the bare command and status, without initializing a fresh home", async () => {
    const check = fixture();
    const bare = await check.cli();
    const status = await check.cli(["status"]);
    expect(bare).toEqual(status);
    expect(bare.code).toBe(1);
    expect(bare.stderr).toBe("");
    expect(bare.stdout).toMatch(/^No run history yet\./);
    expect(bare.stdout).toContain("Details\n  Status   Stopped · start with `mixer-automations start`\n  Help     mixer-automations --help");
    expect(bare.stdout).not.toContain("Last 24 hours, plus all queued and active runs");
    expect(bare.stdout).toContain("No run history yet. Run `mixer-automations init` to get started.");
    expect(fs.readdirSync(check.home)).toEqual([]);
    const help = await check.cli(["--help"]);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain("Usage: roboplane");
    expect(help.stdout).toMatch(/status\s+Summarize recent automations, evaluations, and daemon\s+health/);
  });

  it("separates evaluation executions, includes older active runs, and excludes old terminal history", async () => {
    const check = fixture();
    check.insert({ id: "recent-success", status: "completed" });
    check.insert({ id: "old-success", status: "completed", hoursAgo: 25 });
    check.insert({ id: "old-active", status: "running", hoursAgo: 48 });
    check.insert({ id: "evaluation-success", status: "completed", source: "evaluations" });
    check.insert({ id: "evaluation-queued", status: "queued", source: "evaluations" });
    fs.writeFileSync(path.join(check.paths.state, "roboplane.pid"), String(process.pid));
    const result = await check.cli();
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toMatch(/^Needs attention\n/);
    expect(result.stdout).toContain(`Details\n  Status   Running · PID ${process.pid}\n  Runs     mixer-automations automations list`);
    expect(result.stdout).toContain("Automations\n  1 succeeded · 1 active");
    expect(result.stdout).toContain("Evaluations\n  1 succeeded · 1 queued");
    expect(result.stdout).toMatch(/old-active\s+Running\s+2d ago\s+old-active/);
    expect(result.stdout).not.toContain("old-success");
    const [automations, evaluations] = result.stdout.split("\nAutomations\n")[1]!.split("\nEvaluations\n");
    expect(automations).toContain("recent-success");
    expect(automations).not.toContain("evaluation-success");
    expect(evaluations).toContain("evaluation-success");
    expect(evaluations).not.toContain("recent-success");
  });

  it("puts failed and blocked outcomes and unhealthy sources ahead of the run summary without mutating state", async () => {
    const check = fixture();
    check.insert({ id: "blocked", status: "completed", outcome: "blocked" });
    check.insert({ id: "task-failed", status: "completed", outcome: "failed" });
    check.insert({ id: "execution-failed", status: "failed" });
    check.insert({ id: "interrupted", status: "interrupted" });
    check.insert({ id: "cancelled", status: "cancelled" });
    check.insert({ id: "queued", status: "queued" });
    const database = new StateDatabase(check.paths.state);
    database.updateSourceHealth({ source: "github", status: "unavailable", consecutiveFailures: 2,
      error: "Missing credentials", updatedAt: new Date().toISOString() });
    database.close();
    const before = fs.readFileSync(path.join(check.paths.state, "roboplane.db"));
    const pidFile = path.join(check.paths.state, "roboplane.pid");
    fs.writeFileSync(pidFile, "invalid-pid");
    const result = await check.cli(["status"]);
    expect(result.code, result.stderr).toBe(1);
    expect(result.stderr).toBe("");
    const attention = result.stdout.split("Needs attention\n")[1]!.split("\nAutomations\n")[0];
    expect(attention).toContain("2 failed runs · 1 blocked run · 1 interrupted run · 1 unhealthy event source");
    expect(result.stdout).toMatch(/task-failed\s+Failed\s+just now\s+task-failed/);
    expect(result.stdout).toMatch(/execution-failed\s+Failed\s+just now\s+execution-failed/);
    expect(result.stdout).toMatch(/interrupted\s+Interrupted\s+just now\s+interrupted/);
    expect(attention).not.toContain("cancelled");
    expect(result.stdout).toContain("2 failed · 1 blocked · 1 cancelled · 1 interrupted · 1 queued");
    expect(result.stdout).toContain("0/1 healthy · last recorded health (daemon stopped)");
    expect(result.stdout).toContain("github: unavailable · 1 source\n    Reason: Missing credentials");
    expect(result.stdout).not.toContain("completed (blocked)");
    expect(fs.readFileSync(pidFile, "utf8")).toBe("invalid-pid");
    expect(fs.readFileSync(path.join(check.paths.state, "roboplane.db"))).toEqual(before);
    const readonly = new StateDatabase(check.paths.state, { readonly: true });
    try {
      expect(readonly.getRun("queued")?.status).toBe("queued");
      expect(() => readonly.db.prepare("DELETE FROM runs").run()).toThrow(/readonly/i);
    } finally { readonly.close(); }
  });

  it("bounds the printed history without truncating totals", async () => {
    const check = fixture();
    for (let index = 0; index < 12; index++) check.insert({ id: `success-${index}`, status: "completed", hoursAgo: index });
    const result = await check.cli();
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Automations\n  12 succeeded");
    expect(result.stdout).toContain("7 more runs not shown.");
    expect(result.stdout).toMatch(/success-0\s+Succeeded\s+just now\s+success-0/);
    expect(result.stdout).toMatch(/success-4\s+Succeeded\s+4h ago\s+success-4/);
    expect(result.stdout).not.toMatch(/success-5\s+Succeeded/);
    expect(result.stdout).toContain("Evaluations\n  No recent or active runs.");
  });

  it("lists the most recently updated runs first regardless of outcome or active status", async () => {
    const check = fixture();
    check.insert({ id: "rp_old_active", status: "running", hoursAgo: 48 });
    check.insert({ id: "rp_old_blocked", status: "completed", outcome: "blocked", hoursAgo: 23 });
    check.insert({ id: "rp_recent_noop", status: "completed", outcome: "no-op", hoursAgo: 2 });
    check.insert({ id: "rp_latest_success", status: "completed", hoursAgo: 1 });
    const result = await check.cli();
    expect(result.stderr).toBe("");
    expect(result.stdout.split("\n").filter(row => /rp_(old_active|old_blocked|recent_noop|latest_success)$/.test(row))
      .map(row => row.trim().split(/\s+/).at(-1)))
      .toEqual(["rp_latest_success", "rp_recent_noop", "rp_old_blocked", "rp_old_active"]);
  });

  it("groups repeated source warnings, shortens workflow paths, and shows outcomes once in aligned columns", async () => {
    const check = fixture();
    check.insert({ id: "rp_noop", workflowId: "shared/code-quality/repository-maintenance-audit.md", status: "completed", outcome: "no-op" });
    check.insert({ id: "rp_blocked", workflowId: "shared/pull-requests/merge-pull-request.md", status: "completed", outcome: "blocked" });
    check.insert({ id: "rp_left", workflowId: "team-a/check.md", status: "completed" });
    check.insert({ id: "rp_right", workflowId: "team-b/check.md", status: "completed" });
    const database = new StateDatabase(check.paths.state);
    for (const source of ["github.check", "github.issue", "github.issue.comment", "github.pr.comment", "github.pr.review", "github.pr.review.comment"]) {
      database.updateSourceHealth({ source, status: "degraded", consecutiveFailures: 35, error: "github_event_history_gap", updatedAt: new Date().toISOString() });
    }
    database.updateSourceHealth({ source: "evaluations.batch", status: "healthy", consecutiveFailures: 0, updatedAt: new Date().toISOString() });
    database.close();
    const result = await check.cli();
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("1 blocked run · 6 unhealthy event sources");
    expect(result.stdout).toContain("2 succeeded · 1 no-op · 1 blocked");
    expect(result.stdout).toMatch(/repository-maintenance-audit\s+No-op\s+just now\s+rp_noop/);
    expect(result.stdout).toMatch(/merge-pull-request\s+Blocked\s+just now\s+rp_blocked/);
    expect(result.stdout).toMatch(/team-a\/check\s+Succeeded/);
    expect(result.stdout).toMatch(/team-b\/check\s+Succeeded/);
    expect(result.stdout.match(/rp_blocked/g)).toHaveLength(1);
    expect(result.stdout.match(/github_event_history_gap/g)).toHaveLength(1);
    expect(result.stdout).toContain("github: degraded · 6 sources");
    expect(result.stdout).toContain("1/7 healthy · last recorded health");
    expect(result.stdout).not.toContain("shared/");
    expect(result.stdout).not.toContain("\x1b[");
    const rows = result.stdout.split("\n").filter(row => /rp_(noop|blocked)$/.test(row));
    expect(rows.map(row => row.indexOf("just now"))).toEqual([43, 43]);
  });
});
