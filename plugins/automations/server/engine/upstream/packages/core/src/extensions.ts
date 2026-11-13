import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import type { Extension } from "@mixer/automations-sdk";

export interface LoadedExtension {
  extension: Extension;
  path: string;
  enabled: boolean;
  error?: Error;
}

export function discoverExtensionFiles(directory: string): string[] {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name);
    if (entry.isFile() && /\.(?:mjs|js|ts)$/.test(entry.name)) return [target];
    if (entry.isDirectory()) {
      for (const index of ["index.ts", "index.js", "index.mjs"]) {
        const candidate = path.join(target, index);
        if (fs.existsSync(candidate)) return [candidate];
      }
    }
    return [];
  }).sort();
}

export function createExtensionTsconfig(stateDirectory: string): string {
  const file = path.join(stateDirectory, "extension-tsconfig.json");
  const require = createRequire(import.meta.url);
  const sdkRoot = process.env.MIXER_AUTOMATIONS_SDK_ROOT ?? require.resolve.paths("@mixer/automations-sdk")
    ?.map((directory) => path.join(directory, "@roboplane", "sdk"))
    .find((directory) => fs.existsSync(path.join(directory, "package.json")));
  if (!sdkRoot) throw new Error("Cannot resolve @mixer/automations-sdk for local extensions");
  const sdkEntry = fs.existsSync(path.join(sdkRoot, "dist", "index.js"))
    ? path.join(sdkRoot, "dist", "index.js")
    : path.join(sdkRoot, "src", "index.ts");
  const zodEntry = path.join(path.dirname(require.resolve("zod/package.json")), "index.js");
  fs.writeFileSync(file, JSON.stringify({
    compilerOptions: {
      target: "ES2024",
      module: "NodeNext",
      moduleResolution: "NodeNext",
      paths: {
        "@mixer/automations-sdk": [sdkEntry],
        zod: [zodEntry],
      },
    },
  }, null, 2));
  return file;
}

export async function importExtension(file: string, tsconfig?: string): Promise<Extension> {
  let module: { default?: unknown };
  if (file.endsWith(".ts")) {
    if (!tsconfig) throw new Error("TypeScript extensions require a generated tsconfig");
    const compiled = path.join(path.dirname(tsconfig), `.extension-${path.basename(path.dirname(file))}-${fs.statSync(file).mtimeMs}.mjs`);
    await build({
      entryPoints: [file], outfile: compiled, bundle: true, platform: "node", format: "esm", target: "node24",
      packages: process.env.MIXER_AUTOMATIONS_EMBEDDED === "1" ? "bundle" : "external", tsconfig, sourcemap: "inline", logLevel: "silent",
    });
    try {
      module = await import(`${pathToFileURL(compiled).href}?v=${fs.statSync(file).mtimeMs}`) as { default?: unknown };
    } finally {
      fs.rmSync(compiled, { force: true });
    }
  } else {
    module = await import(`${pathToFileURL(file).href}?v=${fs.statSync(file).mtimeMs}`) as { default?: unknown };
  }
  const initial = module.default as { default?: unknown } | undefined;
  const extension = initial && typeof initial === "object" && !("name" in initial) && "default" in initial
    ? initial.default
    : initial;
  if (!extension || typeof extension !== "object" || !("name" in extension) || !("setup" in extension)) {
    throw new Error(`Extension ${file} has no valid default export`);
  }
  return extension as Extension;
}
