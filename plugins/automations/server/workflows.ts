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
interface WorkflowContentUpdate {
  path: string;
  content: string;
  disabled: boolean;
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

  function create(id: string) {
    return serialize(async () => {
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
    });
  }

  function createDirectory(id: string) {
    return serialize(async () => {
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
    });
  }

  async function read(id: string) {
    const { root, path } = await validate(id);
    const content = await readFile(join(root, path), "utf8");
    return { path, content, version: createHash("sha256").update(content).digest("hex") };
  }

  async function validateDirectory(id: string) {
    const path = automationDirectoryId.parse(id);
    const root = await initialize();
    const absolute = join(root, path);
    if ((await realpath(absolute)) !== absolute || !(await lstat(absolute)).isDirectory())
      throw new Error("Workflow folders must be directories, not symbolic links.");
    return { root, path, absolute };
  }

  async function readDirectory(id: string) {
    const { path, absolute } = await validateDirectory(id);
    const pending = [""];
    const entries: string[] = [];
    while (pending.length) {
      const relative = pending.pop()!;
      const target = join(absolute, relative);
      const stat = await lstat(target, { bigint: true });
      if (!stat.isDirectory() && !stat.isFile())
        throw new Error("Workflow folders cannot contain symbolic links or special files.");
      entries.push(
        JSON.stringify([
          relative,
          stat.mode.toString(),
          stat.ino.toString(),
          stat.size.toString(),
          stat.mtimeNs.toString(),
          stat.ctimeNs.toString(),
        ]),
      );
      if (entries.length > MAX_ENTRIES) throw new Error("Workflow folder exceeds the entry limit.");
      if (stat.isDirectory()) {
        for await (const entry of await opendir(target)) pending.push(join(relative, entry.name));
      }
    }
    entries.sort();
    return { path, version: createHash("sha256").update(JSON.stringify(entries)).digest("hex") };
  }

  async function currentDirectory(input: { path: string; version: string }) {
    const snapshot = await readDirectory(input.path);
    if (snapshot.version !== input.version)
      throw new Error("This folder changed on disk. Try again to review its current contents.");
    return validateDirectory(input.path);
  }

  function moveDirectory(input: { path: string; destination: string; version: string }) {
    return serialize(async () => {
      const destination = automationDirectoryId.parse(input.destination);
      const source = await currentDirectory(input);
      if (destination === source.path) return readDirectory(source.path);
      if (destination.startsWith(`${source.path}/`))
        throw new Error("A folder cannot be moved inside itself.");
      const parent = join(source.root, ...destination.split("/").slice(0, -1));
      if ((await realpath(parent)) !== parent || !(await lstat(parent)).isDirectory())
        throw new Error("Workflow folders cannot be symbolic links.");
      const target = join(source.root, destination);
      const existing = await lstat(target).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      if (existing) throw new Error(`A file or folder already exists at ${destination}.`);
      await rename(source.absolute, target);
      return readDirectory(destination);
    });
  }

  function removeDirectory(input: { path: string; version: string }) {
    return serialize(async () => {
      const source = await currentDirectory(input);
      await rm(source.absolute, { recursive: true });
      return { path: source.path };
    });
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
      if (validation) await validation.validate(input.path, source.content);
      else parseDefinition(input.path, source.content);
      return write(
        input.path,
        withDisabled({ path: input.path, content: source.content, disabled: !input.enabled }),
      );
    });
  }

  function duplicate(input: { path: string; destination: string; version: string }) {
    return serialize(async () => {
      const path = workflowId.parse(input.path);
      const destination = workflowId.parse(input.destination);
      if (/\.md$/i.test(path) !== /\.md$/i.test(destination))
        throw new Error("Keep the workflow format when duplicating a file.");
      const source = await current(path, input.version);
      const content = withDisabled({ path, content: source.content, disabled: true });
      if (validation) await validation.validate(destination, content);
      else parseDefinition(destination, content);
      const { root } = await validate(path);
      const parent = join(root, ...destination.split("/").slice(0, -1));
      if ((await realpath(parent)) !== parent || !(await lstat(parent)).isDirectory())
        throw new Error("Workflow folders cannot be symbolic links.");
      await writeFile(join(root, destination), content, { flag: "wx", mode: 0o600 }).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code === "EEXIST")
            throw new Error(`A file or folder already exists at ${destination}.`);
          throw error;
        },
      );
      return read(destination);
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
    readDirectory,
    moveDirectory,
    removeDirectory,
    duplicate,
  };
}

function withDisabled({ path, content, disabled }: WorkflowContentUpdate) {
  const markdown = /\.md$/i.test(path);
  const frontmatter = /^---[ \t]*\r?\n([\s\S]*?)^---[ \t]*(?:\r?\n|$)/m.exec(content);
  const document = parseDocument(markdown ? (frontmatter?.[1] ?? "{}") : content);
  if (document.errors.length) throw new Error(document.errors[0].message);
  document.set("disabled", disabled);
  const body = frontmatter ? content.slice(frontmatter[0].length) : content;
  return markdown ? `---\n${document.toString()}---\n${body}` : document.toString();
}
