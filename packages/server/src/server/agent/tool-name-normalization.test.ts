import { describe, expect, it } from "vitest";

import { getMixerToolLeafName, isMixerToolName } from "@mixer/protocol/tool-name-normalization";

describe("isMixerToolName", () => {
  it("detects Claude Code format", () => {
    expect(isMixerToolName("mcp__mixer__create_agent")).toBe(true);
    expect(isMixerToolName("mcp__mixer__list_agents")).toBe(true);
  });

  it("detects mixer_voice variant", () => {
    expect(isMixerToolName("mcp__mixer_voice__create_agent")).toBe(true);
    expect(isMixerToolName("mixer_voice.create_agent")).toBe(true);
  });

  it("excludes speak tools", () => {
    expect(isMixerToolName("mcp__mixer_voice__speak")).toBe(false);
    expect(isMixerToolName("mcp__mixer__speak")).toBe(false);
    expect(isMixerToolName("mixer.speak")).toBe(false);
  });

  it("detects Codex dot format", () => {
    expect(isMixerToolName("mixer.create_agent")).toBe(true);
  });

  it("rejects non-mixer tools", () => {
    expect(isMixerToolName("Bash")).toBe(false);
    expect(isMixerToolName("Read")).toBe(false);
    expect(isMixerToolName("mcp__other_server__some_tool")).toBe(false);
  });
});

describe("getMixerToolLeafName", () => {
  it("extracts leaf from Claude Code format", () => {
    expect(getMixerToolLeafName("mcp__mixer__create_agent")).toBe("create_agent");
  });

  it("extracts leaf from Codex format", () => {
    expect(getMixerToolLeafName("mixer.create_agent")).toBe("create_agent");
    expect(getMixerToolLeafName("mixer.list_agents")).toBe("list_agents");
  });

  it("returns null for non-mixer tools", () => {
    expect(getMixerToolLeafName("Bash")).toBeNull();
  });
});
