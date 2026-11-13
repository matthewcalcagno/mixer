import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { ExecutionContext, ExecutionProvider, Logger, MixerAutomationsAPI, Run, Workflow } from "@mixer/automations-sdk";
import container, { buildContainerArgs, containerConfigSchema } from "./index.js";

const logger: Logger = {
  debug() {}, info() {}, warn() {}, error() {}, child() { return logger; },
};

function fixture() {
  const now = new Date().toISOString();
  const run: Run = {
    id: "rp_test", workflowId: "test.md", repository: "owner/repo",
    event: { id: "event", type: "test", source: "test", timestamp: now, data: {} },
    status: "running", createdAt: now, updatedAt: now,
  };
  const workflow: Workflow = {
    id: "test.md", path: "/test.md", name: "test", repository: "owner/repo", on: {},
    agent: "test", execution: "container", workspace: "worktree", safeActions: {}, prompt: "test",
  };
  const context: ExecutionContext = {
    run, workflow, workspace: { path: "/tmp/roboplane/rp_test" }, signal: new AbortController().signal, logger,
  };
  return { workflow, context };
}

describe("container execution", () => {
  it("builds a hardened argument-only container invocation", () => {
    const config = containerConfigSchema.parse({ image: `example.test/agent@sha256:${"a".repeat(64)}` });
    const { context } = fixture();
    const args = buildContainerArgs(config, context, {
      command: "agent", args: ["run", "prompt"], cwd: context.workspace?.path, env: { MODEL_KEY: "explicit" },
    });
    expect(args).toEqual(expect.arrayContaining([
      "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
      "--network", "none", "--pids-limit", "256", "--workdir", "/workspace",
      "--env", "MODEL_KEY", "agent", "run", "prompt",
    ]));
    expect(args.join(" ")).not.toContain("docker.sock");
    expect(args.join(" ")).not.toContain("--privileged");
  });

  it("mounts protocol read-only roles without weakening the writable implementer boundary", () => {
    const config = containerConfigSchema.parse({ image: `example.test/agent@sha256:${"a".repeat(64)}` });
    const { context } = fixture();
    const readOnly = buildContainerArgs(config, { ...context, role: "reviewer", workspaceAccess: "read-only" }, { command: "agent" });
    const writable = buildContainerArgs(config, { ...context, role: "implementer", workspaceAccess: "read-write" }, { command: "agent" });
    expect(readOnly).toContain("type=bind,source=/tmp/roboplane/rp_test,target=/workspace,readonly");
    expect(writable).toContain("type=bind,source=/tmp/roboplane/rp_test,target=/workspace");
    expect(writable).not.toContain("type=bind,source=/tmp/roboplane/rp_test,target=/workspace,readonly");
  });

  it("rejects unpinned images and working directories outside the workspace", () => {
    const { context } = fixture();
    expect(() => buildContainerArgs(containerConfigSchema.parse({ image: "agent:latest" }), context, { command: "agent" }))
      .toThrow("pinned by sha256");
    expect(() => buildContainerArgs(
      containerConfigSchema.parse({ image: `agent@sha256:${"b".repeat(64)}` }), context,
      { command: "agent", cwd: "/tmp/other" },
    )).toThrow("inside the run workspace");
    expect(() => buildContainerArgs(
      containerConfigSchema.parse({ image: `agent@sha256:${"b".repeat(64)}` }), context,
      { command: "agent", env: { DOCKER_HOST: "tcp://attacker" } },
    )).toThrow("environment name is reserved");
    expect(() => buildContainerArgs(
      containerConfigSchema.parse({ image: `agent@sha256:${"b".repeat(64)}` }), context,
      { command: "agent", env: { GITHUB_TOKEN: "must-not-leak" } },
    )).toThrow("environment name is reserved");
  });

  it("registers the normal host provider", async () => {
    const providers = new Map<string, ExecutionProvider>();
    const process = { run: vi.fn() };
    const api = {
      config: { get: () => ({}) }, process,
      executions: { register: (name: string, provider: ExecutionProvider) => providers.set(name, provider) },
    } as unknown as MixerAutomationsAPI;
    await container.setup(api);
    expect(providers.get("host")?.isolation).toBe("none");
    expect(providers.get("unsafe-host")?.isolation).toBe("none");
    expect(providers.get("proposal-host")?.isolation).toBe("proposal-only");
    expect(providers.get("container")?.isolation).toBe("isolated");
    expect(providers.get("container")?.validate?.(fixture().workflow)).toEqual([
      "Container execution requires extensions.container.images.test or extensions.container.image",
    ]);
    expect(process.run).not.toHaveBeenCalled();
  });

  it("gives host runs a safe environment without integration credentials", async () => {
    const providers = new Map<string, ExecutionProvider>();
    const processApi = { run: vi.fn().mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" }) };
    const previous = process.env.MIXER_AUTOMATIONS_TEST_GITHUB_TOKEN;
    process.env.MIXER_AUTOMATIONS_TEST_GITHUB_TOKEN = "normal-user-credential";
    try {
      const api = {
        config: { get: () => ({}) }, process: processApi,
        executions: { register: (name: string, provider: ExecutionProvider) => providers.set(name, provider) },
      } as unknown as MixerAutomationsAPI;
      await container.setup(api);
      const { context } = fixture();
      context.workspace!.environment = { PATH: "/trusted/guard" };
      const session = await providers.get("host")!.open(context);
      await session.process.run({ command: "agent", env: { PATH: "/untrusted/override" } });
      const options = processApi.run.mock.calls[0]![0];
      expect(options.inheritEnv).toEqual(["PATH", "HOME", "USER", "SHELL", "TMPDIR", "LANG", "LC_ALL", "TERM"]);
      expect(options.env.MIXER_AUTOMATIONS_TEST_GITHUB_TOKEN).toBeUndefined();
      expect(options.env.PATH).toBe("/trusted/guard");
      expect(options.env.PWD).toBe(context.workspace!.path);
      expect(options.env.MIXER_AUTOMATIONS_RUN_ID).toBe(context.run.id);
    } finally {
      if (previous === undefined) delete process.env.MIXER_AUTOMATIONS_TEST_GITHUB_TOKEN;
      else process.env.MIXER_AUTOMATIONS_TEST_GITHUB_TOKEN = previous;
    }
  });

  it("gives proposal-host an ephemeral home and strips integration credentials", async () => {
    const providers = new Map<string, ExecutionProvider>();
    const process = { run: vi.fn().mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" }) };
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "roboplane-proposal-host-"));
    try {
      const api = {
        config: { get: () => ({}) }, process, paths: { workspaces: root },
        executions: { register: (name: string, provider: ExecutionProvider) => providers.set(name, provider) },
      } as unknown as MixerAutomationsAPI;
      await container.setup(api);
      const { context } = fixture();
      const session = await providers.get("proposal-host")!.open({ ...context, workspace: { path: root } });
      await session.process.run({ command: "agent", env: { OPENAI_API_KEY: "model-only", GITHUB_TOKEN: "must-not-pass" } });
      const options = process.run.mock.calls[0]![0];
      expect(options.inheritEnv).toEqual(["PATH", "LANG", "LC_ALL", "TERM"]);
      expect(options.env.OPENAI_API_KEY).toBe("model-only");
      expect(options.env.GITHUB_TOKEN).toBeUndefined();
      expect(options.env.HOME).toContain(".proposal-home-");
      const ephemeralHome = options.env.HOME;
      await session.close();
      expect(fs.existsSync(ephemeralHome)).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
