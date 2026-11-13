import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Runtime, ensureHome, resolvePaths } from "@roboplane/core";
import github from "./index.js";

const runtimes: Runtime[] = [];
const homes: string[] = [];
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.stop();
  for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true });
  delete process.env.MIXER_AUTOMATIONS_GITHUB_INPUT_SECRET;
  vi.unstubAllGlobals();
});
async function fixture(configuration: Record<string, unknown> = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "rp-gh-input-")); homes.push(home);
  const paths = resolvePaths(home); ensureHome(paths);
  fs.writeFileSync(paths.config, JSON.stringify({ extensions: { github: { token: "test-token", polling: false, ...configuration } } }));
  const runtime = new Runtime({ home, builtins: [{ extension: github }] }); runtimes.push(runtime);
  await runtime.initialize();
  process.env.MIXER_AUTOMATIONS_GITHUB_INPUT_SECRET = "signature-secret";
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ login: "maintainer", id: 1 }), { status: 200 })));
  return runtime;
}
function input(body: string, overrides: Record<string, string> = {}) {
  return { endpoint: "github", local: false, body: Buffer.from(body), headers: {
    "x-hub-signature-256": `sha256=${createHmac("sha256", "signature-secret").update(body).digest("hex")}`,
    "x-github-delivery": "delivery-42", "x-github-event": "issues", ...overrides,
  } };
}
const config = { secretEnv: "MIXER_AUTOMATIONS_GITHUB_INPUT_SECRET" };

describe("GitHub shared-host input handler", () => {
  it("rejects the removed standalone listener configuration with an actionable error", async () => {
    const runtime = await fixture({ webhook: { secret: "old-secret", port: 8787 } });
    expect(runtime.extensions[0]?.error?.message).toBe("extensions.github.webhook is no longer supported; configure webhooks/*.yaml with handler: github.events and listener settings under extensions.webhooks");
    expect(runtime.registry.inputHandlers.has("github.events")).toBe(false);
    expect(runtime.registry.eventSources.has("github.issue")).toBe(false);
  });

  it("can disable repository-event polling without introducing a listener", async () => {
    const runtime = await fixture({ polling: false });
    const source = runtime.registry.eventSources.get("github.issue");
    await source?.start({ type: "github.issue", signal: new AbortController().signal,
      subscriptions: [{ type: "github.issue", repository: "owner/repo", workflowId: "fixture", config: {} }],
      emit: (event) => runtime.receive(event),
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(runtime.registry.inputHandlers.has("github.events")).toBe(true);
  });

  it("rejects invalid signatures, malformed payloads, missing IDs, and local observations", async () => {
    const runtime = await fixture();
    expect(await runtime.submitInput("github.events", input("{}", { "x-hub-signature-256": "wrong" }), config)).toEqual({ kind: "rejected", status: 401, reason: "authentication_failed" });
    expect(await runtime.submitInput("github.events", input("null"), config)).toEqual({ kind: "rejected", status: 400, reason: "invalid_payload" });
    expect(await runtime.submitInput("github.events", input("{}", { "x-github-delivery": "" }), config)).toEqual({ kind: "rejected", status: 400, reason: "delivery_id_required" });
    expect(await runtime.submitInput("github.events", { ...input("{}"), local: true }, config)).toEqual({ kind: "rejected", status: 403, reason: "provider_signature_required" });
  });

  it("requires subscribed repository scope and preserves normalized IDs and event facts", async () => {
    const runtime = await fixture();
    const body = JSON.stringify({ action: "opened", repository: { full_name: "owner/repo" }, sender: { id: 2, login: "contributor" },
      issue: { number: 42, title: "Issue", body: "Details", state: "open", labels: [], user: { login: "contributor" } } });
    expect(await runtime.submitInput("github.events", input(body), config)).toEqual({ kind: "rejected", status: 404, reason: "repository_not_subscribed" });
    await runtime.registry.eventSources.get("github.issue")?.updateSubscriptions?.("github.issue", [
      { type: "github.issue", workflowId: "fixture", repository: "owner/repo", config: { events: ["opened"] } },
    ]);
    expect(await runtime.submitInput("github.events", input(body), config)).toMatchObject({ kind: "event", result: { status: "accepted", eventId: "github:owner/repo:delivery-42" } });
    expect(runtime.database.getEvent("github:owner/repo:delivery-42")).toMatchObject({ source: "github", type: "github.issue", repository: "owner/repo", data: { number: 42, action: "opened", title: "Issue" } });
    expect(await runtime.submitInput("github.events", input(body), config)).toMatchObject({ kind: "event", result: { status: "duplicate" } });
  });
});
