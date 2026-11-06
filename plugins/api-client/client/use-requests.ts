import { useCallback, useEffect, useRef, useState } from "react";
import { useRpc } from "@mixer/plugin/client";
import { mergeCookies } from "../shared/vendor/cookie-jar.gen.js";
import { cancelRpc, sendRpc, resultRpc, type ApiRequest } from "../shared/contracts.js";
import { activeVariablePairs } from "./variables-model.js";
import { recordHistory, type ClientState } from "./model.js";
import type { RequestResult } from "./response.js";

export function useRequests(
  state: ClientState,
  update: (change: (current: ClientState) => ClientState) => void,
  onError: (value: string) => void,
) {
  const send = useRpc(sendRpc);
  const cancel = useRpc(cancelRpc);
  const readResult = useRpc(resultRpc);
  const [results, setResults] = useState<Record<string, RequestResult>>({});
  const jobs = useRef(new Map<string, string>());
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    const active = jobs.current;
    return () => {
      alive.current = false;
      for (const requestId of active.values()) void cancel({ requestId }).catch(() => undefined);
      active.clear();
    };
  }, [cancel]);
  const run = useCallback(
    async (draft: ApiRequest) => {
      if (jobs.current.has(draft.id)) return;
      const requestId = crypto.randomUUID();
      const request = structuredClone(draft);
      jobs.current.set(request.id, requestId);
      setResults((current) => ({ ...current, [request.id]: { pending: true, requestId } }));
      const variables = activeVariablePairs({ ...state, activeId: request.id });
      try {
        await send({ requestId, request, variables, cookieJar: state.cookieJar });
        let result = await readResult({ requestId });
        while (result.state === "pending") {
          await new Promise((resolve) => setTimeout(resolve, 300));
          if (!alive.current || jobs.current.get(request.id) !== requestId) return;
          result = await readResult({ requestId });
        }
        if (result.state === "error") throw new Error(result.error);
        const response = result.response;
        if (!alive.current || jobs.current.get(request.id) !== requestId) return;
        setResults((current) => ({ ...current, [request.id]: { pending: false, response } }));
        update((current) => {
          return recordHistory(
            { ...current, cookieJar: mergeCookies(current.cookieJar, response.cookieUpdates) },
            request,
            response,
            null,
          );
        });
      } catch (cause) {
        void cancel({ requestId }).catch(() => undefined);
        if (!alive.current || jobs.current.get(request.id) !== requestId) return;
        const error = cause instanceof Error ? cause.message : "Request failed.";
        setResults((current) => ({ ...current, [request.id]: { pending: false, error } }));
        update((current) => recordHistory(current, request, null, error));
      } finally {
        if (jobs.current.get(request.id) === requestId) jobs.current.delete(request.id);
      }
    },
    [send, cancel, readResult, state, update],
  );
  const stop = useCallback(
    (tabId: string) => {
      const requestId = jobs.current.get(tabId);
      if (requestId)
        void cancel({ requestId }).catch((cause: unknown) =>
          onError(cause instanceof Error ? cause.message : "Unable to cancel request."),
        );
    },
    [cancel, onError],
  );
  const forget = useCallback(
    (tabId: string) => {
      stop(tabId);
      jobs.current.delete(tabId);
      setResults((current) => {
        const next = { ...current };
        delete next[tabId];
        return next;
      });
    },
    [stop],
  );
  return { run, stop, forget, results };
}
