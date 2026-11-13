import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { dirname } from "node:path";

const require = createRequire(import.meta.url);
const previous = process.env.ESBUILD_BINARY_PATH;
const packageFile = require.resolve("esbuild/package.json");
if (packageFile.includes("app.asar")) {
  const executable = process.platform === "win32" ? "esbuild.exe" : "bin/esbuild";
  const binary = require.resolve(`@esbuild/${process.platform}-${process.arch}/${executable}`, {
    paths: [dirname(packageFile)],
  });
  const unpacked = binary.replace(/([/\\])app\.asar([/\\])/, "$1app.asar.unpacked$2");
  if (existsSync(unpacked)) process.env.ESBUILD_BINARY_PATH = unpacked;
}
// Match the daemon compiler's asar handling before esbuild captures its executable path.
const runtime = require("esbuild") as typeof import("esbuild");
if (previous === undefined) delete process.env.ESBUILD_BINARY_PATH;
else process.env.ESBUILD_BINARY_PATH = previous;
export const build = runtime.build;
