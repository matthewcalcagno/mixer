import { mkdtemp, mkdir, writeFile, readFile, realpath, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import pino from "pino";
import { z } from "zod";
import { describe, expect, it, vi } from "vitest";
import * as processSpawner from "../../utils/spawn.js";
import { WorkspaceLanguageSession } from "./session.js";
import { languageServerPackageRoot } from "./runtime.js";
import type { WorkspaceLanguageRequest } from "@mixer/protocol/messages";
import { moveWorkspaceFile } from "./move.js";
import { getExplorerFileVersion } from "../file-explorer/service.js";
import { builtinLanguageServers, LanguageServerRegistry } from "./providers.js";

const completions = z.union([
  z.array(z.object({ label: z.string() })),
  z.object({ items: z.array(z.object({ label: z.string() })) }).transform((value) => value.items),
]);

describe("workspace language services", () => {
  it.runIf(process.platform !== "win32")(
    "reaps a language server's helper process when the wrapper crashes",
    async () => {
      const root = await realpath(await mkdtemp(path.join(tmpdir(), "mixer-lsp-helper-")));
      const entry = path.join(root, "server.mjs");
      const pidFile = path.join(root, "helper.pid");
      await writeFile(
        entry,
        `
      import { spawn } from 'node:child_process';
      import { writeFileSync } from 'node:fs';
      import { createMessageConnection, StreamMessageReader, StreamMessageWriter } from ${JSON.stringify(import.meta.resolve("vscode-jsonrpc/node.js"))};
      const helper = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
      writeFileSync(${JSON.stringify(pidFile)}, String(helper.pid));
      const connection = createMessageConnection(new StreamMessageReader(process.stdin), new StreamMessageWriter(process.stdout));
      connection.onRequest('initialize', () => ({ capabilities: {} }));
      connection.listen();
    `,
      );
      let stopped!: () => void;
      const stoppedEvent = new Promise<void>((resolve) => {
        stopped = resolve;
      });
      const registry = new LanguageServerRegistry(() => [
        {
          id: "helper-test",
          label: "Helper test",
          documents: [{ languageId: "test", extensions: [".test"] }],
          command: [process.execPath, entry],
        },
      ]);
      const spawn = vi.spyOn(processSpawner, "spawnProcess");
      const session = new WorkspaceLanguageSession({
        getWorkspaceRoot: async () => root,
        emit(message) {
          if (message.payload.method === "mixer/languageServiceStopped") stopped();
        },
        logger: pino({ level: "silent" }),
        registry,
      });
      let helperPid: number | undefined;
      try {
        await session.request({
          type: "workspace.language.query.request",
          requestId: "helper",
          workspaceId: "workspace",
          language: "helper-test",
          channelId: "editor",
          method: "initialize",
          params: {},
          notification: false,
        });
        const pid = Number(await readFile(pidFile, "utf8"));
        helperPid = pid;
        expect(() => process.kill(pid, 0)).not.toThrow();
        const child = spawn.mock.results[0];
        if (child.type !== "return") throw new Error("Expected a real server process");
        child.value.kill("SIGKILL");
        await stoppedEvent;
        await expect
          .poll(
            () => {
              try {
                process.kill(pid, 0);
                return true;
              } catch {
                return false;
              }
            },
            { timeout: 5000 },
          )
          .toBe(false);
      } finally {
        await session.dispose();
        spawn.mockRestore();
        if (helperPid) {
          try {
            process.kill(helperPid, "SIGKILL");
          } catch {
            /* Already reaped. */
          }
        }
        await rm(root, { recursive: true, force: true });
      }
    },
    15_000,
  );
  it("runs a registered custom language server with project-aware unsaved completions", async () => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), "mixer-custom-lsp-")));
    const bundled = builtinLanguageServers().find((provider) => provider.id === "typescript");
    if (!bundled) throw new Error("Missing bundled TypeScript provider");
    let enabled = true;
    const notifications: string[] = [];
    const registry = new LanguageServerRegistry(() =>
      enabled ? [{ ...bundled, id: "custom/typescript" }] : [],
    );
    const session = new WorkspaceLanguageSession({
      getWorkspaceRoot: async () => root,
      emit(message) {
        notifications.push(message.payload.method);
      },
      logger: pino({ level: "silent" }),
      registry,
    });
    const input: WorkspaceLanguageRequest = {
      type: "workspace.language.query.request",
      requestId: "custom",
      workspaceId: "workspace",
      language: "custom/typescript",
      channelId: "editor",
      method: "initialize",
      params: {},
      notification: false,
    };
    try {
      await session.request(input);
      const uri = pathToFileURL(path.join(root, "unsaved.ts")).href;
      await session.request({
        ...input,
        method: "textDocument/didOpen",
        notification: true,
        params: {
          textDocument: {
            uri,
            languageId: "typescript",
            version: 1,
            text: "const value = { customServerWorks: true };\nvalue.",
          },
        },
      });
      const result = await session.request({
        ...input,
        method: "textDocument/completion",
        params: { textDocument: { uri }, position: { line: 1, character: 6 } },
      });
      expect(completions.parse(result).map((item) => item.label)).toContain("customServerWorks");
      await expect(access(path.join(root, "unsaved.ts"))).rejects.toThrow();
      await expect(session.request({ ...input, language: "not-registered" })).rejects.toThrow(
        "not registered",
      );
      enabled = false;
      await session.refreshProviders();
      expect(notifications).toContain("mixer/languageServiceStopped");
      await expect(session.request(input)).rejects.toThrow("not registered");
    } finally {
      await session.dispose();
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);
  it("invalidates a crashed process so the same channel can initialize a fresh server", async () => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), "mixer-lsp-crash-")));
    const spawn = vi.spyOn(processSpawner, "spawnProcess");
    let stopped!: () => void;
    const stoppedEvent = new Promise<void>((resolve) => {
      stopped = resolve;
    });
    const session = new WorkspaceLanguageSession({
      getWorkspaceRoot: async () => root,
      emit(message) {
        if (message.payload.method === "mixer/languageServiceStopped") stopped();
      },
      logger: pino({ level: "silent" }),
    });
    const input: WorkspaceLanguageRequest = {
      type: "workspace.language.query.request",
      requestId: "crash",
      workspaceId: "workspace",
      language: "typescript",
      channelId: "editor",
      method: "initialize",
      params: {},
      notification: false,
    };
    try {
      await session.request(input);
      const child = spawn.mock.results[0];
      if (child.type !== "return") throw new Error("Expected a real language-server child");
      child.value.kill("SIGKILL");
      await stoppedEvent;
      await expect(
        session.request({ ...input, method: "$/cancelRequest", params: { id: "old-request" } }),
      ).rejects.toThrow("require initialization");
      expect(spawn).toHaveBeenCalledTimes(1);
      await session.request(input);
      const uri = pathToFileURL(path.join(root, "unsaved.ts")).href;
      await session.request({
        ...input,
        method: "textDocument/didOpen",
        notification: true,
        params: {
          textDocument: {
            uri,
            languageId: "typescript",
            version: 3,
            text: "const value = { restored: 1 };\nvalue.",
          },
        },
      });
      const result = await session.request({
        ...input,
        method: "textDocument/completion",
        params: {
          textDocument: { uri },
          position: { line: 1, character: 6 },
        },
      });
      expect(completions.parse(result).map((item) => item.label)).toContain("restored");
      expect(spawn).toHaveBeenCalledTimes(2);
      await expect(access(path.join(root, "unsaved.ts"))).rejects.toThrow();
    } finally {
      await session.dispose();
      spawn.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);
  it("does not report a stopped server when replacing the last editor channel", async () => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), "mixer-lsp-reopen-")));
    const messages: string[] = [];
    const session = new WorkspaceLanguageSession({
      getWorkspaceRoot: async () => root,
      emit(message) {
        if (message.payload.method === "window/logMessage") {
          const value = z
            .object({ type: z.number(), message: z.string() })
            .parse(message.payload.params);
          if (value.type === 1) messages.push(value.message);
        }
      },
      logger: pino({ level: "silent" }),
    });
    const input: WorkspaceLanguageRequest = {
      type: "workspace.language.query.request",
      requestId: "open",
      workspaceId: "workspace",
      language: "typescript",
      channelId: "first-editor",
      method: "initialize",
      params: {},
      notification: false,
    };
    try {
      await session.request(input);
      const closing = session.releaseChannel(input);
      const replacement = { ...input, channelId: "replacement-editor" };
      await session.request(replacement);
      await closing;
      const uri = pathToFileURL(path.join(root, "replacement.ts")).href;
      const text = "const value = { replacementAlive: 1 };\nvalue.";
      await session.request({
        ...replacement,
        method: "textDocument/didOpen",
        params: { textDocument: { uri, languageId: "typescript", version: 1, text } },
        notification: true,
      });
      const result = await session.request({
        ...replacement,
        method: "textDocument/completion",
        params: { textDocument: { uri }, position: { line: 1, character: 6 } },
      });
      expect(completions.parse(result).map((item) => item.label)).toContain("replacementAlive");
      expect(messages).toEqual([]);
    } finally {
      await session.dispose();
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);
  it("captures allowlisted edit commands and computes file-move import updates without writing", async () => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), "mixer-reviewed-lsp-")));
    const session = new WorkspaceLanguageSession({
      getWorkspaceRoot: async () => root,
      emit() {},
      logger: pino({ level: "silent" }),
    });
    let id = 0;
    const request = (
      method: WorkspaceLanguageRequest["method"],
      params: unknown,
      notification = false,
    ) =>
      session.request({
        type: "workspace.language.query.request",
        requestId: String(++id),
        messageId: id,
        workspaceId: "workspace",
        language: "typescript",
        channelId: "shared",
        method,
        params,
        notification,
      });
    try {
      await writeFile(
        path.join(root, "tsconfig.json"),
        JSON.stringify({
          compilerOptions: { module: "ESNext", target: "ES2022" },
          include: ["*.ts"],
        }),
      );
      await writeFile(path.join(root, "values.ts"), "export const a = 1; export const b = 2;\n");
      const file = path.join(root, "main.ts");
      const uri = pathToFileURL(file).href;
      const text =
        "import { b } from './values';\nimport { a } from './values';\nconsole.log(b, a);\n";
      await writeFile(file, text);
      await request("initialize", {});
      await request(
        "textDocument/didOpen",
        { textDocument: { uri, languageId: "typescript", version: 1, text } },
        true,
      );
      const edits = z
        .object({
          edit: z.object({
            changes: z.record(z.string(), z.array(z.object({ newText: z.string() }))),
          }),
        })
        .parse(
          await request("workspace/executeCommand", {
            command: "_typescript.organizeImports",
            arguments: [file],
          }),
        );
      expect(edits.edit.changes[uri]?.map((edit) => edit.newText).join("")).toBe(
        "import { a, b } from './values';\n",
      );
      expect(await readFile(file, "utf8")).toBe(text);
      await expect(
        request("workspace/executeCommand", {
          command: "_typescript.configurePlugin",
          arguments: ["unsafe", {}],
        }),
      ).rejects.toThrow("not allowed");
      const extractionFile = path.join(root, "extract.ts");
      const extractionUri = pathToFileURL(extractionFile).href;
      const extractionText = "export function sum() {\n  return 1 + 2;\n}\n";
      await writeFile(extractionFile, extractionText);
      await request(
        "textDocument/didOpen",
        {
          textDocument: {
            uri: extractionUri,
            languageId: "typescript",
            version: 1,
            text: extractionText,
          },
        },
        true,
      );
      const extracted = z
        .object({
          edit: z.object({
            changes: z.record(z.string(), z.array(z.object({ newText: z.string() }))),
          }),
        })
        .parse(
          await request("workspace/executeCommand", {
            command: "_typescript.applyRefactoring",
            arguments: [
              {
                file: extractionFile,
                refactor: "Extract Symbol",
                action: "function_scope_0",
                startLine: 2,
                startOffset: 10,
                endLine: 2,
                endOffset: 15,
              },
            ],
          }),
        );
      expect(extracted.edit.changes[extractionUri]?.map((edit) => edit.newText).join("")).toContain(
        "function newFunction",
      );
      expect(await readFile(extractionFile, "utf8")).toBe(extractionText);
      const move = z
        .object({ changes: z.record(z.string(), z.array(z.object({ newText: z.string() }))) })
        .parse(
          await request("workspace/willRenameFiles", {
            files: [
              {
                oldUri: pathToFileURL(path.join(root, "values.ts")).href,
                newUri: pathToFileURL(path.join(root, "utils.ts")).href,
              },
            ],
          }),
        );
      expect(move.changes[uri]?.map((edit) => edit.newText)).toEqual(["./utils", "./utils"]);
      expect(await readFile(file, "utf8")).toBe(text);
    } finally {
      await session.dispose();
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  it("moves a version-checked file without overwriting an existing destination", async () => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), "mixer-file-move-")));
    try {
      await mkdir(path.join(root, "src"));
      await writeFile(path.join(root, "one.ts"), "export const one = 1;\n");
      const version = await getExplorerFileVersion({ root, relativePath: "one.ts" });
      expect(version.status).toBe("ready");
      if (version.status !== "ready") throw new Error("Expected a source file");
      const oldUri = pathToFileURL(path.join(root, "one.ts")).href;
      const newUri = pathToFileURL(path.join(root, "src/two.ts")).href;
      await expect(
        moveWorkspaceFile(root, { oldUri, newUri, expectedRevision: "stale" }),
      ).rejects.toThrow("source file changed");
      const moved = await moveWorkspaceFile(root, {
        oldUri,
        newUri,
        expectedRevision: version.revision,
      });
      expect(await readFile(path.join(root, "src/two.ts"), "utf8")).toBe("export const one = 1;\n");
      await expect(access(path.join(root, "one.ts"))).rejects.toThrow();
      await writeFile(path.join(root, "one.ts"), "another file\n");
      await expect(
        moveWorkspaceFile(root, {
          oldUri: newUri,
          newUri: oldUri,
          expectedRevision: moved.revision,
        }),
      ).rejects.toThrow("EEXIST");
      expect(await readFile(path.join(root, "one.ts"), "utf8")).toBe("another file\n");
      expect(await readFile(path.join(root, "src/two.ts"), "utf8")).toBe("export const one = 1;\n");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("resolves packaged language servers outside app.asar", () => {
    const resources = path.join(tmpdir(), "MixerResources");
    const moduleUrl = pathToFileURL(
      path.join(
        resources,
        "app.asar/node_modules/@mixer/server/dist/server/language-services/runtime.js",
      ),
    );
    expect(languageServerPackageRoot("typescript", moduleUrl)).toBe(
      path.join(resources, "language-servers/node_modules/typescript"),
    );
  });

  it("can close while the workspace root is still loading without launching a late process", async () => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), "mixer-lsp-startup-")));
    let resolveRoot: (value: string) => void = () => {
      throw new Error("Root resolver was not initialized");
    };
    const waiting = new Promise<string>((resolve) => {
      resolveRoot = resolve;
    });
    const session = new WorkspaceLanguageSession({
      getWorkspaceRoot: () => waiting,
      emit() {},
      logger: pino({ level: "silent" }),
    });
    const starting = session.request({
      type: "workspace.language.query.request",
      requestId: "startup",
      workspaceId: "workspace",
      language: "typescript",
      channelId: "editor",
      method: "initialize",
      params: {},
      notification: false,
    });
    const rejected = expect(starting).rejects.toThrow("Language service session is closed");
    await session.dispose();
    resolveRoot(root);
    await rejected;
    await rm(root, { recursive: true, force: true });
  });

  it("uses tsconfig aliases for completion, cross-file navigation and rename without writing files", async () => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), "mixer-typescript-lsp-")));
    const session = new WorkspaceLanguageSession({
      getWorkspaceRoot: async () => root,
      emit() {},
      logger: pino({ level: "silent" }),
    });
    let sequence = 0;
    const request = (
      method: WorkspaceLanguageRequest["method"],
      params: unknown,
      notification = false,
    ) =>
      session.request({
        type: "workspace.language.query.request",
        requestId: `${++sequence}`,
        messageId: sequence,
        workspaceId: "workspace",
        language: "typescript",
        channelId: "editor",
        method,
        params,
        notification,
      });
    try {
      await mkdir(path.join(root, "src"));
      await writeFile(
        path.join(root, "tsconfig.json"),
        JSON.stringify({
          compilerOptions: { strict: true, baseUrl: ".", paths: { "@/*": ["src/*"] } },
          include: ["src"],
        }),
      );
      const person = "export const person = { name: 'Ada', age: 30 };\n";
      await writeFile(path.join(root, "src/person.ts"), person);
      const text = "import { person } from '@/person';\nperson.";
      const filename = path.join(root, "src/main.ts");
      const uri = pathToFileURL(filename).href;
      await writeFile(filename, text);
      await request("initialize", {});
      await request(
        "textDocument/didOpen",
        { textDocument: { uri, languageId: "typescript", text, version: 1 } },
        true,
      );
      const result = await request("textDocument/completion", {
        textDocument: { uri },
        position: { line: 1, character: 7 },
      });
      expect(completions.parse(result).map(({ label }) => label)).toEqual(
        expect.arrayContaining(["name", "age"]),
      );
      const definitions = z.array(z.object({ targetUri: z.string() })).parse(
        await request("textDocument/definition", {
          textDocument: { uri },
          position: { line: 1, character: 2 },
        }),
      );
      expect(definitions.map(({ targetUri }) => targetUri)).toEqual([
        pathToFileURL(path.join(root, "src/person.ts")).href,
      ]);
      const personUri = pathToFileURL(path.join(root, "src/person.ts")).href;
      await request(
        "textDocument/didOpen",
        { textDocument: { uri: personUri, languageId: "typescript", text: person, version: 1 } },
        true,
      );
      const renamed = z
        .object({ changes: z.record(z.string(), z.array(z.object({ newText: z.string() }))) })
        .parse(
          await request("textDocument/rename", {
            textDocument: { uri: personUri },
            position: { line: 0, character: 15 },
            newName: "customer",
          }),
        );
      expect(Object.keys(renamed.changes).sort()).toEqual(
        [uri, pathToFileURL(path.join(root, "src/person.ts")).href].sort(),
      );
      expect(renamed.changes[personUri]?.map(({ newText }) => newText)).toEqual(["customer"]);
      expect(await readFile(path.join(root, "src/person.ts"), "utf8")).toBe(person);
      await request(
        "textDocument/didChange",
        {
          textDocument: { uri: personUri, version: 2 },
          contentChanges: [{ text: "export const person = { name: 123, age: 30 };\n" }],
        },
        true,
      );
      await request(
        "textDocument/didChange",
        {
          textDocument: { uri, version: 2 },
          contentChanges: [{ text: "import { person } from '@/person';\nperson.name" }],
        },
        true,
      );
      const hover = await request("textDocument/hover", {
        textDocument: { uri },
        position: { line: 1, character: 9 },
      });
      expect(JSON.stringify(hover)).toContain("name: number");
      expect(await readFile(path.join(root, "src/person.ts"), "utf8")).toBe(person);
      await expect(
        request(
          "textDocument/didOpen",
          {
            textDocument: {
              uri: pathToFileURL(path.join(root, "../outside.ts")).href,
              languageId: "typescript",
              text: "",
              version: 1,
            },
          },
          true,
        ),
      ).rejects.toThrow("Language-service file is outside the workspace");
    } finally {
      await session.dispose();
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  it("resolves Python imports for completion with the bundled Pyright server", async () => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), "mixer-python-lsp-")));
    const session = new WorkspaceLanguageSession({
      getWorkspaceRoot: async () => root,
      emit() {},
      logger: pino({ level: "silent" }),
    });
    let sequence = 0;
    const request = (
      method: WorkspaceLanguageRequest["method"],
      params: unknown,
      notification = false,
    ) =>
      session.request({
        type: "workspace.language.query.request",
        requestId: `${++sequence}`,
        messageId: sequence,
        workspaceId: "workspace",
        language: "python",
        channelId: "editor",
        method,
        params,
        notification,
      });
    try {
      await writeFile(
        path.join(root, "helpers.py"),
        "def greet(name: str) -> str:\n    return 'Hello ' + name\n",
      );
      const filename = path.join(root, "main.py");
      const text = "from helpers import greet\nmessage = greet('Ada')\nmessage.";
      const uri = pathToFileURL(filename).href;
      await writeFile(filename, text);
      await request("initialize", {});
      await request(
        "textDocument/didOpen",
        { textDocument: { uri, languageId: "python", text, version: 1 } },
        true,
      );
      const result = await request("textDocument/completion", {
        textDocument: { uri },
        position: { line: 2, character: 8 },
      });
      expect(completions.parse(result).map(({ label }) => label)).toContain("upper");
      const definition = await request("textDocument/definition", {
        textDocument: { uri },
        position: { line: 1, character: 12 },
      });
      expect(JSON.stringify(definition)).toContain(
        pathToFileURL(path.join(root, "helpers.py")).href,
      );
    } finally {
      await session.dispose();
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);
});
