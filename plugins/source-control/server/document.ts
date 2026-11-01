/// <reference types="node" />
import { createHash } from "node:crypto";
import { lstat, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { git, validatePaths } from "./git.js";

const limit = 1_000_000;
function revision(content: string) {
  return createHash("sha256").update(content).digest("hex");
}
function text(content: string) {
  if (content.includes("\0") || content.includes("\ufffd"))
    throw new Error("This editor supports UTF-8 text files only.");
  if (Buffer.byteLength(content) > limit) throw new Error("This editor supports files up to 1 MB.");
  return content;
}
async function workingFile(cwd: string, path: string) {
  validatePaths(cwd, [path]);
  // Refuse symlink traversal, including symlinked parent directories.
  const parts = path.split("/");
  for (let i = 1; i <= parts.length; i++) {
    const info = await lstat(resolve(cwd, parts.slice(0, i).join("/"))).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
      },
    );
    if (!info) return null;
    if (info.isSymbolicLink()) throw new Error("Symlink editing is not supported.");
    if (i === parts.length && (!info.isFile() || info.size > limit))
      throw new Error("Only text files up to 1 MB can be edited.");
  }
  return text(await readFile(resolve(cwd, path), "utf8"));
}
async function blob(cwd: string, path: string, source: "HEAD" | "") {
  const spec = `${source}:${path}`;
  const exists = await git(cwd, ["cat-file", "-e", spec]).then(
    () => true,
    () => false,
  );
  if (!exists) return "";
  const size = Number((await git(cwd, ["cat-file", "-s", spec])).trim());
  if (size > limit) throw new Error("This editor supports files up to 1 MB.");
  return text(await git(cwd, ["show", spec]));
}

export async function document(cwd: string, path: string, staged: boolean) {
  validatePaths(cwd, [path]);
  const original = await blob(cwd, path, staged ? "HEAD" : "");
  const working = staged ? null : await workingFile(cwd, path);
  const modified = staged ? await blob(cwd, path, "") : (working ?? "");
  return {
    original,
    modified,
    revision: revision(modified),
    editable: !staged && working !== null,
  };
}

export async function saveDocument(
  cwd: string,
  path: string,
  expectedRevision: string,
  content: string,
) {
  text(content);
  const current = await workingFile(cwd, path);
  if (current === null) throw new Error("The file was deleted. Reload before editing.");
  if (revision(current) !== expectedRevision)
    throw new Error(
      "The file changed on disk. Your draft is preserved. Reload and review before saving.",
    );
  await writeFile(resolve(cwd, path), content, "utf8");
  return { revision: revision(content) };
}
