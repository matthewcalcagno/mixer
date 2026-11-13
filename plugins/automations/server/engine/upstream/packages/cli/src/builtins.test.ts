import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Runtime, ensureHome, resolvePaths } from "@roboplane/core";
import type { Extension } from "@mixer/automations-sdk";
import { BUILTINS } from "./builtins.js";

const temporary: string[] = [];
afterEach(() => {
  for (const directory of temporary.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

describe("first-party agent providers", () => {
  it("includes Jira and validates its scheduled frontmatter without requiring credentials for discovery", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "roboplane-bundled-jira-"));
    temporary.push(home);
    const paths = resolvePaths(home);
    ensureHome(paths);
    fs.writeFileSync(paths.config, JSON.stringify({ extensions: { github: { token: "test-token" } } }));
    fs.writeFileSync(path.join(paths.workflows, "jira.md"), `---\nagent: opencode\non:\n  jira.issue:\n    cron: "0 9 * * 1-5"\n    timezone: Europe/Madrid\n    jql: 'project = TEST AND labels = refinement_requested'\n---\nRead the triggering ticket.\n`);
    const runtime = new Runtime({ home, builtins: BUILTINS });
    await runtime.initialize();
    try {
      expect(runtime.workflowErrors).toEqual([]);
      expect(runtime.workflows[0]).toMatchObject({
        id: "jira.md", workspace: "scratch", on: { "jira.issue": { cron: "0 9 * * 1-5", timezone: "Europe/Madrid", jql: "project = TEST AND labels = refinement_requested" } },
      });
      expect(runtime.registry.capabilities.get("jira")?.events).toContain("jira.issue");
    } finally { await runtime.stop(); }
  });

  it("registers every provider without Mixer Automations configuration", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "roboplane-agents-"));
    temporary.push(home);
    ensureHome(resolvePaths(home));
    fs.writeFileSync(resolvePaths(home).config, JSON.stringify({ extensions: { github: { token: "test-token" } } }));
    const runtime = new Runtime({ home, builtins: BUILTINS });
    await runtime.initialize();
    expect([...runtime.registry.agentProviders.keys()].sort()).toEqual([
      "claude",
      "codex",
      "copilot",
      "opencode",
      "pi",
    ]);
    expect([...runtime.registry.executionProviders.keys()].sort()).toEqual(["container", "host", "proposal-host", "unsafe-host"]);
    await runtime.stop();
  });

  it("validates the complete GitHub maintainer example pack", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "roboplane-maintainer-examples-"));
    temporary.push(home);
    const paths = resolvePaths(home);
    ensureHome(paths);
    fs.writeFileSync(resolvePaths(home).config, JSON.stringify({
      extensions: { github: { token: "test-token" }, scheduler: {}, worktree: {} },
    }));
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../");
    const examples = path.join(root, "examples", "maintainer");
    for (const file of fs.readdirSync(examples).filter((name) => name.endsWith(".md"))) {
      fs.copyFileSync(path.join(examples, file), path.join(paths.workflows, file));
    }

    const runtime = new Runtime({ home, builtins: BUILTINS });
    await runtime.initialize();
    expect(runtime.workflowErrors).toEqual([]);
    expect(runtime.workflows).toHaveLength(12);
    expect(runtime.workflows.find((workflow) => workflow.id === "11-dependabot-merge.md")?.safeActions).toEqual({
      "github.pr.merge": {
        max: 1,
        allowedAuthors: ["dependabot[bot]"],
        method: "squash",
        mode: "immediate",
        approve: true,
        minimumChecks: 1,
      },
    });
    expect(runtime.workflows.find((workflow) => workflow.id === "11-dependabot-merge.md")?.extensions).toMatchObject({
      "github.pullRequests": { branchUpdates: { allowedAuthors: ["dependabot[bot]"] } },
    });
    expect(runtime.workflows.find((workflow) => workflow.id === "12-approved-pr-merge.md")?.safeActions).toEqual({
      "github.pr.merge": {
        max: 1,
        allowedAuthors: ["YOUR_GITHUB_LOGIN"],
        method: "squash",
        mode: "auto",
        approve: false,
        minimumChecks: 1,
      },
    });
    expect(runtime.workflows.find((workflow) => workflow.id === "12-approved-pr-merge.md")).toMatchObject({
      agent: "codex",
      model: "gpt-6-astra",
      thinking: "high",
    });
    await runtime.stop();
  });

  it("runs a repository-less workflow in a disposable scratch directory", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "roboplane-scratch-runtime-"));
    temporary.push(home);
    const paths = resolvePaths(home);
    ensureHome(paths);
    fs.writeFileSync(resolvePaths(home).config, JSON.stringify({ extensions: { github: { token: "test-token" } } }));
    fs.writeFileSync(path.join(paths.workflows, "jira.md"), `---\nagent: scratch-test\non:\n  schedule:\n    cron: "0 0 * * *"\n---\nTriage the item.\n`);
    let workspacePath: string | undefined;
    let instructions: readonly string[] = [];
    const agent: Extension = {
      name: "scratch-test",
      setup(api) {
        api.agents.register("scratch-test", { run(context) {
          workspacePath = context.workspace?.path;
          instructions = context.instructions;
          fs.writeFileSync(path.join(workspacePath!, "report.md"), "temporary report\n");
          return { output: "Triage report produced in the disposable workspace." };
        } });
      },
    };
    const runtime = new Runtime({ home, builtins: [...BUILTINS, { extension: agent }] });
    await runtime.initialize();
    expect(runtime.workflows[0]).toMatchObject({ repository: undefined, workspace: "scratch" });
    const run = runtime.runManual("jira");
    await runtime.idle();
    expect(runtime.database.getRun(run.id)?.status).toBe("completed");
    expect(runtime.database.getRun(run.id)?.outcome).toMatchObject({ outcome: "unknown" });
    expect(instructions.join("\n")).toContain("no source repository");
    expect(workspacePath).toBeDefined();
    expect(fs.existsSync(workspacePath!)).toBe(false);
    await runtime.stop();
  });

  it("retains a local failed run when global GitHub failure reports are disabled", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "roboplane-disabled-failure-reports-"));
    temporary.push(home);
    const paths = resolvePaths(home);
    ensureHome(paths);
    fs.writeFileSync(resolvePaths(home).config, JSON.stringify({
      extensions: { github: { token: "test-token", failureReports: { enabled: false } } },
    }));
    fs.writeFileSync(path.join(paths.workflows, "failure.md"), `---\nrepository: [owner/one, owner/two]\nagent: failure-test\nworkspace: failure-test\non:\n  test.failure: {}\n---\nFail before the agent starts.\n`);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const extension: Extension = {
      name: "failure-test",
      setup(api) {
        api.events.registerSource("test.failure", { start() {}, match: () => true });
        api.agents.register("failure-test", { run: () => ({ output: "not reached" }) });
        api.workspaces.register("failure-test", {
          create: () => { throw new Error("workspace creation failed"); },
          attest: () => { throw new Error("not reached"); },
        });
      },
    };
    const runtime = new Runtime({ home, builtins: [...BUILTINS, { extension }] });
    await runtime.initialize();
    await runtime.receive({
      id: "failure-event", type: "test.failure", source: "test", timestamp: new Date().toISOString(), repository: "owner/two", data: {},
    });
    await runtime.idle();
    expect(runtime.database.listRuns()[0]).toMatchObject({
      repository: "owner/two", status: "failed", error: "workspace creation failed",
    });
    expect(fetchMock).not.toHaveBeenCalled();
    await runtime.stop();
  });
});
