import {
  cp,
  lstat,
  mkdir,
  readFile,
  realpath,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const source = fileURLToPath(
  new URL("../../../plugins/automations/server/engine", import.meta.url),
);
const destination = fileURLToPath(
  new URL("../node_modules/@mixer/automations-engine", import.meta.url),
);
const top = join(destination, "node_modules");
const manifest = JSON.parse(await readFile(join(source, "package.json"), "utf8"));
// This private workspace is shipped inside the server tarball, never fetched from a registry.
const existing = await lstat(destination).catch((error) => {
  if (error.code === "ENOENT") return null;
  throw error;
});
if (existing?.isSymbolicLink()) await unlink(destination);
await mkdir(destination, { recursive: true });
for (const entry of ["dist", "provenance.json"]) {
  await rm(join(destination, entry), { recursive: true, force: true });
  await cp(join(source, entry), join(destination, entry), { recursive: true });
}
await writeFile(join(destination, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
await rm(top, { recursive: true, force: true });

function dependencyDirectory(name, require) {
  const directory = require.resolve
    .paths(name)
    ?.map((parent) => join(parent, name))
    .find((candidate) => existsSync(join(candidate, "package.json")));
  if (!directory) throw new Error(`Could not locate engine dependency ${name}`);
  return directory;
}
const resolvedTop = new Map();
const copied = new Set();
const pending = [{ source, destination, manifest }];
while (pending.length) {
  const owner = pending.shift();
  const require = createRequire(join(owner.source, "package.json"));
  const dependencies = { ...owner.manifest.dependencies, ...owner.manifest.optionalDependencies };
  for (const name of Object.keys(dependencies).sort()) {
    let dependency;
    try {
      // Optional platform binaries may have no default export.
      try {
        dependency = dirname(require.resolve(`${name}/package.json`));
      } catch {
        dependency = dependencyDirectory(name, require);
      }
      dependency = await realpath(dependency);
    } catch (error) {
      if (owner.manifest.optionalDependencies?.[name]) continue;
      throw error;
    }
    const first = resolvedTop.get(name);
    const target =
      !first || first === dependency
        ? join(top, name)
        : join(owner.destination, "node_modules", name);
    if (!first) resolvedTop.set(name, dependency);
    const key = `${dependency}\0${target}`;
    if (copied.has(key)) continue;
    copied.add(key);
    await mkdir(dirname(target), { recursive: true });
    await rm(target, { recursive: true, force: true });
    await cp(dependency, target, {
      recursive: true,
      filter: (file) => !file.slice(dependency.length).split(/[\\/]/).includes("node_modules"),
    });
    const child = JSON.parse(await readFile(join(target, "package.json"), "utf8"));
    pending.push({ source: dependency, destination: target, manifest: child });
  }
}
if (!(await stat(join(destination, "dist/index.js"))).isFile())
  throw new Error("The packaged engine entry point is missing.");
console.log(`Bundled Mixer Automations engine and ${copied.size} runtime dependency packages.`);
