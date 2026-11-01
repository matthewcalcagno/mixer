import { useMemo, useSyncExternalStore } from "react";
import type { InstalledPlugin } from "./types";

/** Read-side state must not import plugin evaluation or host runtime initialization. */
export class PluginRegistryState {
  private snapshot: InstalledPlugin[] = [];
  private readonly listeners = new Set<() => void>();

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): InstalledPlugin[] => this.snapshot;

  publish(snapshot: InstalledPlugin[]): void {
    this.snapshot = snapshot;
    for (const listener of this.listeners) listener();
  }
}

export const pluginRegistryState = new PluginRegistryState();

export function useInstalledPlugins(): InstalledPlugin[] {
  return useSyncExternalStore(
    pluginRegistryState.subscribe,
    pluginRegistryState.getSnapshot,
    pluginRegistryState.getSnapshot,
  );
}

export function useInstalledPlugin(serverId: string, pluginId: string): InstalledPlugin | null {
  return (
    useInstalledPlugins().find(
      (plugin) => plugin.serverId === serverId && plugin.id === pluginId,
    ) ?? null
  );
}

export function usePluginInstallations(pluginId: string): InstalledPlugin[] {
  const installed = useInstalledPlugins();
  return useMemo(() => installed.filter((plugin) => plugin.id === pluginId), [installed, pluginId]);
}
