import { expect, it } from "vitest";
import { autonomousArgs } from "./index.js";

it("runs Pi unattended with its normal coding tools", () => {
  expect(autonomousArgs("provider/model", "high")).toEqual(["--print", "--no-session", "--model", "provider/model", "--thinking", "high"]);
  expect(autonomousArgs()).not.toContain("--thinking");
});
