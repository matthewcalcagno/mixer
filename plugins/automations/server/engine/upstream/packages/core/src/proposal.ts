import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

const MAX_PROPOSAL_BYTES = 10_000_000;

export const proposedFileSchema = z.object({
  path: z.string().min(1).max(4_096),
  operation: z.enum(["add", "update", "delete"]),
  content: z.string().max(2_000_000).optional(),
  mode: z.enum(["644", "755"]).default("644"),
}).strict().superRefine((file, context) => {
  if (file.operation === "delete" && file.content !== undefined) {
    context.addIssue({ code: "custom", path: ["content"], message: "Deleted files cannot contain content" });
  }
  if (file.operation !== "delete" && file.content === undefined) {
    context.addIssue({ code: "custom", path: ["content"], message: `${file.operation} files require UTF-8 content` });
  }
});

export const proposedFilesSchema = z.array(proposedFileSchema).max(100).default([]);
export type ProposedFile = z.infer<typeof proposedFileSchema>;

function safeRelative(value: string): string {
  if (path.isAbsolute(value) || value.includes("\\") || /[:\0-\x1f]/.test(value)) throw new Error(`proposal_path_invalid:${value}`);
  const parts = value.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) throw new Error(`proposal_path_invalid:${value}`);
  if (parts.some((part) => /[. ]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(part))) {
    throw new Error(`proposal_path_invalid:${value}`);
  }
  if (parts[0]!.toLowerCase() === ".git") throw new Error(`proposal_path_protected:${value}`);
  return parts.join("/");
}

function rejectSymlinkPath(root: string, relative: string): void {
  const parts = relative.split("/");
  let current = root;
  for (const part of parts) {
    current = path.join(current, part);
    if (!fs.existsSync(current)) return;
    if (fs.lstatSync(current).isSymbolicLink()) throw new Error(`proposal_symlink_path:${relative}`);
  }
}

export function applyFileProposal(rootPath: string, candidate: unknown): ProposedFile[] {
  const files = proposedFilesSchema.parse(candidate);
  const root = path.resolve(rootPath);
  const seen = new Set<string>();
  let bytes = 0;
  const normalized = files.map((file) => {
    const relative = safeRelative(file.path);
    if (seen.has(relative)) throw new Error(`proposal_path_duplicate:${relative}`);
    seen.add(relative);
    if (file.content !== undefined) {
      if (file.content.includes("\0")) throw new Error(`proposal_content_not_utf8_text:${relative}`);
      bytes += Buffer.byteLength(file.content, "utf8");
    }
    return { ...file, path: relative };
  });
  if (bytes > MAX_PROPOSAL_BYTES) throw new Error("proposal_size_limit_exceeded");

  const deletions = normalized.filter((file) => file.operation === "delete")
    .sort((a, b) => b.path.length - a.path.length || a.path.localeCompare(b.path));
  const writes = normalized.filter((file) => file.operation !== "delete")
    .sort((a, b) => a.path.localeCompare(b.path));

  for (const file of deletions) {
    rejectSymlinkPath(root, file.path);
    const target = path.join(root, ...file.path.split("/"));
    if (!fs.existsSync(target) || !fs.lstatSync(target).isFile()) throw new Error(`proposal_delete_target_invalid:${file.path}`);
    fs.unlinkSync(target);
  }
  for (const file of writes) {
    rejectSymlinkPath(root, file.path);
    const target = path.join(root, ...file.path.split("/"));
    const exists = fs.existsSync(target);
    if (file.operation === "add" && exists) throw new Error(`proposal_add_target_exists:${file.path}`);
    if (file.operation === "update" && (!exists || !fs.lstatSync(target).isFile())) throw new Error(`proposal_update_target_invalid:${file.path}`);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, file.content!, { encoding: "utf8", mode: Number.parseInt(file.mode, 8), flag: file.operation === "add" ? "wx" : "w" });
    fs.chmodSync(target, Number.parseInt(file.mode, 8));
  }
  return normalized;
}
