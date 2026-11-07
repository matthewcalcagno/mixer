import type { PluginServerContext, PluginHandlerContext } from "@mixer/plugin/server";
import type { GitScope } from "./shared/git.js";
import {
  actionRpc,
  prepareTrashRpc,
  autoFetchRpc,
  diffRpc,
  documentRpc,
  saveDocumentRpc,
  statusRpc,
  decorationsRpc,
} from "./shared/git.js";
import { diff, git, status, decorations } from "./server/git.js";
import { document, saveDocument } from "./server/document.js";
import { executeGitAction, prepareTrash } from "./server/action.js";

async function directory(scope: GitScope, mixer: PluginHandlerContext["mixer"]): Promise<string> {
  const root =
    "projectId" in scope
      ? (await mixer.projects.list()).projects.find(
          (project) => project.projectId === scope.projectId,
        )?.projectRootPath
      : (await mixer.workspaces.ref(scope.workspaceId).refresh())?.workspaceDirectory;
  if (!root) throw new Error("Project directory is unavailable");
  return root;
}

export default function contribute(server: PluginServerContext) {
  server.handle(prepareTrashRpc, async (input, { mixer }) =>
    prepareTrash(await directory(input, mixer), input.paths, input.revision),
  );
  server.handle(decorationsRpc, async (input, { mixer }) =>
    decorations(await directory(input, mixer)),
  );
  server.handle(documentRpc, async (input, { mixer }) => {
    return document(await directory(input, mixer), input.path, input.staged);
  });
  server.handle(saveDocumentRpc, async (input, { mixer }) => {
    return saveDocument(await directory(input, mixer), input.path, input.revision, input.content);
  });
  const fetches = new Map<string, { lastFetched: number | null; error: string | null }>();
  const fetching = new Map<string, Promise<{ lastFetched: number | null; error: string | null }>>();
  server.handle(autoFetchRpc, async (input, { mixer }) => {
    const cwd = await directory(input, mixer);
    const previous = fetches.get(cwd);
    if (previous?.lastFetched && Date.now() - previous.lastFetched < 180_000) return previous;
    const pending = fetching.get(cwd);
    if (pending) return pending;
    const task = (async () => {
      try {
        await git(cwd, ["fetch", "--all", "--quiet"]);
        const result = { lastFetched: Date.now(), error: null };
        fetches.set(cwd, result);
        return result;
      } catch (error) {
        const result = {
          lastFetched: previous?.lastFetched ?? null,
          error: error instanceof Error ? error.message : "Fetch failed",
        };
        fetches.set(cwd, result);
        return result;
      } finally {
        fetching.delete(cwd);
      }
    })();
    fetching.set(cwd, task);
    return task;
  });
  server.handle(statusRpc, async (input, { mixer }) => {
    return status(await directory(input, mixer));
  });
  server.handle(diffRpc, async (input, { mixer }) => {
    return { patch: await diff(await directory(input, mixer), input.path, input.staged) };
  });
  const busy = new Set<string>();
  server.handle(actionRpc, async (input, { mixer }) => {
    const { revision, action } = input;
    const cwd = await directory(input, mixer);
    if (busy.has(cwd)) throw new Error("Another Git operation is running");
    busy.add(cwd);
    try {
      return { message: await executeGitAction({ cwd, revision, action }) };
    } finally {
      busy.delete(cwd);
    }
  });
  return () => {};
}
