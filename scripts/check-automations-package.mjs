import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temporary = await mkdtemp(join(os.tmpdir(), "mixer-engine-package-"));
try {
  const [packed] = JSON.parse(
    execFileSync(
      process.platform === "win32" ? "npm.cmd" : "npm",
      [
        "pack",
        "--workspace=@mixer/server",
        "--ignore-scripts",
        "--json",
        "--pack-destination",
        temporary,
      ],
      { cwd: root, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
    ),
  );
  const prefix = "node_modules/@mixer/automations-engine/";
  const files = new Set(packed.files.map((file) => file.path));
  for (const file of [
    "dist/index.js",
    "dist/embedded-cli.js",
    "dist/sdk/dist/index.js",
    "dist/sdk/dist/index.d.ts",
    "dist/docs/extension-authoring.md",
    "dist/docs/sdk.md",
    "dist/docs/workspaces.md",
    "provenance.json",
  ])
    assert.ok(files.has(prefix + file), `Server package is missing ${file}`);
  assert.ok(
    packed.bundled.includes("@mixer/automations-engine"),
    "The private engine must be bundled, not fetched from a registry",
  );
  assert.ok(
    !packed.files.some((file) => file.path.includes("better-sqlite3")),
    "Desktop packaging must not depend on a foreign SQLite native ABI",
  );
  const unpacked = join(temporary, "unpacked");
  await mkdir(unpacked);
  execFileSync("tar", ["-xf", join(temporary, packed.filename), "-C", unpacked]);
  const entry = join(unpacked, "package", prefix, "dist/index.js");
  const source = `
    import assert from "node:assert/strict";
    import { execFileSync } from "node:child_process";
    import { mkdir, writeFile, readFile, readdir } from "node:fs/promises";
    import { join } from "node:path";
    import { pathToFileURL } from "node:url";
    const { createEmbeddedEngine, startEmbeddedControl, embeddedAuthoringResources } = await import(pathToFileURL(process.argv[1]).href);
    const home = process.argv[2];
    const resources = embeddedAuthoringResources();
    assert.match(await readFile(join(resources.docs, "extension-authoring.md"), "utf8"), /api.workflows.registerField/);
    assert.match(await readFile(join(resources.sdk, "dist/index.d.ts"), "utf8"), /defineExtension/);
    assert.equal(JSON.parse(await readFile(join(resources.sdk, "package.json"), "utf8")).name, "@mixer/automations-sdk");
    const executionDocs = await readFile(join(resources.docs, "agents.md"), "utf8");
    assert.match(executionDocs, /MIXER_AUTOMATIONS_RESULT/);
    assert.doesNotMatch(executionDocs, /ROBOPLANE_/);
    const validationHome = home + "-authoring";
    await mkdir(join(validationHome, "automations"), { recursive: true });
    await mkdir(join(validationHome, ".mixer-automations/extensions/example"), { recursive: true });
    const dependency = join(validationHome, ".mixer-automations/extensions/example/node_modules/authoring-fixture");
    await mkdir(dependency, { recursive: true });
    await writeFile(join(dependency, "package.json"), JSON.stringify({ name: "authoring-fixture", type: "module", exports: "./index.js" }));
    await writeFile(join(dependency, "index.js"), 'export const team = "ENG";');
    await writeFile(join(validationHome, "automations/config.json"), JSON.stringify({ extensions: { github:{enabled:false}, jira:{enabled:false}, scheduler:{enabled:false}, webhooks:{enabled:false} } }));
    await writeFile(join(validationHome, ".mixer-automations/extensions/example/index.ts"), 'import { defineExtension, z } from "@mixer/automations-sdk"; import { team } from "authoring-fixture"; export default defineExtension({ name: "example", setup(api) { api.workflows.registerField("example.context", { schema: z.object({ team: z.literal(team) }).strict() }); api.events.registerSource("example.issue", { configSchema: z.object({ team: z.string() }).strict(), match(event, config) { return event.data.team === config.team; }, async start() {} }); } });');
    await writeFile(join(validationHome, "automations/example.yaml"), 'on:\\n  example.issue:\\n    team: ENG\\nexample.context:\\n  team: ENG\\nsteps:\\n  - run: echo AUTHORING_FIXTURE\\n');
    const cliOptions = { encoding: "utf8", env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, timeout: 30000 };
    const validate = (...args) => execFileSync(process.execPath, [resources.cli, "--home", validationHome, ...args], cliOptions);
    validate("automations", "validate", "--json");
    assert.match(validate("extensions", "validate", "example"), /Extension 'example' is valid/);
    await writeFile(join(validationHome, "automations/example.yaml"), 'on: {}\\nexample.context:\\n  team: 42\\nsteps:\\n  - run: echo INVALID\\n');
    assert.throws(() => validate("automations", "validate"));
    await mkdir(join(home, "automations"), { recursive: true });
    await writeFile(join(home, "automations/config.json"), JSON.stringify({ runtime: { shutdownTimeout: 100 }, extensions: { github:{enabled:false}, jira:{enabled:false}, scheduler:{enabled:false}, webhooks:{enabled:false} } }));
    await writeFile(join(home, "automations/parent.yaml"), 'on: {}\\nsteps:\\n  - run: |\\n      test -n "$MIXER_AUTOMATIONS_RUN_ID"\\n      test -n "$MIXER_AUTOMATIONS_SUBMISSION_TOKEN"\\n      test -f "$MIXER_AUTOMATIONS_EVENT_FILE"\\n      test -d "$MIXER_AUTOMATIONS_WORKSPACE"\\n      mixer-automations automations run child.yaml --json --handoff-key child\\n');
    await writeFile(join(home, "automations/child.yaml"), "on: {}\\nsteps:\\n  - run: echo PACKAGED_ENGINE_OK\\n");
    const engine = createEmbeddedEngine(home);
    let control;
    try {
      await engine.initialize();
      assert.deepEqual(engine.extensions.filter(extension => extension.error), []);
      await writeFile(join(engine.paths.state, "roboplane.pid"), String(process.pid), { mode: 0o600 });
      control = await startEmbeddedControl(engine);
      await engine.start();
      await engine.submitRun("parent.yaml");
      await engine.idle();
      const runs = engine.database.listRuns();
      assert.equal(runs.length, 2);
      assert.ok(runs.every(run => run.status === "completed"));
      const child = runs.find(run => run.workflowId === "child.yaml");
      assert.ok(child);
      assert.match(await readFile(join(engine.paths.logs, child.id + ".log"), "utf8"), /PACKAGED_ENGINE_OK/);
       assert.deepEqual(await readdir(engine.paths.workspaces), []);
       engine.registry.setOwner("namespace-check");
       engine.registry.agents.register("namespace-check", {
         async run(context) {
           assert.match(context.prompt, /MIXER_AUTOMATIONS_RESULT:/);
           assert.doesNotMatch(context.prompt, /ROBOPLANE_/);
           return { output: 'MIXER_AUTOMATIONS_RESULT: {"version":1,"outcome":"no-op","reason":"NAMESPACED_RESULT_OK","actions":[]}' };
         },
       });
       await writeFile(join(home, "automations/report.md"), '---\\non: {}\\nagent: namespace-check\\n---\\nVerify the result protocol.\\n');
       engine.reloadWorkflows();
       const report = await engine.submitRun("report.md");
       await engine.idle();
       assert.equal(engine.database.getRun(report.id).outcome.reason, "NAMESPACED_RESULT_OK");
       console.log("Packaged engine: extension authoring, frontmatter rejection, parent/child execution, bundled CLI, SQLite, SDK, and cleanup verified outside the checkout.");
    } finally {
      if (control) await new Promise(resolve => control.close(resolve));
      await engine.stop();
    }
  `;
  const output = execFileSync(
    process.execPath,
    ["--input-type=module", "-e", source, entry, join(temporary, "home")],
    { cwd: temporary, env: { ...process.env, NODE_PATH: "" }, encoding: "utf8", timeout: 30_000 },
  );
  process.stdout.write(output);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
