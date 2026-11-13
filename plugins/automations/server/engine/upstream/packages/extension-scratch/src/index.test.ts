import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { MixerAutomationsAPI, Run, WorkspaceContext, WorkspaceProvider } from "@mixer/automations-sdk";
import scratch from "./index.js";

const temporary: string[] = [];
afterEach(() => { for (const item of temporary.splice(0)) fs.rmSync(item, { recursive: true, force: true }); });

function run(id: string): Run {
  return { id, workflowId: "jira.md", event: {} as Run["event"], status: "running", createdAt: "now", updatedAt: "now" };
}

describe("scratch workspace", () => {
  it("attests, cleans terminal workspaces, and removes crash leftovers on startup", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "roboplane-scratch-"));
    temporary.push(root);
    const workspaces = path.join(root, "workspaces");
    fs.mkdirSync(workspaces);
    let provider: WorkspaceProvider | undefined;
    const api = {
      config: { get: () => ({ cleanup: true }) },
      paths: { workspaces },
      workspaces: { register(_name: string, value: WorkspaceProvider) { provider = value; } },
    } as unknown as MixerAutomationsAPI;
    await scratch.setup(api);
    expect(provider).toBeDefined();
    const context = {
      run: run("jira-run"), signal: new AbortController().signal,
      logger: { debug() {}, info() {}, warn() {}, error() {}, child() { return this; } },
    } satisfies WorkspaceContext;
    const workspace = await provider!.create(context);
    expect(await provider!.attest(context, workspace)).toMatchObject({ kind: "directory", clean: true, revision: "scratch" });
    fs.writeFileSync(path.join(workspace.path, "report.md"), "result\n");
    expect(await provider!.attest(context, workspace)).toMatchObject({ clean: false });
    await provider!.cleanup?.(context, workspace);
    expect(fs.existsSync(workspace.path)).toBe(false);

    const orphanContext = { ...context, run: run("orphaned-run") };
    const orphan = await provider!.create(orphanContext);
    const foreign = path.join(workspaces, "foreign");
    fs.mkdirSync(foreign);
    fs.writeFileSync(path.join(foreign, ".roboplane-scratch.json"), JSON.stringify({ version: 1, runId: "someone-else" }));
    expect(fs.existsSync(orphan.path)).toBe(true);
    await scratch.start?.();
    expect(fs.existsSync(orphan.path)).toBe(false);
    expect(fs.existsSync(foreign)).toBe(true);
  });

  it("retains scratch directories when cleanup is disabled", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "roboplane-scratch-retain-"));
    temporary.push(root);
    const workspaces = path.join(root, "workspaces");
    fs.mkdirSync(workspaces);
    let provider: WorkspaceProvider | undefined;
    await scratch.setup({
      config: { get: () => ({ cleanup: false }) }, paths: { workspaces },
      workspaces: { register(_name: string, value: WorkspaceProvider) { provider = value; } },
    } as unknown as MixerAutomationsAPI);
    const context = {
      run: run("retained-run"), signal: new AbortController().signal,
      logger: { debug() {}, info() {}, warn() {}, error() {}, child() { return this; } },
    } satisfies WorkspaceContext;
    const workspace = await provider!.create(context);
    await provider!.cleanup?.(context, workspace);
    expect(fs.existsSync(workspace.path)).toBe(true);
  });
});
