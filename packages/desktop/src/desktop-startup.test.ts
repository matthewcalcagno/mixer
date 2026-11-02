import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createAppProtocolHandler } from "./app-protocol";
import { describe, expect, it, vi } from "vitest";
import { runDesktopStartup } from "./desktop-startup";

describe("desktop startup", () => {
  it("runs CLI passthrough before GUI login-shell env inheritance", async () => {
    const calls: string[] = [];
    await runDesktopStartup({
      hasPendingGuiLaunchRequest: false,
      runCliPassthroughIfRequested: vi.fn(async () => {
        calls.push("cli");
        return true;
      }),
      inheritLoginShellEnv: vi.fn(() => calls.push("env")),
      bootstrapGui: vi.fn(async () => {
        calls.push("gui");
      }),
    });

    expect(calls).toEqual(["cli"]);
  });

  it("keeps login-shell env inheritance on normal GUI startup", async () => {
    const calls: string[] = [];
    await runDesktopStartup({
      hasPendingGuiLaunchRequest: false,
      runCliPassthroughIfRequested: vi.fn(async () => {
        calls.push("cli");
        return false;
      }),
      inheritLoginShellEnv: vi.fn(() => calls.push("env")),
      bootstrapGui: vi.fn(async () => {
        calls.push("gui");
      }),
    });

    expect(calls).toEqual(["cli", "env", "gui"]);
  });

  it("does not route open-project launches through CLI passthrough", async () => {
    const runCliPassthroughIfRequested = vi.fn(async () => true);
    const calls: string[] = [];

    await runDesktopStartup({
      hasPendingGuiLaunchRequest: true,
      runCliPassthroughIfRequested,
      inheritLoginShellEnv: vi.fn(() => calls.push("env")),
      bootstrapGui: vi.fn(async () => {
        calls.push("gui");
      }),
    });

    expect(runCliPassthroughIfRequested).not.toHaveBeenCalled();
    expect(calls).toEqual(["env", "gui"]);
  });
});

it("serves the Monaco document without redirecting it into the app router", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "mixer-app-protocol-"));
  try {
    await mkdir(path.join(root, "monaco"));
    await writeFile(path.join(root, "index.html"), "app shell");
    await writeFile(path.join(root, "monaco/index.html"), "editor runtime");
    const handle = createAppProtocolHandler(
      root,
      async (url) => new Response(await readFile(new URL(url))),
    );
    const editor = await handle({ url: "mixer://app/monaco/index.html" });
    expect(editor.status).toBe(200);
    expect(await editor.text()).toBe("editor runtime");
    const entry = await handle({ url: "mixer://app/index.html?test=1#anchor" });
    expect(entry.status).toBe(307);
    expect(entry.headers.get("location")).toBe("mixer://app/?test=1#anchor");
    expect(await (await handle({ url: "mixer://app/h/host/workspace/example" })).text()).toBe(
      "app shell",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
