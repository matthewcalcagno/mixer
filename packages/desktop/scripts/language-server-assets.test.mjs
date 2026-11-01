import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { copyLanguageServerAssets } from "./language-server-assets.js";

test("ships physical language-server inputs, including declaration files and Python stubs", () => {
  const root = mkdtempSync(path.join(tmpdir(), "mixer-language-assets-"));
  try {
    const source = path.join(root, "typescript");
    mkdirSync(path.join(source, "lib"), { recursive: true });
    writeFileSync(path.join(source, "lib/lib.d.ts"), "declare const value: string;");
    writeFileSync(path.join(source, "lib/server.pyi"), "value: str");
    const resources = path.join(root, "resources");
    copyLanguageServerAssets(resources, { typescript: source });
    const installed = path.join(resources, "language-servers/node_modules/typescript/lib");
    expect(readFileSync(path.join(installed, "lib.d.ts"), "utf8")).toBe(
      "declare const value: string;",
    );
    expect(readFileSync(path.join(installed, "server.pyi"), "utf8")).toBe("value: str");
    writeFileSync(path.join(installed, "obsolete.js"), "old");
    copyLanguageServerAssets(resources, { typescript: source });
    expect(existsSync(path.join(installed, "obsolete.js"))).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
