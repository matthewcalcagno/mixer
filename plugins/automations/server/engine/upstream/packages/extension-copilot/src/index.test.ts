import { expect, it } from "vitest";
import { autonomousArgs } from "./index.js";

it("runs Copilot unattended", () => {
  expect(autonomousArgs("model", "/workspace/run", "high")).toEqual(["--allow-all", "--no-ask-user", "-C", "/workspace/run", "--model", "model", "--effort", "high", "-p"]);
  expect(autonomousArgs(undefined, "/workspace/run")).not.toContain("--effort");
});
