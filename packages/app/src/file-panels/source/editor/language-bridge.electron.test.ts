import { afterEach, expect, test, vi } from "vitest";
import type { DaemonClient } from "@mixer/client/internal/daemon-client";
import { InMemoryFileSession } from "../../file/testing";
import { WorkspaceDocuments } from "./documents";
import { SharedLanguageSession } from "./language-bridge.electron";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import pino from "pino";
import { z } from "zod";
import { WorkspaceLanguageSession } from "../../../../../server/src/server/language-services/session";
import * as processSpawner from "../../../../../server/src/utils/spawn";
import { incrementalDocumentChange } from "./language-document-change";

type LanguageInput = Parameters<DaemonClient["requestWorkspaceLanguageService"]>[0];
type Listener = Parameters<DaemonClient["subscribeRawMessages"]>[0];
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.restoreAllMocks();
});

function setup(syncKind?: number) {
  const files = new InMemoryFileSession();
  files.put("one.ts", "const one = 1;\n");
  files.put("two.ts", "const two = 2;\n");
  const documents = new WorkspaceDocuments("/repo", files);
  const listeners = new Set<Listener>();
  const connectionListeners = new Set<Parameters<DaemonClient["subscribeConnectionStatus"]>[0]>();
  let connected = true;
  const calls: LanguageInput[] = [];
  let initializeGate: Promise<void> = Promise.resolve();
  const blocked = new Map<string, { started(): void; result: Promise<unknown> }>();
  const client: Pick<
    DaemonClient,
    | "isConnected"
    | "subscribeRawMessages"
    | "subscribeConnectionStatus"
    | "requestWorkspaceLanguageService"
  > = {
    get isConnected() {
      return connected;
    },
    subscribeConnectionStatus(listener) {
      connectionListeners.add(listener);
      return () => {
        connectionListeners.delete(listener);
      };
    },
    subscribeRawMessages(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async requestWorkspaceLanguageService(input) {
      calls.push(input);
      const block = blocked.get(input.method);
      if (block) {
        blocked.delete(input.method);
        block.started();
        return block.result;
      }
      if (input.method === "initialize") {
        await initializeGate;
        return {
          capabilities: { textDocumentSync: syncKind },
          rootUri: "file:///repo",
          workspaceUri: "file:///repo",
        };
      }
      return null;
    },
  };
  const session = new SharedLanguageSession({
    client,
    documents,
    workspaceId: "workspace",
    language: "typescript",
  });
  const states: unknown[] = [];
  session.frames.add((method, params) => {
    if (method === "mixer/languageServiceState") states.push(params);
  });
  cleanups.push(() => {
    session.dispose();
    documents.dispose();
  });
  const crash = () => {
    for (const listener of listeners)
      listener({
        type: "workspace.language.notification",
        payload: {
          workspaceId: "workspace",
          language: "typescript",
          method: "mixer/languageServiceStopped",
          params: {},
        },
      });
  };
  return {
    files,
    documents,
    session,
    calls,
    states,
    crash,
    pauseInitialize(gate: Promise<void>) {
      initializeGate = gate;
    },
    blockNext(method: string) {
      const started = Promise.withResolvers<void>();
      const result = Promise.withResolvers<unknown>();
      blocked.set(method, { started: () => started.resolve(), result: result.promise });
      return { started: started.promise, reject: result.reject };
    },
    connection(isConnected: boolean) {
      connected = isConnected;
      for (const listener of connectionListeners)
        listener({ status: isConnected ? "connected" : "disconnected" });
    },
  };
}

test("routes virtual dependency reads and extension requests to the host without opening file buffers", async () => {
  const { session, calls, documents } = setup();
  await session.request("workspace/readFile", { uri: "jdt://dependency/Foo.class" }, "virtual");
  await session.request(
    "workspace/languageExtension",
    { method: "java/projectInfo", params: {} },
    "extension",
  );
  expect(
    calls
      .filter((call) => ["workspace/readFile", "workspace/languageExtension"].includes(call.method))
      .map((call) => ({ method: call.method, params: call.params })),
  ).toEqual([
    { method: "workspace/readFile", params: { uri: "jdt://dependency/Foo.class" } },
    { method: "workspace/languageExtension", params: { method: "java/projectInfo", params: {} } },
  ]);
  expect([...documents.entries()]).toEqual([]);
});

test("computes UTF-16 incremental edits without including unchanged text", () => {
  expect(
    incrementalDocumentChange(
      "first\nconst value = 1;\nlast\n",
      "first\nconst value = 123;\nlast\n",
    ),
  ).toEqual({
    range: { start: { line: 1, character: 15 }, end: { line: 1, character: 15 } },
    text: "23",
  });
  expect(incrementalDocumentChange("first\r\nlast", "first\r\nnew\r\nlast")).toEqual({
    range: { start: { line: 1, character: 0 }, end: { line: 1, character: 0 } },
    text: "new\r\n",
  });
  expect(incrementalDocumentChange("😀value", "😀other")).toEqual({
    range: { start: { line: 0, character: 2 }, end: { line: 0, character: 7 } },
    text: "other",
  });
});

test("uses incremental synchronization only when negotiated by the server", async () => {
  const { documents, session, calls } = setup(2);
  const one = documents.document("/repo/one.ts");
  await one.ready();
  await session.synchronize();
  expect(documents.edit(one, "const one = 12;\n", one.model.getSnapshot().version, "editor")).toBe(
    true,
  );
  await session.synchronize();
  expect(calls.find((call) => call.method === "textDocument/didChange")?.params).toEqual({
    textDocument: { uri: "file:///repo/one.ts", version: one.model.getSnapshot().version },
    contentChanges: [
      { range: { start: { line: 0, character: 13 }, end: { line: 0, character: 13 } }, text: "2" },
    ],
  });
});

test("switches document language ownership without changing the shared buffer", async () => {
  const { documents, session, calls } = setup();
  const one = documents.document("/repo/one.ts");
  await one.ready();
  await session.synchronize();
  documents.setDetectedLanguage(one, "typescript");
  documents.setLanguageMode(one, "python");
  await session.synchronize();
  expect(calls.find((call) => call.method === "textDocument/didClose")?.params).toEqual({
    textDocument: { uri: "file:///repo/one.ts" },
  });
  documents.setLanguageMode(one, "javascript");
  await session.synchronize();
  expect(
    calls.filter((call) => call.method === "textDocument/didOpen").map((call) => call.params),
  ).toMatchObject([
    { textDocument: { languageId: "typescript" } },
    { textDocument: { languageId: "javascript" } },
  ]);
  expect(one.model.getSnapshot().content).toBe("const one = 1;\n");
});

test("replays current unsaved buffers before a query without replacing documents or undo history", async () => {
  const fixture = setup();
  const { documents, session, calls, crash, states, files } = fixture;
  const one = documents.document("one.ts");
  const two = documents.document("two.ts");
  await Promise.all([one.ready(), two.ready()]);
  await session.request("textDocument/documentSymbol", {}, "first");
  calls.length = 0;
  let resume!: () => void;
  fixture.pauseInitialize(
    new Promise<void>((resolve) => {
      resume = resolve;
    }),
  );
  crash();
  expect(
    documents.edit(one, "const unsaved = 42;\n", one.model.getSnapshot().version, "editor"),
  ).toBe(true);
  const query = session.request("textDocument/completion", {}, "after-crash");
  resume();
  await query;
  expect(calls.map((call) => call.method)).toEqual([
    "initialize",
    "textDocument/didOpen",
    "textDocument/didOpen",
    "textDocument/completion",
  ]);
  expect(calls[1].params).toEqual({
    textDocument: {
      uri: "file:///repo/one.ts",
      languageId: "typescript",
      version: one.model.getSnapshot().version,
      text: "const unsaved = 42;\n",
    },
  });
  expect(calls[2].params).toEqual({
    textDocument: {
      uri: "file:///repo/two.ts",
      languageId: "typescript",
      version: two.model.getSnapshot().version,
      text: "const two = 2;\n",
    },
  });
  expect(states).toEqual([{ state: "restarting" }, { state: "ready" }]);
  expect(documents.document("one.ts")).toBe(one);
  expect(files.text("one.ts")).toBe("const one = 1;\n");
  expect(files.writes).toEqual([]);
  expect(await documents.undo(one)).toBe(true);
  expect(one.model.getSnapshot().content).toBe("const one = 1;\n");
});

test("stops after five automatic restarts in five minutes instead of looping on every edit", async () => {
  vi.spyOn(Date, "now").mockReturnValue(1000);
  const { session, calls, crash, states } = setup();
  await session.request("initialize", {}, "initial");
  for (let index = 0; index < 5; index++) {
    crash();
    await session.request("textDocument/documentSymbol", {}, `restart-${index}`);
  }
  crash();
  await expect(session.request("textDocument/completion", {}, "blocked")).rejects.toThrow(
    "Automatic restart is paused",
  );
  crash();
  await expect(session.synchronize()).rejects.toThrow("Automatic restart is paused");
  expect(calls.filter((call) => call.method === "initialize")).toHaveLength(6);
  expect(states.at(-1)).toEqual({
    state: "failed",
    message:
      "Language services stopped repeatedly. Automatic restart is paused. Retry language services to try again.",
  });
});

test("does not restart a disposed editor session", async () => {
  const { session, crash, calls } = setup();
  await session.request("initialize", {}, "initial");
  session.dispose();
  crash();
  expect(calls.map((call) => call.method)).toEqual(["initialize", "exit"]);
});

test("recovers a crash during initial connection and another crash during replay", async () => {
  const { session, calls, crash, blockNext, states } = setup();
  const startup = blockNext("initialize");
  const opening = session.request("initialize", {}, "opening");
  await startup.started;
  crash();
  startup.reject(new Error("Pending response rejected since connection got disposed"));
  await expect(opening).resolves.toMatchObject({ rootUri: "file:///repo" });
  const replay = blockNext("initialize");
  crash();
  await replay.started;
  crash();
  replay.reject(new Error("Pending response rejected since connection got disposed"));
  await expect(
    session.request("textDocument/documentSymbol", {}, "after-replay-crash"),
  ).resolves.toBeNull();
  expect(calls.filter((call) => call.method === "initialize")).toHaveLength(4);
  expect(states.at(-1)).toEqual({ state: "ready" });
});

test("a host reconnect supersedes interrupted recovery and replays buffers again", async () => {
  const { session, calls, crash, blockNext, connection, states } = setup();
  await session.request("initialize", {}, "initial");
  const restarting = blockNext("initialize");
  crash();
  await restarting.started;
  connection(false);
  restarting.reject(new Error("Host disconnected"));
  connection(true);
  await expect(
    session.request("textDocument/documentSymbol", {}, "reconnected"),
  ).resolves.toBeNull();
  expect(calls.filter((call) => call.method === "initialize")).toHaveLength(3);
  expect(states.at(-1)).toEqual({ state: "ready" });
});

test("retries an interrupted read after replay but never re-executes an edit command", async () => {
  const { session, calls, crash, blockNext } = setup();
  await session.request("initialize", {}, "initial");
  const read = blockNext("textDocument/documentSymbol");
  const result = session.request("textDocument/documentSymbol", {}, "read");
  await read.started;
  crash();
  read.reject(new Error("Pending response rejected since connection got disposed"));
  await expect(result).resolves.toBeNull();
  expect(calls.filter((call) => call.method === "textDocument/documentSymbol")).toHaveLength(2);
  const command = blockNext("workspace/executeCommand");
  const edit = session.request("workspace/executeCommand", { command: "edit" }, "edit");
  const rejected = expect(edit).rejects.toThrow("connection got disposed");
  await command.started;
  crash();
  command.reject(new Error("Pending response rejected since connection got disposed"));
  await rejected;
  await session.request("textDocument/documentSymbol", {}, "ready");
  expect(calls.filter((call) => call.method === "workspace/executeCommand")).toHaveLength(1);
});

test("explicit retry resets the crash budget and reinitializes without replacing buffers", async () => {
  vi.spyOn(Date, "now").mockReturnValue(1000);
  const { session, documents, calls, crash, states } = setup();
  const document = documents.document("one.ts");
  await document.ready();
  await session.request("initialize", {}, "initial");
  for (let index = 0; index < 5; index++) {
    crash();
    await session.request("textDocument/documentSymbol", {}, `restart-${index}`);
  }
  crash();
  await expect(session.request("textDocument/completion", {}, "blocked")).rejects.toThrow(
    "Automatic restart is paused",
  );
  expect(
    documents.edit(
      document,
      "const stillUnsaved = 1;\n",
      document.model.getSnapshot().version,
      "editor",
    ),
  ).toBe(true);
  session.retry();
  await session.request("textDocument/completion", {}, "manual-retry");
  expect(calls.filter((call) => call.method === "initialize")).toHaveLength(7);
  expect(documents.document("one.ts")).toBe(document);
  expect(document.model.getSnapshot().content).toBe("const stillUnsaved = 1;\n");
  expect(states.at(-1)).toEqual({ state: "ready" });
});

test("recovers real TypeScript completion and symbols from unsaved buffers after a process crash", async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "mixer-editor-recovery-")));
  const diskText = "const value = { fromDisk: 1 };\nvalue.";
  const unsavedText = "const value = { restoredFromUnsaved: 1 };\nvalue.";
  const files = new InMemoryFileSession();
  files.put("one.ts", diskText);
  files.put("two.ts", "export const diskSymbol = 1;\n");
  await writeFile(path.join(root, "one.ts"), diskText);
  await writeFile(path.join(root, "two.ts"), "export const diskSymbol = 1;\n");
  const documents = new WorkspaceDocuments(root, files);
  const listeners = new Set<Listener>();
  const host = new WorkspaceLanguageSession({
    getWorkspaceRoot: async () => root,
    emit(message) {
      for (const listener of listeners) listener(message);
    },
    logger: pino({ level: "silent" }),
  });
  const spawn = vi.spyOn(processSpawner, "spawnProcess");
  const client: Pick<
    DaemonClient,
    | "isConnected"
    | "subscribeRawMessages"
    | "subscribeConnectionStatus"
    | "requestWorkspaceLanguageService"
  > = {
    isConnected: true,
    subscribeConnectionStatus: () => () => {},
    subscribeRawMessages(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async requestWorkspaceLanguageService(input) {
      const request = {
        ...input,
        type: "workspace.language.query.request" as const,
        requestId: crypto.randomUUID(),
        notification: input.notification ?? false,
      };
      if (input.method === "exit") {
        await host.releaseChannel(request);
        return null;
      }
      return host.request(request);
    },
  };
  const session = new SharedLanguageSession({
    client,
    documents,
    workspaceId: "workspace",
    language: "typescript",
  });
  const recovered = Promise.withResolvers<void>();
  session.frames.add((method, params) => {
    if (
      method === "mixer/languageServiceState" &&
      z.object({ state: z.string() }).parse(params).state === "ready"
    )
      recovered.resolve();
  });
  try {
    const one = documents.document("one.ts");
    const two = documents.document("two.ts");
    await Promise.all([one.ready(), two.ready()]);
    one.model.holdAutosave();
    two.model.holdAutosave();
    expect(documents.edit(one, unsavedText, one.model.getSnapshot().version, "editor")).toBe(true);
    expect(
      documents.edit(
        two,
        "export const companionUnsaved = 2;\n",
        two.model.getSnapshot().version,
        "editor",
      ),
    ).toBe(true);
    const completionParams = {
      textDocument: { uri: pathToFileURL(path.join(root, "one.ts")).href },
      position: { line: 1, character: 6 },
    };
    await session.request("textDocument/completion", completionParams, "before");
    const child = spawn.mock.results[0];
    if (child.type !== "return") throw new Error("Expected a real TypeScript language server");
    child.value.kill("SIGKILL");
    await recovered.promise;
    const result = await session.request("textDocument/completion", completionParams, "after");
    const completion = z.object({ items: z.array(z.object({ label: z.string() })) }).parse(result);
    expect(completion.items.map((item) => item.label)).toContain("restoredFromUnsaved");
    expect(completion.items.map((item) => item.label)).not.toContain("fromDisk");
    const symbols = await session.request(
      "textDocument/documentSymbol",
      { textDocument: { uri: pathToFileURL(path.join(root, "two.ts")).href } },
      "symbols",
    );
    expect(
      z
        .array(z.object({ name: z.string() }))
        .parse(symbols)
        .map((symbol) => symbol.name),
    ).toEqual(["companionUnsaved"]);
    expect(await readFile(path.join(root, "one.ts"), "utf8")).toBe(diskText);
    expect(files.writes).toEqual([]);
    expect(documents.document("one.ts")).toBe(one);
    expect(one.model.getSnapshot().modified).toBe(true);
    expect(await documents.undo(one)).toBe(true);
    expect(one.model.getSnapshot().content).toBe(diskText);
    expect(two.model.getSnapshot().content).toBe("export const companionUnsaved = 2;\n");
  } finally {
    session.dispose();
    await host.dispose();
    documents.dispose();
    spawn.mockRestore();
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
