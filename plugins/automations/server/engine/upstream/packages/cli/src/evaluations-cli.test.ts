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
async function cli(home: string, args: string[]) {
  const child = spawn(process.execPath, [entry, ...args], { env: { ...process.env, MIXER_AUTOMATIONS_HOME: home, MIXER_AUTOMATIONS_SUBMISSION_TOKEN: undefined }, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = ""; let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; }); child.stderr.on("data", (chunk) => { stderr += chunk; });
  const code = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
  return { code, stdout, stderr };
}
afterEach(async () => {
  for (const daemon of daemons.splice(0)) if (daemon.exitCode === null && daemon.signalCode === null) {
    const closed = new Promise<void>((resolve) => daemon.once("close", () => resolve())); daemon.kill("SIGTERM");
    await Promise.race([closed, delay(5000).then(() => daemon.kill("SIGKILL"))]);
  }
  for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true });
});

describe("built CLI evaluations", () => {
  it("runs a report-only evaluation through the real daemon and installs its documentation", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "rp-ev-")); homes.push(home);
    for (const folder of ["automations", "extensions", ".roboplane", "evaluations/comments"]) fs.mkdirSync(path.join(home, folder), { recursive: true });
    fs.writeFileSync(path.join(home, ".roboplane", "config.json"), JSON.stringify({ runtime: { concurrency: 1 }, extensions: { github: { enabled: false }, evaluations: { pollInterval: "50ms" } } }));
    const sourceFile = path.join(home, "automations", "triage.md");
    const original = "---\nagent: probe\non: {}\n---\nExplain the next action.\n";
    fs.writeFileSync(sourceFile, original);
    fs.writeFileSync(path.join(home, "evaluations", "comments", "evaluation.yaml"), "workflow: triage.md\nagent: probe\nmodel: selected-model\nafterRuns: 1\ncriteria:\n  - description: Clear next action\n    passWhen: The output names the next action.\n");
    fs.writeFileSync(path.join(home, "extensions", "probe.mjs"), `export default {name:"probe",setup(api){api.agents.register("probe",{run(ctx){
      if(!ctx.run.workflowId.startsWith("evaluations/"))return {version:1,outcome:"no-op",output:"Next: implement the correction."};
      if(ctx.model!=="selected-model"||ctx.actions.length)throw new Error("Evaluator settings were not preserved");
      const text=ctx.instructions.join("\\n").split("BEGIN_UNTRUSTED_EVALUATION_DATA\\n\\n")[1].split("\\n\\nEND_UNTRUSTED_EVALUATION_DATA")[0];
      const run=JSON.parse(text).runs[0];
      return {version:1,outcome:"no-op",output:"MIXER_AUTOMATIONS_EVALUATION: "+JSON.stringify({criteria:[{criterion:1,result:"pass",explanation:"The output names the next action.",evidence:[{runId:run.runId,excerpt:"Next: implement the correction."}]}],suggestion:null})};
    }})}};`);
    const validation = await cli(home, ["automations", "validate", "--json"]);
    expect(validation.code, validation.stderr).toBe(0);
    expect(JSON.parse(validation.stdout)).toMatchObject({ ok: true, workflows: ["triage.md", "evaluations/comments/evaluation.yaml"] });
    const list = await cli(home, ["evaluations", "list", "--json"]);
    expect(list.code, list.stderr).toBe(0);
    expect(JSON.parse(list.stdout)).toMatchObject({ evaluations: [{ name: "comments", afterRuns: 1, pendingRuns: 0 }] });
    const daemon = spawn(process.execPath, [entry, "start", "--foreground"], { env: { ...process.env, MIXER_AUTOMATIONS_HOME: home, MIXER_AUTOMATIONS_SUBMISSION_TOKEN: undefined }, stdio: ["ignore", "ignore", "pipe"] }); daemons.push(daemon);
    let stderr = ""; daemon.stderr.on("data", (chunk) => { stderr += chunk; });
    await waitFor(() => fs.existsSync(path.join(home, ".roboplane", "state", "roboplane.sock")), () => stderr);
    const source = await cli(home, ["automations", "run", "triage.md", "--json", "--wait"]);
    expect(source.code, source.stderr).toBe(0);
    const directory = path.join(home, "evaluations", "comments", "reports");
    await waitFor(() => fs.existsSync(directory) && fs.readdirSync(directory).some((file) => file.endsWith(".md")), () => stderr);
    const file = fs.readdirSync(directory).find((name) => name.endsWith(".md")); if (!file) throw new Error("Report missing");
    const report = fs.readFileSync(path.join(directory, file), "utf8");
    expect(report).toContain("Result: No change justified"); expect(report).toContain("Model: selected-model");
    expect(report).toContain(JSON.parse(source.stdout).runId);
    expect(fs.readFileSync(sourceFile, "utf8")).toBe(original);
    expect((await cli(home, ["docs", "evaluations"])).stdout).toContain("Report-only evaluations");
    expect((await cli(home, ["docs", "example-evaluation-issue-triage-comments"])).stdout).toContain("passWhen:");
  }, 15_000);
});

async function waitFor(condition: () => boolean, diagnostic: () => string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!condition() && Date.now() < deadline) await delay(25);
  expect(condition(), diagnostic()).toBe(true);
}
