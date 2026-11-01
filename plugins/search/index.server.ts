import { resolveRipgrepPath, type PluginServerContext } from "@mixer/plugin/server";
import { cancelRpc, searchRpc, searchScopeKey } from "./shared/search.js";
import { searchWorkspace } from "./server/search.js";

interface Job {
  requestId: string;
  controller: AbortController;
}
export default function contribute(server: PluginServerContext) {
  const jobs = new Map<string, Job>();
  server.handle(searchRpc, async (input, { mixer }) => {
    const key = `${searchScopeKey(input)}/${input.channelId}`;
    const previous = jobs.get(key);
    if (!previous && jobs.size >= 4)
      throw new Error("Too many concurrent searches; stop a search and retry.");
    previous?.controller.abort();
    const job = { requestId: input.requestId, controller: new AbortController() };
    jobs.set(key, job);
    try {
      const root =
        "projectId" in input
          ? (await mixer.projects.list()).projects.find(
              (project) => project.projectId === input.projectId,
            )?.projectRootPath
          : (await mixer.workspaces.ref(input.workspaceId).refresh())?.workspaceDirectory;
      if (!root) throw new Error("Project directory is unavailable");
      return await searchWorkspace({
        root,
        ripgrepPath: await resolveRipgrepPath(),
        options: input.options,
        signal: job.controller.signal,
      });
    } finally {
      if (jobs.get(key) === job) jobs.delete(key);
    }
  });
  server.handle(cancelRpc, (input) => {
    const job = jobs.get(`${searchScopeKey(input)}/${input.channelId}`);
    const cancelled = job?.requestId === input.requestId;
    if (cancelled) job.controller.abort();
    return { cancelled };
  });
  return () => {
    for (const job of jobs.values()) job.controller.abort();
    jobs.clear();
  };
}
