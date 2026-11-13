import { expect, it } from "vitest";
import { autonomousArgs } from "./index.js";

it("runs Codex unattended", () => {
  expect(autonomousArgs("model", "/workspace/run", "high")).toEqual(["exec", "--color", "never", "--ephemeral", "--dangerously-bypass-approvals-and-sandbox", "--cd", "/workspace/run", "--model", "model", "--config", 'model_reasoning_effort="high"']);
  expect(autonomousArgs(undefined, "/workspace/run")).not.toContain("--config");
});
