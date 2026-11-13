import type { AgentContext, AgentProvider, MixerAutomationsAPI } from "@mixer/automations-sdk";
import { expect, it, vi } from "vitest";
import opencode, { autonomousArgs } from "./index.js";

it("runs OpenCode unattended", () => {
  expect(autonomousArgs()).toEqual(["run", "--auto"]);
  expect(autonomousArgs("provider/model")).toEqual(["run", "--auto", "--model", "provider/model"]);
  expect(autonomousArgs("provider/model", "high")).toEqual(["run", "--auto", "--model", "provider/model#high"]);
  expect(autonomousArgs("provider/model#high")).toEqual(["run", "--auto", "--model", "provider/model#high"]);
  expect(autonomousArgs("provider/model", "high")).not.toContain("--dir");
  expect(autonomousArgs("provider/model", "high")).not.toContain("--variant");
});

it("rejects thinking without a model or with an existing variant", () => {
  expect(() => autonomousArgs(undefined, "high")).toThrow("OpenCode thinking requires a workflow model");
  expect(() => autonomousArgs("provider/model#low", "high")).toThrow("OpenCode model already specifies a variant");
});

it("runs from the attested workspace without passing a directory flag", async () => {
  let provider: AgentProvider | undefined;
  opencode.setup({
    config: { get: () => ({}) },
    agents: { register: (_name: string, agent: AgentProvider) => { provider = agent; } },
  } as unknown as MixerAutomationsAPI);
  const run = vi.fn().mockResolvedValue({ exitCode: 0, stdout: "done", stderr: "" });
  const context = {
    workspace: { path: "/workspace/run" },
    model: "provider/model",
    thinking: "high",
    instructions: ["Instructions"],
    prompt: "Prompt",
    execution: { run },
    signal: new AbortController().signal,
    logger: { info: vi.fn(), warn: vi.fn() },
  } as unknown as AgentContext;

  await expect(provider!.run(context)).resolves.toEqual({ output: "done" });
  expect(run).toHaveBeenCalledWith(expect.objectContaining({
    command: "opencode",
    args: ["run", "--auto", "--model", "provider/model#high", "Instructions\n\nPrompt"],
    cwd: "/workspace/run",
  }));
  await expect(provider!.run({ ...context, workspace: undefined })).rejects.toThrow("OpenCode requires an attested workspace");
  expect(run).toHaveBeenCalledTimes(1);
});
