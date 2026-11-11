import { readFile, mkdtemp, writeFile, rm, access } from "node:fs/promises";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { git } from "./git.js";
import type { RpcOutput } from "@mixer/plugin";
import type { statusRpc } from "../shared/git.js";

type Operation = NonNullable<RpcOutput<typeof statusRpc>["operation"]>;
async function metadata(directory: string, name: string): Promise<string | null> {
  try {
    return await readFile(join(directory, name), "utf8");
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT")
      return null;
    throw error;
  }
}
export async function readOperation(cwd: string): Promise<Operation | null> {
  const directory = (await git(cwd, ["rev-parse", "--absolute-git-dir"])).trim();
  for (const folder of ["rebase-merge", "rebase-apply"]) {
    const marker = folder === "rebase-merge" ? "head-name" : "rebasing";
    if ((await metadata(directory, `${folder}/${marker}`)) !== null) {
      const head = await metadata(directory, "REBASE_HEAD");
      const message =
        (await metadata(directory, `${folder}/message`)) ??
        (await git(cwd, ["show", "-s", "--format=%B", "REBASE_HEAD"]));
      return {
        kind: "rebase",
        id: `rebase:${head}`,
        message: (await git(cwd, ["stripspace", "--strip-comments"], message)).trim(),
      };
    }
  }
  for (const [kind, name] of [
    ["merge", "MERGE_HEAD"],
    ["cherry-pick", "CHERRY_PICK_HEAD"],
    ["revert", "REVERT_HEAD"],
  ] as const) {
    const head = await metadata(directory, name);
    if (head !== null) {
      const message = (await metadata(directory, "MERGE_MSG")) ?? "";
      return {
        kind,
        id: `${kind}:${head.trim()}`,
        message: (await git(cwd, ["stripspace", "--strip-comments"], message)).trim(),
      };
    }
  }
  return null;
}
function quote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}
export async function continueOperation(
  cwd: string,
  operation: Operation,
  message: string,
): Promise<string> {
  if (!message.trim()) throw new Error("Enter a commit message.");
  if (operation.kind === "merge") return git(cwd, ["commit", "-m", message]);
  const directory = await mkdtemp(join(tmpdir(), "mixer-git-editor-"));
  try {
    const editor = join(directory, "editor.cjs");
    await writeFile(
      editor,
      "require('node:fs').writeFileSync(process.argv[2], process.env.MIXER_GIT_MESSAGE);\n",
    );
    // Sequencer continuations may reuse MERGE_MSG without invoking the editor.
    const messageFile = (await git(cwd, ["rev-parse", "--git-path", "MERGE_MSG"])).trim();
    await access(resolve(cwd, messageFile));
    await writeFile(resolve(cwd, messageFile), message + "\n");
    return await git(cwd, [operation.kind, "--continue"], undefined, {
      GIT_EDITOR: `${quote(process.execPath)} ${quote(editor)}`,
      GIT_SEQUENCE_EDITOR: "true",
      MIXER_GIT_MESSAGE: message,
      ELECTRON_RUN_AS_NODE: "1",
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
