import type { PluginServerContext } from "@mixer/plugin/server";
import { cancelRpc, resultRpc, sendRpc, type ApiResponse } from "./shared/contracts.js";
import { sendHttp } from "./server/http.js";

type Result =
  | { state: "pending" }
  | { state: "complete"; response: ApiResponse }
  | { state: "error"; error: string };
interface Job {
  controller: AbortController;
  result: Result;
  timer?: ReturnType<typeof setTimeout>;
}
function describeError(error: unknown, cancelled: boolean, timeoutMs: number): string {
  if (cancelled) return "Request cancelled.";
  if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError"))
    return `Request timed out after ${timeoutMs} ms.`;
  const detail = error instanceof Error ? error.message : "Network request failed";
  const cause =
    error instanceof Error && error.cause instanceof Error ? ` (${error.cause.message})` : "";
  return `${detail}${cause}`;
}
export default function contribute(server: PluginServerContext) {
  let disposed = false;
  const requests = new Map<string, Job>();
  server.handle(sendRpc, (input) => {
    const pending = [...requests.values()].filter((job) => job.result.state === "pending");
    if (pending.length >= 16)
      throw new Error("Too many active API requests. Cancel a request and retry.");
    if (requests.has(input.requestId)) throw new Error("This request is already running.");
    if (requests.size >= 48) {
      for (const [id, job] of requests) {
        if (job.result.state !== "pending") {
          clearTimeout(job.timer);
          requests.delete(id);
          break;
        }
      }
    }
    const job: Job = { controller: new AbortController(), result: { state: "pending" } };
    requests.set(input.requestId, job);
    // Long HTTP calls outlive the plugin RPC deadline. The client reads completion separately.
    void sendHttp({ ...input, signal: job.controller.signal })
      .then((response) => {
        job.result = { state: "complete", response };
        return undefined;
      })
      .catch((error: unknown) => {
        job.result = {
          state: "error",
          error: describeError(error, job.controller.signal.aborted, input.request.timeoutMs),
        };
      })
      .finally(() => {
        if (disposed) return;
        job.timer = setTimeout(() => requests.delete(input.requestId), 120000);
        job.timer.unref();
      });
    return { started: true };
  });
  server.handle(resultRpc, ({ requestId }) => {
    const job = requests.get(requestId);
    if (!job)
      return {
        state: "error" as const,
        error: "Request result expired or the host restarted. Send the request again.",
      };
    if (job.result.state !== "pending") {
      clearTimeout(job.timer);
      requests.delete(requestId);
    }
    return job.result;
  });
  server.handle(cancelRpc, ({ requestId }) => {
    const job = requests.get(requestId);
    if (job?.result.state === "pending") job.controller.abort();
    return { cancelled: Boolean(job?.controller.signal.aborted) };
  });
  return () => {
    disposed = true;
    for (const job of requests.values()) {
      job.controller.abort();
      clearTimeout(job.timer);
    }
    requests.clear();
  };
}
