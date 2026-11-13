import { describe, expect, it } from "vitest";
import { classifyRunLogLine, inspectRunLogs } from "./run-inspection.js";

describe("classifyRunLogLine", () => {
  it.each([
    ["$ npm run build", "command"],
    ["> build · gpt-6.1-sol", "heading"],
    ["→ Read AGENTS.md", "tool"],
    ['⚙ execute {"code":"return 1"}', "tool"],
    ["ERROR  Step failed", "error"],
    ["WARN   Retrying", "warning"],
    ['  "error": null,', "output"],
    ["0 errors found", "output"],
    ["Ordinary output", "output"],
  ])("classifies %s as %s", (line, kind) => {
    expect(classifyRunLogLine(line)).toBe(kind);
  });
});

describe("inspectRunLogs", () => {
  it("shows process output instead of JSON transport metadata", () => {
    const output = [
      JSON.stringify({
        level: 40,
        time: 1794564096884,
        pid: 95901,
        hostname: "host",
        stream: "stderr",
        chunk: "\u001b[32mBuilding\u001b[0m\n",
      }),
      JSON.stringify({ level: 30, stream: "stdout", chunk: "Done\n" }),
    ].join("\n");
    expect(inspectRunLogs(output)).toEqual({ language: "text", content: "Building\nDone\n" });
  });

  it("preserves chunk boundaries, mixed output, and unknown records", () => {
    const output = [
      JSON.stringify({ stream: "stdout", chunk: "Build" }),
      JSON.stringify({ stream: "stdout", chunk: "ing\n" }),
      "Plain output",
      '{"custom":"value"}',
    ].join("\n");
    expect(inspectRunLogs(output).content).toBe('Building\nPlain output\n{"custom":"value"}');
  });

  it("supports JSON arrays of records and readable lifecycle messages", () => {
    expect(
      inspectRunLogs(
        JSON.stringify([
          { level: 30, msg: "Starting workflow" },
          { level: 50, msg: "Step failed" },
        ]),
      ).content,
    ).toBe("Starting workflow\nERROR  Step failed");
  });
});
