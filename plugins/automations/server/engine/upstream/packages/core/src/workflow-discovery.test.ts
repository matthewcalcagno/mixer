import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Extension, Workflow } from "@mixer/automations-sdk";
import { Registry } from "./registry.js";
import { discoverWorkflows } from "./workflows.js";
import { Runtime } from "./runtime.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function root(): string { const value = fs.mkdtempSync(path.join(os.tmpdir(), "rp-discovery-")); roots.push(value); return value; }
function workflow(id = "provided/task"): Workflow {
  return { id, path: "/definition.yaml", name: "Provided task", agent: "fake", execution: "host", workspace: "scratch", on: {}, safeActions: {}, prompt: "Produce an observation." };
}
function registry(): Registry {
  const value = new Registry(); value.setOwner("provider");
  value.agents.register("fake", { run: () => ({ version: 1, outcome: "no-op" }) });
  value.executions.register("host", { isolation: "none", open() { throw new Error("Not used"); } });
  value.workspaces.register("scratch", { create() { throw new Error("Not used"); }, attest() { throw new Error("Not used"); } });
  return value;
}

describe("extension-owned workflow discovery", () => {
  it("validates provided workflows and does not overwrite an installed identity", () => {
    const directory = root(); const registered = registry();
    fs.writeFileSync(path.join(directory, "normal.md"), "---\nagent: fake\non: {}\n---\nExisting instructions.\n");
    registered.workflows.registerDiscovery("provided", { watchPaths: [], discover(known) {
      expect(known.map((item) => item.id)).toEqual(["normal.md"]);
      return { workflows: [workflow("normal.md"), workflow("provided/valid"), { ...workflow("provided/invalid"), agent: "missing" }], errors: [] };
    } });
    const result = discoverWorkflows(directory, registered);
    expect(result.workflows.map((item) => item.id)).toEqual(["normal.md", "provided/valid"]);
    expect(result.workflows[0]?.prompt).toBe("Existing instructions.");
    expect(result.errors.flatMap((item) => item.errors)).toEqual(["Duplicate workflow identity: normal.md", "Unknown agent: missing"]);
  });

  it("isolates discovery failures and removes the provider when its extension is disabled", () => {
    const registered = registry();
    registered.workflows.registerDiscovery("provided", { watchPaths: [], discover() { throw new Error("Invalid definition"); } });
    expect(discoverWorkflows(root(), registered).errors).toEqual([{ path: "provided", errors: ["Invalid definition"] }]);
    registered.removeOwner("provider");
    expect(discoverWorkflows(root(), registered)).toEqual({ workflows: [], errors: [] });
    expect(registered.workflowDiscoveries.size).toBe(0);
  });

  it("executes a provided workflow through normal supervision with its immutable snapshot", async () => {
    const home = root(); let deliveredPrompt = "";
    const extension: Extension = { name: "provider", setup(api) {
      expect(api.config.historyRetentionMs()).toBe(7 * 86_400_000);
      api.workflows.registerDiscovery("provided", { watchPaths: [], discover: () => ({ workflows: [workflow()], errors: [] }) });
      api.agents.register("fake", { run(context) { deliveredPrompt = context.prompt; return { version: 1, outcome: "no-op" }; } });
      api.executions.register("host", { isolation: "none", open: () => ({ process: api.process, close() {} }) });
      api.workspaces.register("scratch", { create: () => ({ path: home }), attest: () => ({ version: 1, kind: "directory", path: home, revision: "scratch", clean: true, verifiedAt: "now" }) });
    } };
    const runtime = new Runtime({ home, builtins: [{ extension }] });
    try {
      await runtime.initialize();
      const run = runtime.runManual("provided/task"); await runtime.idle();
      expect(runtime.database.getRun(run.id)).toMatchObject({ status: "completed", outcome: { outcome: "no-op" } });
      expect(deliveredPrompt).toContain("Produce an observation.");
      expect(runtime.database.getWorkflowSnapshot(run.id)?.id).toBe("provided/task");
    } finally { await runtime.stop(); }
  });
});
