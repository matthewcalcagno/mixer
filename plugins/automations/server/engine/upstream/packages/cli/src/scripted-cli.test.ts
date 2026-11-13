import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { spawn, type ChildProcess } from "node:child_process";
import http from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";

const entry = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const homes: string[] = [];
const daemons: ChildProcess[] = [];
function home() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rp-cli-")); homes.push(root);
  for (const directory of ["automations", "extensions", ".roboplane/state"]) fs.mkdirSync(path.join(root, directory), { recursive: true });
  fs.writeFileSync(path.join(root, ".roboplane", "config.json"), JSON.stringify({ runtime: { concurrency: 1 }, extensions: { github: { enabled: false } } }));
  return root;
}
async function cli(root: string, args: string[]) {
  const child = spawn(process.execPath, [entry, ...args], { env: { ...process.env, MIXER_AUTOMATIONS_HOME: root, MIXER_AUTOMATIONS_SUBMISSION_TOKEN: undefined }, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = ""; let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; }); child.stderr.on("data", (chunk) => { stderr += chunk; });
  const code = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
  return { code, stdout, stderr };
}
afterEach(async () => {
  for (const child of daemons.splice(0)) if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGTERM");
    await Promise.race([new Promise<void>((resolve) => child.once("close", () => resolve())), delay(5000).then(() => { child.kill("SIGKILL"); })]);
  }
  for (const root of homes.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
const trigger = "on:\n  schedule:\n    cron: '0 0 1 1 *'\n";
async function startDaemon(root: string, env: Record<string, string> = {}) {
  const daemon = spawn(process.execPath, [entry, "start", "--foreground"], { env: { ...process.env, MIXER_AUTOMATIONS_HOME: root, ...env }, stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  daemon.stderr.on("data", (chunk) => { stderr += chunk; });
  daemons.push(daemon);
  const deadline = Date.now() + 10_000;
  while (!fs.existsSync(path.join(root, ".roboplane", "state", "roboplane.sock")) && Date.now() < deadline && daemon.exitCode === null) await delay(25);
  expect(fs.existsSync(path.join(root, ".roboplane", "state", "roboplane.sock")), `${process.version} ${process.execPath}\n${stderr}`).toBe(true);
  return daemon;
}

describe("built CLI scripted workflows", () => {
  it("validates nested YAML, prints steps, and executes without an agent", async () => {
    const root = home(); fs.mkdirSync(path.join(root, "automations", "nested"));
    fs.writeFileSync(path.join(root, "automations", "nested", "task.yml"), trigger + "steps:\n  - id: hello\n    name: Say hello\n    run: printf hello\n");
    const validation = await cli(root, ["automations", "validate", "nested/task", "--json"]);
    expect(validation.code, validation.stderr).toBe(0); expect(JSON.parse(validation.stdout)).toMatchObject({ ok: true, workflows: ["nested/task.yml"], errors: [] });
    const plan = await cli(root, ["automations", "files"]); expect(plan.stdout).toContain("type: steps"); expect(plan.stdout).toContain("Say hello");
    await startDaemon(root);
    const execution = await cli(root, ["automations", "run", "nested/task", "--json", "--wait"]); expect(execution.code, execution.stderr).toBe(0);
    const runId = JSON.parse(execution.stdout).runId;
    const inspection = await cli(root, ["automations", "inspect", runId, "--json"]);
    expect(JSON.parse(inspection.stdout)).toMatchObject({ run: { status: "completed" }, steps: [{ id: "hello", status: "succeeded", exitCode: 0 }] });
    const logs = await cli(root, ["automations", "logs", runId, "--step", "hello"]); expect(logs.stdout).toContain("hello");
  }, 15_000);
  it("rejects invalid syntax and ambiguous extensionless identifiers", async () => {
    const root = home();
    for (const extension of ["yaml", "yml"]) fs.writeFileSync(path.join(root, "automations", `task.${extension}`), trigger + "steps: [{run: echo valid}]\n");
    await startDaemon(root);
    const ambiguous = await cli(root, ["automations", "run", "task"]); expect(ambiguous.code).toBe(1); expect(ambiguous.stderr).toContain("Ambiguous");
    fs.writeFileSync(path.join(root, "automations", "invalid.yaml"), trigger + "steps: [{run: echo invalid, timeout: tomorrow}]\n");
    const invalid = await cli(root, ["automations", "validate", "invalid.yaml", "--json"]); expect(invalid.code).toBe(1); expect(JSON.parse(invalid.stdout).errors[0].errors.join(" ")).toContain("timeout");
  }, 15_000);
  it("hands off once through the daemon with concurrency one", async () => {
    const root = home();
    fs.writeFileSync(path.join(root, ".roboplane", "config.json"), JSON.stringify({ runtime: { concurrency: 1 }, extensions: { github: { enabled: false }, fake: { token: "${PROBE_TOKEN}" } } }));
    fs.writeFileSync(path.join(root, "extensions", "fake.mjs"), 'export default {name:"fake",setup(api){api.agents.register("fake",{run(){return {version:1,outcome:"no-op"}}});api.commands.register({name:"probe",description:"Read-only credential test",run(){throw new Error("Must use daemon")},query(args,ctx){return {credentialAvailable:api.config.get().token==="server-only",parentRunId:ctx.run.id}}})}}');
    fs.writeFileSync(path.join(root, "automations", "child.md"), `---\nagent: fake\n${trigger}---\nInvestigate.\n`);
    fs.writeFileSync(path.join(root, "automations", "parent.yaml"), trigger + "steps:\n  - id: handoff\n    run: |\n      test -z \"${PROBE_TOKEN:-}\"\n      mixer-automations probe --output query.json\n      node -e 'const r=require(\"./query.json\"); if(!r.credentialAvailable || r.parentRunId!==process.env.MIXER_AUTOMATIONS_RUN_ID) process.exit(1)'\n      mixer-automations automations run child.md --handoff-key investigate --json > first.json\n      mixer-automations automations run child.md --handoff-key investigate --json > second.json\n      cmp first.json second.json\n");
    await startDaemon(root, { PROBE_TOKEN: "server-only" });
    const submission = await cli(root, ["automations", "run", "parent", "--json"]); expect(submission.code, submission.stderr).toBe(0);
    const runId = JSON.parse(submission.stdout).runId;
    let result: { run: { status: string }; childRunIds: string[] } | undefined;
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const inspection = await cli(root, ["automations", "inspect", runId, "--json"]); result = JSON.parse(inspection.stdout);
      if (result?.run.status === "completed" || result?.run.status === "failed") break;
      await delay(25);
    }
    expect(result?.run.status, JSON.stringify(result)).toBe("completed"); expect(result?.childRunIds).toHaveLength(1);
    const childId = result?.childRunIds[0]; if (!childId) throw new Error("Missing child");
    let childStatus = "";
    while (Date.now() < deadline) {
      const child = JSON.parse((await cli(root, ["automations", "inspect", childId, "--json"])).stdout);
      expect(child.parentRunId).toBe(runId); childStatus = child.run.status;
      if (childStatus === "completed") break;
      await delay(25);
    }
    expect(childStatus).toBe("completed");
  }, 30_000);
  it("requires the daemon for detached submissions", async () => {
    const result = await cli(home(), ["automations", "run", "anything"]);
    expect(result.code).toBe(1); expect(result.stderr).toContain("Start it with `mixer-automations start`");
  });
  it("records a scripted action once and exposes its final effect through inspection", async () => {
    const root = home();
    const zod = pathToFileURL(createRequire(import.meta.url).resolve("zod")).href;
    fs.writeFileSync(path.join(root, "extensions", "effect.mjs"), `import fs from "node:fs"; import path from "node:path"; import { z } from ${JSON.stringify(zod)};
      export default {name:"effect",setup(api){api.actions.register("test.effect",{schema:z.object({decision:z.literal("write")}).strict(),prepare(){return {message:"prepared"}},executePrepared(ctx,value){fs.writeFileSync(path.join(api.paths.home,"effect.json"),JSON.stringify(value));return {message:"executed"}}})}}`);
    const request = "mixer-automations actions request test.effect --input-json '{\"decision\":\"write\"}' --request-key write --json";
    fs.writeFileSync(path.join(root, "automations", "action.yaml"), trigger + "safeActions: {test.effect: {max: 1}}\nsteps:\n  - id: request\n    run: |\n" +
      `      ${request} > first.json\n      ${request} > second.json\n      cmp first.json second.json\n      test ! -f "$MIXER_AUTOMATIONS_HOME/effect.json"\n`);
    await startDaemon(root);
    const execution = await cli(root, ["automations", "run", "action.yaml", "--json", "--wait"]);
    expect(execution.code, execution.stderr).toBe(0);
    const runId = JSON.parse(execution.stdout).runId;
    const inspection = JSON.parse((await cli(root, ["automations", "inspect", runId, "--json"])).stdout);
    expect(inspection.run).toMatchObject({ status: "completed", outcome: { outcome: "acted" } });
    expect(inspection.actions).toHaveLength(1);
    expect(inspection.actions[0]).toMatchObject({ action: "test.effect", status: "executed", result: { message: "executed" } });
    expect(JSON.parse(fs.readFileSync(path.join(root, "effect.json"), "utf8"))).toEqual({ message: "prepared" });
    fs.writeFileSync(path.join(root, "automations", "failed.yaml"), trigger + "safeActions: {test.effect: {max: 1}}\nsteps:\n  - run: |\n" + `      ${request}\n      exit 7\n`);
    const failure = await cli(root, ["automations", "run", "failed.yaml", "--json", "--wait"]);
    expect(failure.code).toBe(1);
    const failedRun = JSON.parse((await cli(root, ["automations", "inspect", JSON.parse(failure.stdout).runId, "--json"])).stdout);
    expect(failedRun.actions[0]).toMatchObject({ status: "rejected" });
    expect(failedRun.effects).toEqual([]);
  }, 30_000);
  it("rejects action requests outside an active scripted step", async () => {
    const result = await cli(home(), ["actions", "request", "test.effect", "--input-json", '{"decision":"write"}', "--request-key", "write"]);
    expect(result.code).toBe(1); expect(result.stderr).toContain("active scripted step");
  });
  it("merges an activated scheduled PR through YAML and the audited GitHub action without a model", async () => {
    const root = home(); const head = "a".repeat(40); const base = "b".repeat(40);
    let merged = false; const mutations: Array<{ method: string; endpoint: string; body: unknown }> = [];
    const pr = () => ({ number: 42, title: "Dependency update", state: merged ? "closed" : "open", merged, draft: false, user: { login: "dependabot[bot]" }, labels: [],
      head: { sha: head, ref: "dependabot/update", repo: { full_name: "owner/repo" } }, base: { sha: base, ref: "develop", repo: { full_name: "owner/repo" } }, mergeable: true, mergeable_state: "clean" });
    const server = http.createServer((request, response) => {
      const endpoint = new URL(request.url ?? "/", "http://localhost").pathname;
      if (request.method === "PUT" && endpoint.endsWith("/merge")) {
        let body = ""; request.on("data", chunk => { body += chunk; });
        request.on("end", () => { mutations.push({ method: "PUT", endpoint, body: JSON.parse(body) }); merged = true; response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify({ merged: true, sha: "c".repeat(40) })); });
        return;
      }
      let payload: unknown;
      if (request.method !== "GET") { response.writeHead(405); response.end("Unexpected mutation"); return; }
      if (endpoint === "/user") payload = { id: 1, login: "maintainer" };
      else if (endpoint === "/repos/owner/repo") payload = { default_branch: "develop" };
      else if (endpoint.endsWith("/pulls")) payload = merged ? [] : [pr()];
      else if (endpoint.endsWith("/pulls/42")) payload = pr();
      else if (endpoint.endsWith("/check-runs")) payload = { total_count: 1, check_runs: [{ id: 1, name: "SonarCloud Code Analysis", head_sha: head, status: "completed", conclusion: "success" }] };
      else if (endpoint.endsWith("/statuses")) payload = [];
      else if (endpoint.endsWith("/status")) payload = { total_count: 0, statuses: [] };
      else if (endpoint.endsWith("/reviews")) payload = [{ id: 1, state: "APPROVED", commit_id: head, user: { login: "reviewer" } }];
      else if (endpoint.includes("/rules/branches/")) payload = [];
      else if (endpoint.endsWith("/branches/develop")) payload = { protected: false };
      else if (endpoint.includes("/compare/")) payload = { ahead_by: 0 };
      else if (endpoint.endsWith("/events")) payload = [];
      else { response.writeHead(404); response.end(`Unexpected request: ${endpoint}`); return; }
      response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify(payload));
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address(); if (!address || typeof address === "string") throw new Error("Missing fixture server address");
      fs.writeFileSync(path.join(root, ".roboplane", "config.json"), JSON.stringify({ runtime: { concurrency: 1 }, extensions: { github: {
        token: "test-token", apiUrl: `http://127.0.0.1:${address.port}`, publishGuard: { enabled: false }, failureReports: { enabled: false },
      } } }));
      fs.writeFileSync(path.join(root, "automations", "merge.yaml"), "repository: owner/repo\nworkspace: scratch\non:\n  github.pr.schedule:\n    cron: '*/2 * * * * *'\n    where: {pull-request-author: 'dependabot[bot]', state: open, base-branch: develop}\n" +
        "safeActions:\n  github.pr.merge: {max: 1, allowedAuthors: ['dependabot[bot]'], method: squash, mode: immediate, approve: false, minimumChecks: 1, mergeCheck: {}}\nsteps:\n  - id: check\n    run: mixer-automations github pr can-merge --event-file \"$MIXER_AUTOMATIONS_EVENT_FILE\" --output report.json\n  - id: merge\n    run: |\n      test \"$(node -p 'require(\"./report.json\").decision')\" = eligible\n      mixer-automations actions request github.pr.merge --input-json '{\"version\":1,\"decision\":\"merge\"}' --request-key merge-ready\n");
      await startDaemon(root);
      const deadline = Date.now() + 15_000;
      while (!merged && Date.now() < deadline) await delay(25);
      const diagnostics = merged ? "" : fs.readdirSync(path.join(root, ".roboplane", "logs")).filter(file => file.endsWith(".log"))
        .map(file => fs.readFileSync(path.join(root, ".roboplane", "logs", file), "utf8").slice(-6000)).join("\n");
      expect(mutations, diagnostics).toEqual([{ method: "PUT", endpoint: "/repos/owner/repo/pulls/42/merge", body: { sha: head, merge_method: "squash" } }]);
      const runId = (await cli(root, ["automations", "list", "--all"])).stdout.match(/\brp_[a-f0-9]{12}\b/)?.[0];
      if (!runId) throw new Error("Missing scheduled run");
      let inspection: { run: { status: string } } | undefined;
      while (Date.now() < deadline) {
        inspection = JSON.parse((await cli(root, ["automations", "inspect", runId, "--json"])).stdout);
        if (inspection?.run.status === "completed") break;
        await delay(25);
      }
      expect(inspection).toMatchObject({ run: { agent: "", status: "completed", outcome: { outcome: "acted" } }, actions: [{ status: "executed", result: { merged: true } }], effects: [{ status: "executed" }] });
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  }, 30_000);
  it("installs new documentation topics and YAML examples", async () => {
    const root = home();
    const topics = await cli(root, ["docs"]); expect(topics.stdout).toContain("scripted-workflows"); expect(topics.stdout).toContain("workflow-handoffs");
    const scripted = await cli(root, ["docs", "scripted-workflows", "--raw"]); expect(scripted.code).toBe(0); expect(scripted.stdout).toContain("## Step schema");
    const handoffs = await cli(root, ["docs", "workflow-handoffs"]); expect(handoffs.stdout).toContain("--inherit-event");
    const example = await cli(root, ["docs", "example-scripted-04-check-merge-eligibility"]); expect(example.code).toBe(0); expect(example.stdout).toContain("spa-storecustomer"); expect(example.stdout).toContain("```yaml");
    const mergeExample = await cli(root, ["docs", "example-scripted-05-merge-or-investigate"]);
    expect(mergeExample.code).toBe(0); expect(mergeExample.stdout).toContain("mixer-automations actions request github.pr.merge");
    expect(mergeExample.stdout).toContain("mergeCheck: *merge-check"); expect(mergeExample.stdout).toContain("--inherit-event");
    const github = await cli(root, ["docs", "github", "--raw"]);
    expect(github.stdout).toContain("## Scripted pull-request merges"); expect(github.stdout).toContain("The current head must already have approval.");
    const sdk = await cli(root, ["docs", "sdk", "--raw"]);
    expect(sdk.stdout).toContain("SafeActionPrepareContext.workflow"); expect(sdk.stdout).toContain("SafeActionContext.operation");
  }, 15_000);
  it("evaluates merge eligibility through a credential-isolated daemon query using only GET requests", async () => {
    const root = home(); const requests: Array<{ method: string; path: string }> = [];
    const sha = "a".repeat(40); const base = "b".repeat(40);
    const pr = { number: 42, state: "open", merged: false, draft: false, user: { login: "maintainer" }, labels: [{ name: "auto" }],
      head: { sha, ref: "fix", repo: { full_name: "owner/repo" } }, base: { sha: base, ref: "main", repo: { full_name: "owner/repo" } }, mergeable: true, mergeable_state: "clean" };
    const server = http.createServer((request, response) => {
      const url = request.url ?? ""; requests.push({ method: request.method ?? "", path: url });
      let payload: unknown;
      if (request.method !== "GET") { response.writeHead(405); response.end("Mutation forbidden"); return; }
      if (url.endsWith("/pulls/42")) payload = pr;
      else if (url.includes("/check-runs?")) payload = { total_count: 1, check_runs: [{ id: 1, name: "SonarCloud Code Analysis", head_sha: sha, status: "completed", conclusion: "success", app: { id: 7 } }] };
      else if (url.includes("/statuses?")) payload = [];
      else if (url.includes("/reviews?")) payload = [{ id: 1, state: "APPROVED", commit_id: sha, user: { login: "reviewer" } }];
      else if (url.includes("/rules/branches/")) payload = [];
      else if (url.endsWith("/branches/main")) payload = { protected: false };
      else if (url === "/user") payload = { id: 1, login: "maintainer" };
      else { response.writeHead(404); response.end("Unexpected request"); return; }
      response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify(payload));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address(); if (!address || typeof address === "string") throw new Error("Missing fixture server address");
      fs.writeFileSync(path.join(root, ".roboplane", "config.json"), JSON.stringify({ runtime: { concurrency: 1 }, extensions: {
        github: { token: "${PROBE_TOKEN}", apiUrl: `http://127.0.0.1:${address.port}`, publishGuard: { enabled: false }, failureReports: { enabled: false } },
      } }));
      fs.writeFileSync(path.join(root, "automations", "check.yaml"), "repository: owner/repo\nworkspace: scratch\n" + trigger +
        "github.mergeCheck: {allowedAuthors: [maintainer], requiredLabels: [auto]}\nsteps:\n  - id: eligibility\n    run: |\n      test -z \"${PROBE_TOKEN:-}\"\n      mixer-automations github pr can-merge --event-file \"$MIXER_AUTOMATIONS_EVENT_FILE\" --output report.json\n      node -e 'const r=require(\"./report.json\"); if(r.decision!==\"eligible\" || r.number!==42) process.exit(1)'\n");
      await startDaemon(root, { PROBE_TOKEN: "server-only" });
      const executed = await cli(root, ["automations", "run", "check.yaml", "--input", '{"number":42,"isPullRequest":true}', "--json", "--wait"]);
      expect(executed.code, executed.stderr).toBe(0); expect(JSON.parse(executed.stdout).status).toBe("completed");
      expect(requests.every((request) => request.method === "GET")).toBe(true);
      expect(requests.filter((request) => request.path.endsWith("/pulls/42"))).toHaveLength(2);
      const logs = await cli(root, ["automations", "logs", JSON.parse(executed.stdout).runId, "--step", "eligibility"]);
      expect(logs.stdout).toContain("eligible"); expect(logs.stdout).not.toContain("server-only");
    } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
  }, 30_000);
});
