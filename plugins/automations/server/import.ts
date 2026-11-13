import { lstat, mkdir, open, opendir, readFile, realpath, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { dirname, isAbsolute, join } from "node:path";
import { parseDocument } from "yaml";
import { z } from "zod";
import { runSchema, workflowId } from "../shared/contracts.js";
import { readRunResult } from "../shared/run-inspection.js";

const MAX_BYTES = 1024 * 1024;
const logsLimit = 128 * 1024;
const rowSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_-]{1,200}$/),
  workflow_id: z.string(),
  repository: z.string().nullable(),
  status: z.string(),
  error: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
  outcome_json: z.string().nullable(),
});

async function regularFile(file: string, limit = Infinity) {
  const stat = await lstat(file).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  return !!stat?.isFile() && stat.size <= limit && (await realpath(file)) === file;
}

function disableWorkflow(text: string, file: string) {
  const markdown = /\.md$/i.test(file);
  const frontmatter = /^---[ \t]*\r?\n([\s\S]*?)^---[ \t]*(?:\r?\n|$)/m.exec(text);
  if (markdown && frontmatter?.index) throw new Error("Invalid frontmatter");
  const config = parseDocument(markdown ? (frontmatter?.[1] ?? "{}") : text, { uniqueKeys: true });
  if (config.errors.length) throw config.errors[0];
  config.set("disabled", true);
  if (markdown) return `---\n${config.toString()}---\n${text.slice(frontmatter?.[0].length ?? 0)}`;
  return config.toString();
}

async function ensureParents(destination: string, relative: string) {
  let parent = destination;
  for (const component of relative.split("/").slice(0, -1)) {
    parent = join(parent, component);
    await mkdir(parent, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
    });
    if ((await realpath(parent)) !== parent || !(await lstat(parent)).isDirectory())
      throw new Error("Invalid destination directory");
  }
}

async function copyWorkflows(source: string, destination: string, result: Result) {
  if ((await realpath(source).catch(() => null)) !== source) return;
  const pending = [""];
  let visited = 0;
  while (pending.length) {
    const directory = pending.pop()!;
    for await (const entry of await opendir(join(source, directory))) {
      if (++visited > 5_000) throw new Error("RoboPlane workflow directory exceeds 5,000 entries.");
      const relative = directory ? `${directory}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        pending.push(relative);
        continue;
      }
      if (!entry.isFile() || !workflowId.safeParse(relative).success) continue;
      const from = join(source, relative);
      const to = join(destination, relative);
      try {
        if (!(await regularFile(from, MAX_BYTES))) throw new Error("Invalid source file");
        // Resolve each existing parent before descending; never traverse an imported symlink.
        await ensureParents(destination, relative);
        await writeFile(to, disableWorkflow(await readFile(from, "utf8"), relative), {
          flag: "wx",
          mode: 0o600,
        });
        result.workflows++;
      } catch {
        result.skipped++;
      }
    }
  }
}

type Run = z.output<typeof runSchema>;
interface Result {
  workflows: number;
  runs: number;
  skipped: number;
}

export async function readLog(file: string) {
  if (!(await regularFile(file))) return "";
  const handle = await open(file, "r");
  try {
    const { size } = await handle.stat();
    const buffer = Buffer.alloc(Math.min(size, logsLimit));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, size - buffer.length);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}

export async function importRoboPlane(
  home: string,
  destination: string,
  writeRun: (run: Run) => Promise<boolean>,
  idFor: (key: string) => string,
) {
  if (!isAbsolute(home))
    throw new Error("Enter an absolute path to the RoboPlane home on this host.");
  const root = await realpath(home);
  const internal = join(root, ".roboplane");
  const database = [join(internal, "state", "roboplane.db"), join(root, "state", "roboplane.db")];
  let dbPath: string | undefined;
  for (const file of database) {
    if (await regularFile(file)) {
      dbPath = file;
      break;
    }
  }
  const source = join(root, "automations");
  if (!dbPath && !(await lstat(source).catch(() => null))?.isDirectory())
    throw new Error("No RoboPlane workflows or history were found in this folder.");
  const result: Result = { workflows: 0, runs: 0, skipped: 0 };
  if (dbPath) {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const columns = db.prepare("PRAGMA table_info(runs)").all();
      const outcomeColumn = columns.some(({ name }) => name === "outcome_json")
        ? "outcome_json"
        : "NULL AS outcome_json";
      const query = db.prepare(
        `SELECT id, workflow_id, repository, status, error, created_at, updated_at, ${outcomeColumn} FROM runs ORDER BY created_at DESC`,
      );
      for (const data of query.iterate()) {
        const parsed = rowSchema.safeParse(data);
        if (!parsed.success) {
          result.skipped++;
          continue;
        }
        const row = parsed.data;
        const createdAt = Date.parse(row.created_at);
        const finishedAt = Date.parse(row.updated_at);
        if (!Number.isFinite(createdAt) || !Number.isFinite(finishedAt)) {
          result.skipped++;
          continue;
        }
        const path = workflowId.safeParse(row.workflow_id);
        const sourcePath = path.success ? path.data : `${row.workflow_id}.md`;
        const status = importedStatus(row.status);
        const recordedResult = readRunResult(row.outcome_json);
        const run = runSchema.safeParse({
          id: idFor(`roboplane:${row.id}`),
          path: sourcePath,
          name: row.workflow_id,
          repository: row.repository ?? undefined,
          trigger: "imported",
          importedId: row.id,
          importedAt: Date.now(),
          status,
          sourceStatus: row.status,
          outcome: recordedResult?.outcome,
          result: recordedResult,
          error: row.error ?? undefined,
          createdAt,
          finishedAt,
          output: await readLog(join(dirname(dirname(dbPath)), "logs", `${row.id}.log`)),
        });
        if (run.success && (await writeRun(run.data))) result.runs++;
        else result.skipped++;
      }
    } finally {
      db.close();
    }
  }
  await copyWorkflows(source, destination, result);
  return result;
}

function importedStatus(status: string): Run["status"] {
  if (status === "completed" || status === "succeeded") return "succeeded";
  if (status === "failed") return "failed";
  return "interrupted";
}
