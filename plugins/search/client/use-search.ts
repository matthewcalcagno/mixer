import { useCallback, useEffect, useRef, useState } from "react";
import { useRpc } from "@mixer/plugin/client";
import { cancelRpc, searchRpc, type SearchOptions, type SearchScope } from "../shared/search.js";
import type { SearchState } from "./model.js";

export function useSearch(scope: SearchScope, options: SearchOptions) {
  const search = useRpc(searchRpc);
  const cancel = useRpc(cancelRpc);
  const [channelId] = useState(() => globalThis.crypto.randomUUID());
  const [revision, setRevision] = useState(0);
  const [state, setState] = useState<SearchState>({ kind: "idle" });
  const stopRef = useRef<() => void>(() => {});
  useEffect(() => {
    if (!options.query) {
      setState({ kind: "idle" });
      return;
    }
    let active = true;
    let started = false;
    const identity = { ...scope, channelId, requestId: globalThis.crypto.randomUUID() };
    setState({ kind: "pending" });
    const timer = setTimeout(() => {
      started = true;
      void search({ ...identity, options })
        .then((result) => {
          if (active)
            setState(
              result.status === "cancelled" ? { kind: "cancelled" } : { kind: "complete", result },
            );
          return undefined;
        })
        .catch((error: unknown) => {
          if (active)
            setState({
              kind: "error",
              message: error instanceof Error ? error.message : "Search failed. Retry your search.",
            });
        });
    }, 150);
    function dispose() {
      active = false;
      clearTimeout(timer);
      // Best effort on disconnect; the daemon also enforces a five-second deadline.
      if (started) void cancel(identity).catch(() => undefined);
    }
    stopRef.current = () => {
      dispose();
      setState({ kind: "cancelled" });
    };
    return () => {
      dispose();
      stopRef.current = () => {};
    };
  }, [scope, options, channelId, revision, search, cancel]);
  const stop = useCallback(() => stopRef.current(), []);
  const refresh = useCallback(() => setRevision((value) => value + 1), []);
  return { state, stop, refresh };
}
