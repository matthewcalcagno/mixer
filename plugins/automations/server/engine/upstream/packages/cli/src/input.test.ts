import { describe, expect, it } from "vitest";
import { repositoryOption, submissionInput } from "./input.js";

describe("CLI submission inputs", () => {
  it("keeps shorthand values as strings and preserves equals signs and empty values", () => {
    expect(submissionInput({ arg: ["issue=123", "enabled=true", "token=a=b", "note="] })).toEqual({ issue: "123", enabled: "true", token: "a=b", note: "" });
    expect(submissionInput({ input: '{"issue":123,"enabled":true,"nested":{"name":"triage"}}' })).toEqual({ issue: 123, enabled: true, nested: { name: "triage" } });
    expect(submissionInput({})).toEqual({});
  });
  it("rejects conflicting forms, duplicate keys, unsafe names, malformed JSON, and oversized inputs", () => {
    expect(() => submissionInput({ input: "{}", arg: ["issue=1"] })).toThrow("Use only one");
    expect(() => submissionInput({ input: "{}", inputFile: "unused" })).toThrow("Use only one");
    expect(() => submissionInput({ arg: ["issue=1", "issue=2"] })).toThrow("Duplicate");
    for (const arg of ["__proto__=x", "constructor=x", "prototype=x", "issue.number=1", "missing"]) expect(() => submissionInput({ arg: [arg] })).toThrow("key=value");
    expect(() => submissionInput({ input: "{" })).toThrow("valid JSON");
    expect(() => submissionInput({ input: JSON.stringify("x".repeat(48 * 1024)) })).toThrow("48 KiB");
  });
  it("resolves repository shortcuts without silently overriding a different repository", () => {
    expect(repositoryOption({ repo: "owner/repo" })).toBe("owner/repo");
    expect(repositoryOption({ repository: "owner/repo", repo: "owner/repo" })).toBe("owner/repo");
    expect(() => repositoryOption({ repository: "owner/one", repo: "owner/two" })).toThrow("different repositories");
  });
});
