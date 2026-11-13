import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  link,
  mkdir,
  opendir,
  readFile,
  realpath,
  rename,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseDocument } from "yaml";
import { parseDefinition, readDefinition } from "./definition.js";
import { automationDirectoryId, automationFileId, workflowId } from "../shared/contracts.js";
import { parseAutomationConfiguration } from "./configuration.js";
import { initialAutomationConfiguration } from "../shared/configuration-template.js";

// Adapted from RoboPlane's Mixer plugin workflow store. Keep workflow paths relative
// to the host-owned directory and reject symlinks when opening a workflow.
const MAX_WORKFLOWS = 500;
const MAX_ENTRIES = 5000;

export interface WorkflowStoreValidation {
  validate(path: string, content: string): Promise<void>;
  describe(
    root: string,
    path: string,
  ): Promise<{
    name: string;
    disabled: boolean;
    cron?: string;
    repository?: string | readonly string[];
    on: Record<string, unknown>;
  }>;
}
export function createWorkflowStore(home: string, validation?: WorkflowStoreValidation) {
  const directory = resolve(home, "automations");
  let mutation = Promise.resolve();
  function serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = mutation.then(operation);
    mutation = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
  async function initialize() {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    if (!(await lstat(directory)).isDirectory()) throw new Error("Invalid Automations directory.");
    return realpath(directory);
  }

  async function validate(id: string) {
    const path = automationFileId.parse(id);
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
    const directories: string[] = [];
    let visited = 0;
    while (pending.length) {
      const parent = pending.pop()!;
      for await (const entry of await opendir(join(root, parent))) {
        const path = parent ? `${parent}/${entry.name}` : entry.name;
        if (++visited > MAX_ENTRIES || workflows.length >= MAX_WORKFLOWS)
          return {
            workflows: workflows.sort((a, b) => a.path.localeCompare(b.path)),
            directories: directories.sort(),
            limited: true,
          };
        if (entry.isDirectory() && automationDirectoryId.safeParse(path).success) {
          directories.push(path);
          pending.push(path);
        } else if (entry.isFile() && workflowId.safeParse(path).success)
          workflows.push({ path, kind: /\.md$/i.test(path) ? "agent" : "steps" });
      }
    }
    return {
      workflows: workflows.sort((a, b) => a.path.localeCompare(b.path)),
      directories: directories.sort(),
      limited: false,
    };
  }

  async function describe() {
    const result = await list();
    const workflows = [];
    for (const { path, kind } of result.workflows) {
      try {
        const file = await validate(path);
        const config = validation
          ? await validation.describe(file.root, file.path)
          : await readDefinition(file.root, file.path);
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
    const configuration = await hasConfiguration();
    return { ...result, workflows, configuration };
  }

  async function hasConfiguration() {
    return lstat(join(await initialize(), "config.json"))
      .then(() => true)
      .catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return false;
        throw error;
      });
  }

  async function create(id: string) {
    const root = await initialize();
    const path = automationFileId.parse(id);
    const parts = path.split("/");
    const filename = parts.pop()!;
    let parent = root;
    for (const part of parts) {
      parent = join(parent, part);
      await mkdir(parent, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "EEXIST") throw error;
      });
      if (!(await lstat(parent)).isDirectory() || (await realpath(parent)) !== parent)
        throw new Error("Workflow folders must be directories, not symbolic links.");
    }
    const file = join(root, path);
    const name = filename.replace(/\.[^.]+$/, "");
    const header = `name: ${JSON.stringify(name)}\ndisabled: true\non: {}\n`;
    let content = `${header}steps:\n  - name: Example\n    run: echo "Hello from Mixer"\n`;
    if (/\.md$/i.test(path))
      content = `---\n${header}---\n\nDescribe what the automation should do.\n`;
    if (path === "config.json") content = initialAutomationConfiguration;
    await writeFile(file, content, {
      flag: "wx",
      mode: 0o600,
    }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "EEXIST") throw new Error(`A workflow already exists at ${path}.`);
      throw error;
    });
    return { root, path };
  }

  async function createDirectory(id: string) {
    const path = automationDirectoryId.parse(id);
    const root = await initialize();
    const parts = path.split("/");
    let parent = root;
    for (const [index, part] of parts.entries()) {
      parent = join(parent, part);
      await mkdir(parent, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "EEXIST") throw error;
        if (index === parts.length - 1)
          throw new Error(`A file or folder already exists at ${path}.`);
      });
      if (!(await lstat(parent)).isDirectory() || (await realpath(parent)) !== parent)
        throw new Error("Workflow folders cannot be symbolic links.");
    }
    return { path };
  }

  async function read(id: string) {
    const { root, path } = await validate(id);
    const content = await readFile(join(root, path), "utf8");
    return { path, content, version: createHash("sha256").update(content).digest("hex") };
  }

  async function current(path: string, version: string) {
    const source = await read(path);
    if (source.version !== version)
      throw new Error(
        "This workflow changed on disk. Reload it before saving or deleting. Your draft has not been saved.",
      );
    return source;
  }

  async function write(path: string, content: string) {
    if (Buffer.byteLength(content) > 1024 * 1024) throw new Error("Workflow exceeds 1 MiB.");
    if (validation) await validation.validate(path, content);
    else if (path === "config.json") parseAutomationConfiguration(content);
    else parseDefinition(path, content);
    const root = await initialize();
    const temporary = join(root, `.${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, content, { flag: "wx", mode: 0o600 });
      await validate(path);
      await rename(temporary, join(root, path));
    } finally {
      await rm(temporary, { force: true });
    }
    return read(path);
  }

  function save(input: { path: string; content: string; version: string }) {
    return serialize(async () => {
      await current(input.path, input.version);
      return write(input.path, input.content);
    });
  }

  function remove(input: { path: string; version: string }) {
    return serialize(async () => {
      await current(input.path, input.version);
      const { root, path } = await validate(input.path);
      await unlink(join(root, path));
      return { path };
    });
  }

  function move(input: { path: string; destination: string; version: string }) {
    return serialize(async () => {
      const path = workflowId.parse(input.path);
      const destination = workflowId.parse(input.destination);
      await current(path, input.version);
      const { root } = await validate(path);
      if (path === destination) return read(path);
      // The drop target must already exist and stay inside the real workflow root.
      const parent = join(root, ...destination.split("/").slice(0, -1));
      if ((await realpath(parent)) !== parent || !(await lstat(parent)).isDirectory())
        throw new Error("Workflow folders cannot be symbolic links.");
      // An exclusive link refuses collisions. rename() would replace an existing workflow.
      const target = join(root, destination);
      await link(join(root, path), target).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "EEXIST")
          throw new Error(`A file or folder already exists at ${destination}.`);
        throw error;
      });
      try {
        await unlink(join(root, path));
      } catch (error) {
        await unlink(target);
        throw error;
      }
      return read(destination);
    });
  }

  function setEnabled(input: { path: string; version: string; enabled: boolean }) {
    return serialize(async () => {
      const source = await current(input.path, input.version);
      const markdown = /\.md$/i.test(input.path);
      const frontmatter = /^---[ \t]*\r?\n([\s\S]*?)^---[ \t]*(?:\r?\n|$)/m.exec(source.content);
      if (validation) await validation.validate(input.path, source.content);
      else parseDefinition(input.path, source.content);
      const yaml = markdown ? (frontmatter?.[1] ?? "{}") : source.content;
      const document = parseDocument(yaml);
      if (document.errors.length) throw new Error(document.errors[0].message);
      document.set("disabled", !input.enabled);
      const body = frontmatter ? source.content.slice(frontmatter[0].length) : source.content;
      const content = markdown ? `---\n${document.toString()}---\n${body}` : document.toString();
      return write(input.path, content);
    });
  }

  return {
    initialize,
    validate,
    list,
    describe,
    create,
    read,
    save,
    remove,
    move,
    setEnabled,
    hasConfiguration,
    createDirectory,
  };
}
