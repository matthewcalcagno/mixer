import fs from "node:fs";
import path from "node:path";
import { styleText } from "node:util";
import { StateDatabase } from "@roboplane/core";
import type { PathsAPI } from "@mixer/automations-sdk";

type StoredRun = ReturnType<StateDatabase["listRunsForDisplay"]>[number];
type SourceHealth = ReturnType<StateDatabase["listSourceHealth"]>[number];
const WINDOW = 24 * 60 * 60 * 1000;
const LIMIT = 5;

function outcome(run: StoredRun): string | undefined {
  const value = run.outcome;
  return value && typeof value === "object" && "outcome" in value && typeof value.outcome === "string" ? value.outcome : undefined;
}

function active(run: StoredRun): boolean {
  return ["queued", "preparing", "waiting", "running"].includes(run.status);
}

function needsAttention(run: StoredRun): boolean {
  return ["failed", "interrupted"].includes(run.status) || (run.status === "completed" && ["failed", "blocked"].includes(outcome(run) ?? ""));
}

// Names and outcomes are persisted external text. Keep each item on one terminal line.
function line(value: string): string {
  return value.replace(/[\x00-\x1f\x7f-\x9f]/g, " ").slice(0, 160);
}

function paint(text: string, color: "red" | "green" | "yellow" | "cyan" | "bold" | "dim"): string {
  return process.stdout.isTTY && process.env.NO_COLOR === undefined && process.env.TERM !== "dumb"
    ? styleText(color, text, { validateStream: false }) : text;
}

function age(run: StoredRun, now: number): string {
  const minutes = Math.max(0, Math.floor((now - Date.parse(run.updatedAt)) / 60_000));
  return minutes < 1 ? "just now" : minutes < 60 ? `${minutes}m ago` : minutes < 1440 ? `${Math.floor(minutes / 60)}h ago` : `${Math.floor(minutes / 1440)}d ago`;
}

function result(run: StoredRun): string {
  if (run.status === "completed") {
    switch (outcome(run)) {
      case "blocked": return "Blocked";
      case "failed": return "Failed";
      case "no-op": return "No-op";
      default: return "Succeeded";
    }
  }
  return run.status.charAt(0).toUpperCase() + run.status.slice(1);
}

function runName(run: StoredRun, runs: StoredRun[]): string {
  const name = run.workflowId.replace(/\.(md|yaml|yml)$/, "");
  const parts = name.split("/");
  for (let length = 1; length < parts.length; length++) {
    const suffix = parts.slice(-length).join("/");
    if (!runs.some(other => other.workflowId !== run.workflowId && other.workflowId.replace(/\.(md|yaml|yml)$/, "").split("/").slice(-length).join("/") === suffix)) return line(suffix);
  }
  return line(name);
}

function printRunTable(runs: StoredRun[], allRuns: StoredRun[], now: number): void {
  const rows = runs.map(run => ({ name: runName(run, allRuns), result: result(run), age: age(run, now), id: line(run.id), run }));
  const nameWidth = Math.min(40, Math.max(10, ...rows.map(row => row.name.length)));
  const resultWidth = Math.max(9, ...rows.map(row => row.result.length));
  const timeWidth = Math.max(8, ...rows.map(row => row.age.length));
  const fitName = (name: string) => (name.length > nameWidth ? `${name.slice(0, nameWidth - 1)}…` : name).padEnd(nameWidth);
  const narrow = (process.stdout.columns ?? 100) < 80;
  if (!narrow) console.log(paint(`  ${"WORKFLOW".padEnd(nameWidth)}  ${"RESULT".padEnd(resultWidth)}  ${"UPDATED".padEnd(timeWidth)}  RUN`, "dim"));
  for (const row of rows) {
    const color = row.result === "Failed" ? "red" : needsAttention(row.run) ? "yellow" : active(row.run) ? "cyan" : row.run.status === "cancelled" ? "dim" : "green";
    if (narrow) {
      console.log(`  ${row.name}`);
      console.log(`    ${paint(row.result, color)} · ${row.age} · ${row.id}`);
    } else console.log(`  ${fitName(row.name)}  ${paint(row.result.padEnd(resultWidth), color)}  ${row.age.padEnd(timeWidth)}  ${paint(row.id, "dim")}`);
  }
}

function printRuns(title: string, runs: StoredRun[], now: number): void {
  console.log(`\n${paint(title, "bold")}`);
  if (!runs.length) { console.log(paint("  No recent or active runs.", "dim")); return; }
  const categories = [
    ["succeeded", runs.filter(run => result(run) === "Succeeded").length],
    ["no-op", runs.filter(run => result(run) === "No-op").length],
    ["failed", runs.filter(run => run.status === "failed" || (run.status === "completed" && outcome(run) === "failed")).length],
    ["blocked", runs.filter(run => run.status === "completed" && outcome(run) === "blocked").length],
    ["cancelled", runs.filter(run => run.status === "cancelled").length],
    ["interrupted", runs.filter(run => run.status === "interrupted").length],
    ["queued", runs.filter(run => run.status === "queued").length],
    ["active", runs.filter(run => active(run) && run.status !== "queued").length],
  ] satisfies Array<[string, number]>;
  console.log(`  ${categories.filter(([, count]) => count > 0).map(([label, count]) => `${count} ${label}`).join(" · ")}`);
  console.log("");
  const ordered = [...runs].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.id.localeCompare(a.id));
  printRunTable(ordered.slice(0, LIMIT), runs, now);
  if (runs.length > LIMIT) console.log(`  ${runs.length - LIMIT} more runs not shown.`);
}

function printSourceHealth(sources: SourceHealth[], stopped: boolean): void {
  if (!sources.length) return;
  console.log(`\n${paint("Event sources", "bold")}`);
  const healthy = sources.filter(source => source.status === "healthy").length;
  console.log(`  ${healthy}/${sources.length} healthy · last recorded health${stopped ? " (daemon stopped)" : ""}`);
  const groups = new Map<string, { provider: string; status: SourceHealth["status"]; error: string | undefined; count: number }>();
  for (const source of sources.filter(source => source.status !== "healthy")) {
    const provider = source.source.split(".")[0] ?? source.source;
    const key = JSON.stringify([provider, source.status, source.error]);
    const group = groups.get(key);
    if (group) group.count++;
    else groups.set(key, { provider, status: source.status, error: source.error, count: 1 });
  }
  for (const group of [...groups.values()].slice(0, LIMIT)) {
    console.log(`  ${line(group.provider)}: ${paint(group.status, "yellow")} · ${group.count} ${group.count === 1 ? "source" : "sources"}`);
    if (group.error) console.log(`    Reason: ${line(group.error)}`);
  }
  if (groups.size > LIMIT) console.log(`  ${groups.size - LIMIT} more source warning groups not shown.`);
}

export function printOverview({ paths, pid }: { paths: PathsAPI; pid: number | undefined }): void {
  const now = Date.now();
  if (!fs.existsSync(path.join(paths.state, "roboplane.db"))) {
    console.log("No run history yet. Run `mixer-automations init` to get started.");
    console.log(`\n${paint("Details", "bold")}`);
    console.log(pid ? `  Status   ${paint("Running", "green")} · PID ${pid}` : `  Status   ${paint("Stopped", "yellow")} · start with \`mixer-automations start\``);
    console.log("  Help     mixer-automations --help");
    return;
  }
  const database = new StateDatabase(paths.state, { readonly: true });
  try {
    const runs = database.listRunsForDisplay({ since: new Date(now - WINDOW).toISOString() });
    const sources = database.listSourceHealth();
    const attention = runs.filter(needsAttention).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.id.localeCompare(a.id));
    const unhealthy = sources.filter(source => source.status !== "healthy");
    console.log(paint("Needs attention", "bold"));
    const issues = ["Failed", "Blocked", "Interrupted"].flatMap(label => {
      const count = attention.filter(run => result(run) === label).length;
      return count ? [`${count} ${label.toLowerCase()} ${count === 1 ? "run" : "runs"}`] : [];
    });
    if (unhealthy.length) issues.push(`${unhealthy.length} unhealthy event ${unhealthy.length === 1 ? "source" : "sources"}`);
    console.log(issues.length ? `  ${paint(issues.join(" · "), "yellow")}` : "  No recent failures or recorded source-health problems.");
    printRuns("Automations", runs.filter(run => run.event.source !== "evaluations"), now);
    printRuns("Evaluations", runs.filter(run => run.event.source === "evaluations"), now);
    printSourceHealth(sources, !pid);
    console.log(`\n${paint("Details", "bold")}`);
    console.log(pid ? `  Status   ${paint("Running", "green")} · PID ${pid}` : `  Status   ${paint("Stopped", "yellow")} · start with \`mixer-automations start\``);
    console.log("  Runs     mixer-automations automations list");
    console.log("  Evals    mixer-automations evaluations status");
    console.log("  Inspect  mixer-automations automations inspect <run-id>");
  } finally { database.close(); }
}
