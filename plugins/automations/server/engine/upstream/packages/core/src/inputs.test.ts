import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { z, type EventSourceContext, type Extension } from "@mixer/automations-sdk";
import { Runtime } from "./runtime.js";

const runtimes: Runtime[] = [];
const homes: string[] = [];
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.stop();
  for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true });
});
async function fixture(extensions: Extension[]) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "rp-input-")); homes.push(home);
  const runtime = new Runtime({ home, builtins: extensions.map((extension) => ({ extension })) }); runtimes.push(runtime);
  await runtime.initialize();
  return runtime;
}
const candidate = { id: "input:1", type: "test.event", timestamp: "2026-10-08T00:00:00Z", data: { ok: true } };

describe("source-bound input admission", () => {
  it("derives the source and rejects cross-owner types and internal authority fields", async () => {
    const owner: Extension = { name: "owner", setup(api) {
      api.events.registerSource("test.event", { start() {} });
      api.inputs.register("owner.input", { configSchema: z.object({}).strict(), eventTypes: ["test.event"],
        async receive(input, _config, context) {
          const spoofed = { ...candidate, provenance: { kind: "replay" } };
          return { kind: "event", result: await context.emit(input === "valid" ? candidate : spoofed) };
        },
      });
    } };
    const other: Extension = { name: "other", setup(api) {
      api.inputs.register("other.input", { configSchema: z.object({}).strict(), eventTypes: ["test.event"],
        async receive(_input, _config, context) { return { kind: "event", result: await context.emit(candidate) }; },
      });
    } };
    const runtime = await fixture([owner, other]);
    expect(await runtime.submitInput("other.input", {})).toMatchObject({ kind: "event", result: { status: "rejected", reason: "source_not_owned" } });
    expect(runtime.database.getEvent(candidate.id)).toBeUndefined();
    await expect(runtime.submitInput("owner.input", "spoofed")).rejects.toThrow();
    expect(await runtime.submitInput("owner.input", "valid")).toMatchObject({ kind: "event", result: { status: "accepted" } });
    expect(runtime.database.getEvent(candidate.id)).toEqual({ ...candidate, source: "owner" });
  });

  it("waits for concurrent admission and never acknowledges a failed in-flight duplicate", async () => {
    let fail = true;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const extension: Extension = { name: "owner", setup(api) {
      api.events.registerSource("test.event", { start() {} });
      api.hooks.on("event:received", async () => { await gate; if (fail) throw new Error("admission failed"); });
    } };
    const runtime = await fixture([extension]);
    const first = runtime.receive({ ...candidate, source: "owner" });
    const second = runtime.receive({ ...candidate, source: "owner" });
    let secondFinished = false;
    void second.then(() => { secondFinished = true; }, () => { secondFinished = true; });
    await Promise.resolve();
    expect(secondFinished).toBe(false);
    release();
    const results = await Promise.allSettled([first, second]);
    expect(results.map((result) => result.status)).toEqual(["rejected", "rejected"]);
    expect(runtime.database.getEvent(candidate.id)).toBeUndefined();
    fail = false;
    expect(await runtime.receive({ ...candidate, source: "owner" })).toMatchObject({ status: "accepted" });
  });

  it("coalesces successful deliveries and scopes source emitters to their registered object", async () => {
    let context: EventSourceContext | undefined;
    const owner: Extension = { name: "owner", setup(api) {
      const source = { start(next: EventSourceContext) { context ??= next; } };
      api.events.registerSource("test.event", source);
      api.events.registerSource("test.second", source);
    } };
    const other: Extension = { name: "other", setup(api) { api.events.registerSource("other.event", { start() {} }); } };
    const runtime = await fixture([owner, other]); await runtime.start();
    const results = await Promise.all([runtime.receive({ ...candidate, source: "owner" }), runtime.receive({ ...candidate, source: "owner" })]);
    expect(results.map((result) => result.status)).toEqual(["accepted", "duplicate"]);
    expect(await context?.emit({ ...candidate, id: "second", type: "test.second", source: "owner" })).toMatchObject({ status: "accepted" });
    expect(await context?.emit({ ...candidate, id: "spoof", type: "other.event", source: "owner" })).toMatchObject({ status: "rejected", reason: "source_not_owned" });
    const retired = context;
    await runtime.reloadExtension("owner");
    expect(await retired?.emit({ ...candidate, id: "stale", source: "owner" })).toMatchObject({ status: "rejected" });
  });

  it("prevents a retired input handler from emitting after reload", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const owner: Extension = { name: "owner", setup(api) {
      api.events.registerSource("test.event", { start() {} });
      api.inputs.register("owner.input", { configSchema: z.object({}), eventTypes: ["test.event"],
        async receive(_input, _config, context) { await gate; return { kind: "event", result: await context.emit(candidate) }; },
      });
    } };
    const runtime = await fixture([owner]);
    const pending = runtime.submitInput("owner.input", {});
    const settled = Promise.allSettled([pending]);
    await runtime.reloadExtension("owner");
    release();
    expect((await settled)[0]?.status).toBe("rejected");
    expect(runtime.database.getEvent(candidate.id)).toBeUndefined();
  });
});
