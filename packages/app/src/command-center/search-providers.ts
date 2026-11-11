import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { DaemonClient } from "@mixer/client/internal/daemon-client";
import { useActiveWorkspaceSelection } from "@/stores/navigation-active-workspace-store";
import { useSessionStore } from "@/stores/session-store";
import type { WorkspaceFileLocation } from "@/workspace/file-open";
import type { CommandCenterScope } from "@/stores/keyboard-shortcuts-store";
import { cancelRpc, searchRpc } from "../../../../plugins/search/shared/search";

export type WorkspaceSearchCategory = "text" | "classes" | "symbols";

export interface WorkspaceSearchMatch {
  id: string;
  title: string;
  detail: string;
  location: WorkspaceFileLocation;
}

export interface WorkspaceSearchProvider {
  id: string;
  category: WorkspaceSearchCategory;
  search(input: {
    client: DaemonClient;
    workspaceId: string;
    query: string;
    limit: number;
    signal: AbortSignal;
  }): Promise<readonly WorkspaceSearchMatch[]>;
}

let textChannelId: string | undefined;

const textProvider: WorkspaceSearchProvider = {
  id: "workspace-text",
  category: "text",
  async search({ client, workspaceId, query, limit, signal }) {
    const identity = {
      workspaceId,
      channelId: (textChannelId ??= crypto.randomUUID()),
      requestId: crypto.randomUUID(),
    };
    const cancel = () => {
      void client.invokePluginRpc("search", cancelRpc.name, identity).catch(() => undefined);
    };
    signal.addEventListener("abort", cancel, { once: true });
    try {
      const raw = await client.invokePluginRpc("search", searchRpc.name, {
        ...identity,
        options: {
          query,
          caseSensitive: false,
          wholeWord: false,
          regex: false,
          includes: "",
          excludes: "",
          respectIgnore: true,
          limit,
        },
      });
      const result = searchRpc.output.parse(raw);
      if (result.status === "cancelled") return [];
      return result.files
        .flatMap(({ path, matches }) =>
          matches.map((match) => ({
            id: `${path}:${match.line}:${match.column}`,
            title: match.preview.trim(),
            detail: `${path}:${match.line}`,
            location: { path, lineStart: match.line },
          })),
        )
        .slice(0, limit);
    } finally {
      signal.removeEventListener("abort", cancel);
    }
  },
};

let providers: readonly WorkspaceSearchProvider[] = [textProvider];
const listeners = new Set<() => void>();
const getProviders = () => providers;
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Host adapters can register class or symbol sources without changing the popup. */
export function registerWorkspaceSearchProvider(provider: WorkspaceSearchProvider): () => void {
  if (providers.some(({ id }) => id === provider.id)) {
    throw new Error(`Search provider already registered: ${provider.id}`);
  }
  providers = [...providers, provider];
  for (const listener of listeners) listener();
  return () => {
    providers = providers.filter((entry) => entry !== provider);
    for (const listener of listeners) listener();
  };
}

const EMPTY_RESULTS: readonly ProviderResult[] = [];

interface ProviderResult {
  provider: WorkspaceSearchProvider;
  matches: readonly WorkspaceSearchMatch[];
  error?: string;
}

export function useWorkspaceSearchProviders(input: {
  open: boolean;
  scope: CommandCenterScope;
  query: string;
}) {
  const sources = useSyncExternalStore(subscribe, getProviders);
  const selection = useActiveWorkspaceSelection();
  const workspaceId = selection?.workspaceId;
  const serverId = selection?.serverId;
  const client = useSessionStore((state) =>
    serverId ? state.sessions[serverId]?.client : undefined,
  );
  const query = input.query.trim();
  const scope = input.scope;
  const request = useMemo(() => {
    if (!input.open || !workspaceId || !client || query.length < (scope === "text" ? 1 : 2))
      return null;
    const selected = sources.filter((provider) => scope === null || scope === provider.category);
    return selected.length ? { client, workspaceId, query, selected } : null;
  }, [input.open, client, workspaceId, query, scope, sources]);
  const [state, setState] = useState<{
    request: typeof request;
    results: readonly ProviderResult[];
  }>({ request: null, results: [] });

  useEffect(() => {
    if (!request) return;
    const controller = new AbortController();
    const { signal } = controller;
    const limit = scope === null ? 24 : 100;
    async function searchOne(
      provider: WorkspaceSearchProvider,
      active: NonNullable<typeof request>,
    ) {
      let result: ProviderResult;
      try {
        const matches = await provider.search({
          client: active.client,
          workspaceId: active.workspaceId,
          query: active.query,
          limit,
          signal,
        });
        result = { provider, matches: matches.slice(0, limit) };
      } catch (error) {
        result = {
          provider,
          matches: [],
          error: error instanceof Error ? error.message : String(error),
        };
      }
      if (signal.aborted) return;
      setState((previous) => ({
        request: active,
        results: [...(previous.request === active ? previous.results : []), result],
      }));
    }
    const timer = setTimeout(
      () => {
        for (const provider of request.selected) void searchOne(provider, request);
      },
      scope === null ? 200 : 150,
    );
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [request, scope]);

  const results = request && state.request === request ? state.results : EMPTY_RESULTS;
  return {
    sources,
    results,
    loading: !!request && results.length < request.selected.length,
  };
}
