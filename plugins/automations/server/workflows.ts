import { lstat, mkdir, opendir, realpath, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { readDefinition } from "./definition.js";
import { workflowId } from "../shared/contracts.js";

// Adapted from RoboPlane's Mixer plugin workflow store. Keep workflow paths relative
// to the host-owned directory and reject symlinks when opening a workflow.
const MAX_WORKFLOWS = 500;
const MAX_ENTRIES = 5000;

export function createWorkflowStore(home: string) {
  const directory = resolve(home, "automations");
  async function initialize() {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    if (!(await lstat(directory)).isDirectory()) throw new Error("Invalid Automations directory.");
    return realpath(directory);
  }

  async function validate(id: string) {
    const path = workflowId.parse(id);
    const root = await initialize();
    const file = join(root, path);
    if ((await realpath(file)) !== file)
      throw new Error("Symlinked workflow paths are unsupported.");
    const stat = await lstat(file);
    if (!stat.isFile() || stat.size > 1024 * 1024)
      throw new Error("Workflows must be regular files no larger than 1 MiB.");
    return { root, path };
  }

  async function list() {
    const root = await initialize();
    const pending = [""];
    const workflows: { path: string; kind: "agent" | "steps" }[] = [];
    let visited = 0;
    while (pending.length) {
      const parent = pending.pop()!;
      for await (const entry of await opendir(join(root, parent))) {
        const path = parent ? `${parent}/${entry.name}` : entry.name;
        if (++visited > MAX_ENTRIES || workflows.length >= MAX_WORKFLOWS)
          return {
            workflows: workflows.sort((a, b) => a.path.localeCompare(b.path)),
            limited: true,
          };
        if (entry.isDirectory()) pending.push(path);
        else if (entry.isFile() && workflowId.safeParse(path).success)
          workflows.push({ path, kind: /\.md$/i.test(path) ? "agent" : "steps" });
      }
    }
    return { workflows: workflows.sort((a, b) => a.path.localeCompare(b.path)), limited: false };
  }

  async function describe() {
    const result = await list();
    const workflows = [];
    for (const { path, kind } of result.workflows) {
      try {
        const file = await validate(path);
        const config = await readDefinition(file.root, file.path);
        workflows.push({
          path,
          kind,
          name: config.name,
          disabled: config.disabled,
          cron: config.cron,
          repositories: [config.repository ?? []].flat(),
          triggers: Object.keys(config.on),
        });
      } catch (error) {
        workflows.push({
          path,
          kind,
          name: path,
          disabled: true,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return { ...result, workflows };
  }

  async function create(name: string, kind: "agent" | "steps" = "agent") {
    const root = await initialize();
    const path = workflowId.parse(`${name}.${kind === "agent" ? "md" : "yaml"}`);
    const file = join(root, path);
    if (dirname(file) !== root) throw new Error("Invalid workflow name.");
    const header = `name: ${JSON.stringify(name)}\ndisabled: true\non: {}\n`;
    const content =
      kind === "agent"
        ? `---\n${header}---\n\nDescribe what the automation should do.\n`
        : `${header}steps:\n  - name: Example\n    run: echo "Hello from Mixer"\n`;
    await writeFile(file, content, {
      flag: "wx",
      mode: 0o600,
    });
    return { root, path };
  }

  return { initialize, validate, list, describe, create };
}
