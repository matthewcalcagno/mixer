import { describe, expect, it } from "vitest";
import type { Event, Run } from "@mixer/automations-sdk";
import {
  communicationInstructions, communicationPolicy, validateMaintainerCommunication,
} from "./communication.js";

const event: Event = {
  id: "event-42",
  type: "forge.pull-request",
  source: "test",
  timestamp: "2026-08-26T00:00:00.000Z",
  repository: "owner/repo",
  data: { number: 42, url: "https://forge.test/owner/repo/pulls/42" },
};

const run: Run = {
  id: "rp_test",
  workflowId: "reviews/main.md",
  repository: "owner/repo",
  event,
  status: "running",
  createdAt: event.timestamp,
  updatedAt: event.timestamp,
};

describe("core maintainer communication", () => {
  it("accepts concise communication in the configured language with authoritative references", () => {
    const result = validateMaintainerCommunication({
      version: 1,
      language: "Spanish",
      messages: [{
        purpose: "change",
        subject: "Corrige la validación del encabezado",
        body: "La validación descrita en #42 aceptaba una entrada incompleta. Este cambio comprueba el valor antes de usarlo y mantiene el comportamiento existente para entradas válidas.",
        references: [
          { source: "repository", value: "owner/repo" },
          { source: "event", value: "42" },
          { source: "workspace", value: "src/header.ts" },
          { source: "verification", value: "pnpm test" },
        ],
      }],
    }, communicationPolicy("Spanish"), {
      event,
      run,
      artifact: { version: 1, baseRevision: "base", files: [{ path: "src/header.ts", operation: "update", mode: "100644", size: 1 }], hash: "hash" },
      verification: [{ command: "pnpm", args: ["test"], exitCode: 0, stdout: "", stderr: "", passed: true }],
    });
    expect(result.messages[0]?.subject).toBe("Corrige la validación del encabezado");
  });

  it.each([
    ["wrong language", { language: "French", messages: [{ purpose: "reply", body: "Direct response.", references: [] }] }, "communication_language_mismatch"],
    ["emoji", { language: "English", messages: [{ purpose: "reply", body: "Fixed it ✅", references: [] }] }, "emoji_not_allowed"],
    ["heading", { language: "English", messages: [{ purpose: "reply", body: "## Summary\n\nFixed it.", references: [] }] }, "markdown_heading_not_allowed"],
    ["invented reference", { language: "English", messages: [{ purpose: "reply", body: "Checked it.", references: [{ source: "event", value: "999" }] }] }, "communication_reference_unverified"],
    ["invented textual reference", { language: "English", messages: [{ purpose: "reply", body: "This is fixed in #999.", references: [] }] }, "communication_text_reference_unverified"],
  ])("rejects %s", (_name, candidate, reason) => {
    expect(() => validateMaintainerCommunication({ version: 1, ...candidate }, communicationPolicy("English"), { event, run })).toThrow(reason);
  });

  it("injects one shared language and style contract into agent context", () => {
    const instructions = communicationInstructions(communicationPolicy("Japanese"), "operator").join("\n");
    expect(instructions).toContain("written in Japanese");
    expect(instructions).toContain("sole source of public prose for every integration");
  });

  it("supports integration-neutral problem reports with a required subject", () => {
    const result = validateMaintainerCommunication({
      version: 1,
      language: "English",
      messages: [{
        purpose: "report",
        subject: "Parser accepts truncated headers",
        body: "The parser reads the payload before checking the declared header length. A focused regression test and an early length check would close the gap.",
        references: [{ source: "repository", value: "owner/repo" }],
      }],
    }, communicationPolicy("English"), { event, run });
    expect(result.messages[0]?.purpose).toBe("report");
  });
});
