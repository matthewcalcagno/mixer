import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { verifyRipgrepAssets } from "./ripgrep-assets.js";

test("packaging checks physical search binaries for each target, including both universal Mac architectures", () => {
  const root = mkdtempSync(path.join(tmpdir(), "mixer-rg-assets-"));
  try {
    function install(platform, arch, executable) {
      const bin = path.join(
        root,
        "app.asar.unpacked/node_modules/@vscode",
        `ripgrep-${platform}-${arch}`,
        "bin",
      );
      mkdirSync(bin, { recursive: true });
      writeFileSync(path.join(bin, executable), "fixture");
    }
    expect(() => verifyRipgrepAssets(root, "darwin", "arm64")).toThrow("Missing Search engine");
    install("darwin", "arm64", "rg");
    expect(() => verifyRipgrepAssets(root, "darwin", "arm64")).not.toThrow();
    expect(() => verifyRipgrepAssets(root, "darwin", "universal")).toThrow("ripgrep-darwin-x64");
    install("darwin", "x64", "rg");
    expect(() => verifyRipgrepAssets(root, "darwin", "universal")).not.toThrow();
    install("win32", "x64", "rg.exe");
    expect(() => verifyRipgrepAssets(root, "win32", "x64")).not.toThrow();
    expect(() => verifyRipgrepAssets(root, "linux", "x64")).toThrow("ripgrep-linux-x64");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
