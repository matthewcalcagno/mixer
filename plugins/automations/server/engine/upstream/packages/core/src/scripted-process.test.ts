import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import { CoreProcessAPI } from "./process.js";

const directories: string[] = [];
function temp() { const dir = fs.mkdtempSync(path.join(os.tmpdir(), "roboplane-process-tree-")); directories.push(dir); return dir; }
afterEach(() => { for (const dir of directories.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

describe("scripted process supervision", () => {
  it("cancels shell descendants before they can perform later effects", async () => {
    const dir = temp(); const started = path.join(dir, "started"); const marker = path.join(dir, "survived");
    const controller = new AbortController();
    const operation = new CoreProcessAPI().run({ command: "bash", args: ["-c", "bash -c 'sleep 0.5; printf survived > \"$MARKER\"' & printf started > \"$STARTED\"; wait"],
      env: { STARTED: started, MARKER: marker }, signal: controller.signal, timeout: 3000, captureOutput: false });
    const deadline = Date.now() + 2000;
    while (!fs.existsSync(started) && Date.now() < deadline) await delay(10);
    expect(fs.existsSync(started)).toBe(true);
    controller.abort(new Error("test cancelled"));
    await expect(operation).rejects.toThrow();
    await delay(650);
    expect(fs.existsSync(marker)).toBe(false);
  });
  it("escalates when a shell ignores termination", async () => {
    const operation = new CoreProcessAPI().run({ command: "bash", args: ["-c", "trap '' TERM; sleep 10"], timeout: 50, captureOutput: false });
    await expect(operation).rejects.toThrow("timeout");
  }, 5000);
  it("streams large output without accumulating it", async () => {
    let bytes = 0;
    const result = await new CoreProcessAPI().run({ command: process.execPath, args: ["-e", "process.stdout.write('x'.repeat(5 * 1024 * 1024))"], captureOutput: false,
      onStdout: (chunk) => { bytes += Buffer.byteLength(chunk); } });
    expect({ bytes, exit: result.exitCode, captured: result.stdout }).toEqual({ bytes: 5 * 1024 * 1024, exit: 0, captured: "" });
  });
  it("refuses to start an already cancelled command", async () => {
    const dir = temp(); const file = path.join(dir, "launched");
    const controller = new AbortController(); controller.abort(new Error("already cancelled"));
    await expect(new CoreProcessAPI().run({ command: "sh", args: ["-c", "printf launched > \"$MARKER\""], env: { MARKER: file }, signal: controller.signal })).rejects.toThrow("already cancelled");
    expect(fs.existsSync(file)).toBe(false);
  });
});
