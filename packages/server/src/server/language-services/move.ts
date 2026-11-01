import path from "node:path";
import { lstat, link, unlink, realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { getExplorerFileVersion } from "../file-explorer/service.js";

const moveFile = z.object({ oldUri: z.string(), newUri: z.string(), expectedRevision: z.string() });
const missingFile = z.object({ code: z.literal("ENOENT") });

export async function moveWorkspaceFile(root: string, params: unknown) {
  const input = moveFile.parse(params);
  const source = fileURLToPath(input.oldUri);
  const target = fileURLToPath(input.newUri);
  for (const filename of [source, target]) {
    const parent = await realpath(path.dirname(filename));
    const relative = path.relative(root, path.join(parent, path.basename(filename)));
    if (
      !relative ||
      relative === ".." ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    )
      throw new Error("Move is outside the workspace");
  }
  const before = await lstat(source, { bigint: true });
  if (!before.isFile()) throw new Error("Only regular files can be moved through the editor");
  const version = await getExplorerFileVersion({ root, relativePath: path.relative(root, source) });
  if (version.status !== "ready" || version.revision !== input.expectedRevision)
    throw new Error("The source file changed. Request the move again.");
  // link fails atomically if the destination exists. rename() would overwrite it on Unix.
  await link(source, target);
  try {
    const current = await lstat(source, { bigint: true });
    if (
      current.ino !== before.ino ||
      current.dev !== before.dev ||
      current.mtimeNs !== before.mtimeNs ||
      current.size !== before.size
    )
      throw new Error("The source file changed while moving it");
    await unlink(source);
  } catch (error) {
    try {
      const linked = await lstat(target, { bigint: true });
      if (linked.ino === before.ino && linked.dev === before.dev) await unlink(target);
    } catch (cleanupError) {
      if (!missingFile.safeParse(cleanupError).success) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(
          `The move failed (${detail}) and its temporary destination could not be removed`,
          { cause: cleanupError },
        );
      }
    }
    throw error;
  }
  const moved = await getExplorerFileVersion({ root, relativePath: path.relative(root, target) });
  if (moved.status !== "ready")
    throw new Error(
      "The file moved, but its new version could not be read. Reopen the destination file.",
    );
  return moved;
}
