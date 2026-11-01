import { describe, expect, it } from "vitest";
import { resultRows, statusMessage, limitMessage } from "./model.js";

describe("search result presentation", () => {
  const result = {
    status: "complete" as const,
    count: 1,
    limited: false,
    limitReason: null,
    elapsedMs: 1,
    files: [
      { path: "main.ts", matches: [{ line: 3, column: 2, preview: " needle", start: 1, end: 7 }] },
    ],
  };
  it("keeps file groups and hides collapsed matches", () => {
    expect(resultRows({ kind: "complete", result }, new Set())).toEqual([
      { kind: "file", path: "main.ts", count: 1 },
      {
        kind: "match",
        path: "main.ts",
        match: { line: 3, column: 2, preview: " needle", start: 1, end: 7 },
      },
    ]);
    expect(resultRows({ kind: "complete", result }, new Set(["main.ts"]))).toEqual([
      { kind: "file", path: "main.ts", count: 1 },
    ]);
  });
  it("does not expose stale results while a new query is pending", () => {
    expect(resultRows({ kind: "pending" }, new Set())).toEqual([]);
    expect(statusMessage({ kind: "pending" })).toBe("Searching…");
    expect(statusMessage({ kind: "cancelled" })).toBe("Search cancelled.");
    expect(statusMessage({ kind: "error", message: "Invalid regex" })).toBe("Invalid regex");
  });
  it("reports counts and truncation without presenting a partial set as complete", () => {
    expect(statusMessage({ kind: "complete", result })).toBe("1 result in 1 file");
    expect(
      statusMessage({
        kind: "complete",
        result: { ...result, count: 1000, limited: true, limitReason: "results" },
      }),
    ).toBe("1000+ results in 1 file");
    expect(limitMessage("timeout")).toBe("Search timed out. Narrow your query or file filters.");
  });
});
