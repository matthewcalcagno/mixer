import { build } from "esbuild";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
// Reuse the CLI's actual control protocol for scripted handoffs, queries, and Safe Actions.
const cliSource = await readFile(join(root, "upstream/packages/cli/src/index.ts"), "utf8");
const controlStart = cliSource.indexOf("function controlPath(): string");
const controlEnd = cliSource.indexOf("async function daemon(): Promise<void>");
if (controlStart < 0 || controlEnd < controlStart)
  throw new Error("Review the upstream control-server extraction before building.");
await mkdir(join(root, "generated"), { recursive: true });
await writeFile(
  join(root, "generated/control-server.ts"),
  'import fs from "node:fs";\nimport path from "node:path";\nimport net from "node:net";\nimport { z } from "zod";\nimport { Runtime, actionRequestSchema, ensureHome, resolvePaths } from "@roboplane/core";\n' +
    cliSource
      .slice(controlStart, controlEnd)
      .replace("async function startControlServer(", "export async function startControlServer("),
);
const common = {
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  packages: "external",
  sourcemap: true,
  tsconfig: join(root, "upstream/tsconfig.json"),
  plugins: [
    {
      name: "pinned-engine-packages",
      setup(builder) {
        builder.onResolve({ filter: /^esbuild$/ }, (args) =>
          args.importer === join(root, "esbuild-host.ts")
            ? { path: "esbuild", external: true }
            : { path: join(root, "esbuild-host.ts") },
        );
        builder.onResolve({ filter: /^better-sqlite3$/ }, () => ({
          path: join(root, "sqlite.ts"),
        }));
        builder.onResolve({ filter: /^@roboplane\// }, ({ path }) => ({
          path: join(root, "upstream/packages", path.slice("@roboplane/".length), "src/index.ts"),
        }));
        builder.onResolve({ filter: /^@mixer\/automations-sdk$/ }, () => ({
          path: join(root, "upstream/packages/sdk/src/index.ts"),
        }));
      },
    },
  ],
};
await mkdir(join(root, "dist/sdk/dist"), { recursive: true });
await import("./upstream/packages/cli/copy-docs.mjs");
await cp(join(root, "upstream/packages/cli/dist/docs"), join(root, "dist/docs"), {
  recursive: true,
});
await build({
  ...common,
  entryPoints: [join(root, "index.ts")],
  outfile: join(root, "dist/index.js"),
});
await build({
  ...common,
  entryPoints: [join(root, "upstream/packages/cli/src/index.ts")],
  outfile: join(root, "dist/cli.js"),
});
await build({
  ...common,
  entryPoints: [join(root, "upstream/packages/sdk/src/index.ts")],
  outfile: join(root, "dist/sdk/dist/index.js"),
});
await build({
  ...common,
  entryPoints: [join(root, "environment.ts")],
  outfile: join(root, "dist/environment.js"),
});
await writeFile(
  join(root, "dist/sdk/package.json"),
  JSON.stringify({
    name: "@mixer/automations-sdk",
    type: "module",
    exports: { ".": { types: "./dist/index.d.ts", default: "./dist/index.js" } },
  }),
);
await writeFile(
  join(root, "dist/embedded-cli.js"),
  'import { fileURLToPath } from "node:url";\nimport { configureEmbeddedEnvironment } from "./environment.js";\nconst index = process.argv.indexOf("--home");\nconst home = index >= 0 ? process.argv[index + 1] : process.env.MIXER_AUTOMATIONS_HOME;\nif (!home) throw new Error("Mixer Automations requires an explicit host home.");\nif (index >= 0) process.argv.splice(index, 2);\nconfigureEmbeddedEnvironment(home, fileURLToPath(new URL("./sdk", import.meta.url)));\nawait import("./cli.js");\n',
);
// Keep the original CLI test entry point runnable without installing the upstream pnpm workspace.
const testCli = join(root, "upstream/packages/cli/dist");
await mkdir(testCli, { recursive: true });
const cliModule = relative(testCli, join(root, "dist/cli.js")).replaceAll("\\", "/");
const sdkModule = relative(testCli, join(root, "dist/sdk")).replaceAll("\\", "/");
await writeFile(
  join(testCli, "index.js"),
  `import { fileURLToPath } from "node:url";\nprocess.env.MIXER_AUTOMATIONS_SDK_ROOT = fileURLToPath(new URL(${JSON.stringify(sdkModule)}, import.meta.url));\nawait import(${JSON.stringify(cliModule)});\n`,
);
