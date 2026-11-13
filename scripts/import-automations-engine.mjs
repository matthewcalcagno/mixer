import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { namespaceAutomationEngine } from "./automations-engine-namespace.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const destination = join(root, "plugins/automations/server/engine/upstream");
const manifestFile = join(destination, "../provenance.json");
const revision = "804ad41a301e6674cc7f4e72093adaed8f58e293";
const hash = (content) => createHash("sha256").update(content).digest("hex");
const previous = existsSync(manifestFile) ? JSON.parse(readFileSync(manifestFile, "utf8")) : null;

if (process.argv.includes("--verify")) {
  if (!previous) throw new Error("Import the engine before verifying it.");
  if (previous.revision !== revision)
    throw new Error("The imported engine revision does not match the pinned source.");
  for (const [file, entry] of Object.entries(previous.files)) {
    const content = readFileSync(join(destination, file));
    if (hash(content) !== entry.importedSha256)
      throw new Error(
        `Imported engine differs from its pinned source and recorded adaptations: ${file}`,
      );
    if (namespaceAutomationEngine(content.toString()) !== content.toString())
      throw new Error(`Imported engine has an unmigrated public namespace: ${file}`);
  }
  console.log(
    `Verified ${Object.keys(previous.files).length} engine files from ${previous.revision}.`,
  );
} else {
  const source = process.argv[2];
  if (!source)
    throw new Error(
      "Usage: node scripts/import-automations-engine.mjs <roboplane-checkout> | --verify",
    );
  const git = (...args) =>
    execFileSync("git", ["-C", source, ...args], { maxBuffer: 32 * 1024 * 1024 });
  const files = git("ls-tree", "-r", "--name-only", revision)
    .toString()
    .trim()
    .split("\n")
    .filter(
      (file) => !file.startsWith("mixer-plugin/") && file !== "AGENTS.md" && file !== ".gitignore",
    );
  const imported = {};
  for (const file of files) {
    const original = git("show", `${revision}:${file}`);
    let content = original;
    // Keep the upstream default intact for its tests; only the embedded engine uses Mixer storage.
    if (file === "packages/core/src/paths.ts") {
      const text = original.toString();
      const adapted = text
        .replace(
          'const internal = path.resolve(home, ".roboplane");',
          'const embedded = process.env.MIXER_AUTOMATIONS_EMBEDDED === "1";\n  const internal = path.resolve(home, embedded ? ".mixer-automations" : ".roboplane");',
        )
        .replace(
          'config: path.join(internal, "config.json"),',
          'config: embedded ? path.join(home, "automations", "config.json") : path.join(internal, "config.json"),',
        )
        .replace(
          'extensions: path.resolve(home, "extensions"),',
          'extensions: embedded ? path.join(internal, "extensions") : path.resolve(home, "extensions"),',
        );
      if (adapted === text) throw new Error("The upstream storage seam changed; review the port.");
      content = Buffer.from(adapted);
    }
    const target = join(destination, file);
    if (file === "packages/core/src/config.ts") {
      const text = original.toString();
      const adapted = text.replace(
        "const configSchema = z.object({",
        "export const configSchema = z.object({",
      );
      if (adapted === text) throw new Error("Review the upstream draft-configuration schema seam.");
      content = Buffer.from(adapted);
    }
    if (file === "packages/core/src/process.ts") {
      const text = original.toString();
      const adapted = text.replace(
        "const env: Record<string, string> = {};",
        'const env: Record<string, string> = {};\n    if (process.env.MIXER_AUTOMATIONS_EMBEDDED === "1" && process.versions.electron && !denied.has("ELECTRON_RUN_AS_NODE")) env.ELECTRON_RUN_AS_NODE = "1";',
      );
      if (adapted === text) throw new Error("Review the upstream Electron subprocess seam.");
      content = Buffer.from(adapted);
    }
    if (file === "packages/cli/src/index.ts") {
      const text = original.toString();
      const adapted = text.replace(
        "function controlPath(): string {",
        'function controlPath(): string {\n  if (process.env.MIXER_AUTOMATIONS_EMBEDDED === "1" && process.env.MIXER_AUTOMATIONS_CONTROL_SOCKET) return process.env.MIXER_AUTOMATIONS_CONTROL_SOCKET;',
      );
      if (adapted === text) throw new Error("Review the upstream control-socket seam.");
      content = Buffer.from(adapted);
    }
    if (file === "packages/core/src/extensions.ts") {
      const text = original.toString();
      const adapted = text
        .replace(
          'const sdkRoot = require.resolve.paths("@roboplane/sdk")',
          'const sdkRoot = process.env.MIXER_AUTOMATIONS_SDK_ROOT ?? require.resolve.paths("@roboplane/sdk")',
        )
        .replace(
          'packages: "external", tsconfig,',
          'packages: process.env.MIXER_AUTOMATIONS_EMBEDDED === "1" ? "bundle" : "external", tsconfig,',
        );
      if (adapted === text)
        throw new Error("The upstream SDK resolution seam changed; review the port.");
      content = Buffer.from(adapted);
    }
    if (existsSync(target) && hash(readFileSync(target)) !== previous?.files[file]?.importedSha256)
      throw new Error(`Refusing to overwrite an unrecorded engine change: ${file}`);
    mkdirSync(dirname(target), { recursive: true });
    content = Buffer.from(namespaceAutomationEngine(content.toString()));
    writeFileSync(target, content);
    imported[file] = { upstreamSha256: hash(original), importedSha256: hash(content) };
  }
  writeFileSync(
    manifestFile,
    `${JSON.stringify({ repository: "https://github.com/matthewcalcagno/roboplane", revision, branch: "main", adaptations: ["Mixer Automations protocol namespace, SDK package name, workflow CLI helper, and user-facing branding. Persisted storage names and source module identities other than the public SDK remain unchanged.", "Opt-in embedded storage paths, packaged SDK resolution and local extension dependency bundling, short private control socket, Electron Node subprocess flag, and draft-schema export."], files: imported }, null, 2)}\n`,
  );
  console.log(
    `Imported ${files.length} tracked engine, test, example, and documentation files from ${revision}.`,
  );
}
