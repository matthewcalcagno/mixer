import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { applyFileProposal } from "./proposal.js";

const temporary: string[] = [];
function temp(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "roboplane-proposal-"));
  temporary.push(directory);
  return directory;
}
afterEach(() => {
  for (const directory of temporary.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe("proposal-only file application", () => {
  it("applies bounded UTF-8 file operations", () => {
    const root = temp();
    fs.writeFileSync(path.join(root, "old.txt"), "old");
    fs.writeFileSync(path.join(root, "delete.txt"), "remove");
    applyFileProposal(root, [
      { path: "old.txt", operation: "update", content: "new", mode: "644" },
      { path: "nested/new.txt", operation: "add", content: "added", mode: "644" },
      { path: "delete.txt", operation: "delete", mode: "644" },
    ]);
    expect(fs.readFileSync(path.join(root, "old.txt"), "utf8")).toBe("new");
    expect(fs.readFileSync(path.join(root, "nested/new.txt"), "utf8")).toBe("added");
    expect(fs.existsSync(path.join(root, "delete.txt"))).toBe(false);
  });

  it.each(["../outside", "/absolute", ".git/config", "nested\\windows", "NUL.txt", "drive:name"])("rejects unsafe path %s", (unsafe) => {
    const root = temp();
    expect(() => applyFileProposal(root, [{ path: unsafe, operation: "add", content: "x", mode: "644" }])).toThrow(/proposal_path/);
  });

  it("rejects symlink traversal and mismatched operations", () => {
    const root = temp();
    const outside = temp();
    fs.symlinkSync(outside, path.join(root, "link"));
    expect(() => applyFileProposal(root, [{ path: "link/file", operation: "add", content: "x", mode: "644" }])).toThrow("proposal_symlink_path");
    expect(() => applyFileProposal(root, [{ path: "missing", operation: "update", content: "x", mode: "644" }])).toThrow("proposal_update_target_invalid");
  });
});
