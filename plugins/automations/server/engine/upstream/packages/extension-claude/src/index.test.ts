import { expect, it } from "vitest";
import { autonomousArgs } from "./index.js";

it("runs Claude unattended", () => {
  expect(autonomousArgs("opus", "high")).toEqual(["--dangerously-skip-permissions", "--no-session-persistence", "--model", "opus", "--effort", "high", "-p"]);
  expect(autonomousArgs()).not.toContain("--effort");
});
