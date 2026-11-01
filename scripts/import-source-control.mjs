import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";

const source = process.argv[2];
if (!source)
  throw new Error("Usage: node scripts/import-source-control.mjs /path/to/source-control");
const destination = new URL("../plugins/source-control/", import.meta.url);
if (await stat(destination).catch(() => null))
  throw new Error(
    "Source Control already exists; edit the owned implementation instead of reimporting it.",
  );

async function copy(relative) {
  const path = resolve(source, relative);
  if ((await stat(path)).isDirectory()) {
    for (const name of await readdir(path)) await copy(`${relative}/${name}`);
    return;
  }
  let contents = await readFile(path, "utf8");
  if (/\.tsx?$/.test(relative)) {
    contents = contents.replace(
      /(from\s+["'])(\.{1,2}\/[^"']+)(["'])/g,
      (match, prefix, specifier, suffix) =>
        /\.(js|json)$/.test(specifier) ? match : `${prefix}${specifier}.js${suffix}`,
    );
    contents = contents.replace('from "node:test"', 'from "vitest"');
  }
  const target = new URL(relative, destination);
  await mkdir(dirname(target.pathname), { recursive: true });
  await writeFile(target, contents);
}
for (const name of [
  "index.client.tsx",
  "index.server.ts",
  "mixer-plugin.json",
  "client",
  "server",
  "shared",
  "tests",
  "scripts",
  "OVERVIEW.md",
  "THIRD_PARTY_NOTICES.md",
  "MIXER-LICENSE",
])
  await copy(name);
