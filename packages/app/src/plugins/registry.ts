import { PluginTranslationRuntime } from "@mixer/plugin/client/host";
import { i18n } from "@/i18n/i18next";
import type { AudioEngine } from "@/audio";
import { PluginRegistryState, pluginRegistryState } from "./registry-state";
import { QueryClient } from "@tanstack/react-query";
import { createMixerApi } from "@mixer/client";
import type { DaemonClient } from "@mixer/client/internal/daemon-client";
import { assertPluginCompatibility } from "@mixer/protocol/plugin-requirements";
import { resolveAppVersion } from "@/utils/app-version";
import { createPluginClientRuntime } from "./client-runtime";
import { runPluginClientBundle } from "./evaluate";
import type { InstalledPlugin } from "./types";

type CatalogPlugin = Awaited<ReturnType<DaemonClient["getPluginCatalog"]>>[number];

export class PluginRegistry {
  private readonly byHost = new Map<string, InstalledPlugin[]>();
  private readonly disposed = new WeakSet<InstalledPlugin>();
  private readonly evaluationErrors = new Map<string, string>();
  /** The client each host's installations were bound to; their Mixer API and RPCs call it. */
  private readonly clientByHost = new Map<string, DaemonClient>();

  constructor(
    private readonly dependencies: {
      localeSource: import("@mixer/plugin/client/host").PluginLocaleSource;
      version: string | null;
      createRuntime: typeof createPluginClientRuntime;
    },
    private readonly state = new PluginRegistryState(),
  ) {}

  subscribe = (listener: () => void): (() => void) => this.state.subscribe(listener);

  getSnapshot = (): InstalledPlugin[] => this.state.getSnapshot();

  getEvaluationError(serverId: string, pluginId: string): string | undefined {
    return this.evaluationErrors.get(`${serverId}/${pluginId}`);
  }

  installCatalog(
    serverId: string,
    catalog: CatalogPlugin[],
    options: {
      replacePluginId?: string;
      client: DaemonClient;
      audio: Pick<AudioEngine, "play">;
    },
  ): boolean {
    const previous = this.byHost.get(serverId) ?? [];
    const previousErrors = this.hostEvaluationErrors(serverId);
    // Installations call the client they were created with, so a new client replaces them all.
    const sameClient = this.clientByHost.get(serverId) === options.client;
    this.clientByHost.set(serverId, options.client);
    const previousTimelineBundles = previous
      .filter((plugin) => plugin.timelineTransformers.length > 0)
      .map((plugin) => `${plugin.id}\0${plugin.clientBundle}`);
    const preserved = catalog.flatMap((entry) => {
      if (!sameClient) return [];
      const existing = previous.find(
        (plugin) =>
          plugin.id !== options.replacePluginId &&
          plugin.id === entry.id &&
          plugin.clientBundle === entry.clientBundle &&
          plugin.requirements?.mixer === entry.requirements?.mixer,
      );
      return existing ? [existing] : [];
    });
    const removed = previous.filter((plugin) => !preserved.includes(plugin));
    if (removed.length > 0) {
      this.byHost.set(serverId, preserved);
      this.publish();
      for (const plugin of removed) this.dispose(plugin);
    }
    const installed = catalog.flatMap((entry) => {
      const key = `${serverId}/${entry.id}`;
      let installation: InstalledPlugin | undefined;
      try {
        if (!entry.clientBundle) return [];
        assertPluginCompatibility({ ...entry, version: this.dependencies.version, runtime: "app" });
        const existing = preserved.find(
          (plugin) => plugin.id === entry.id && plugin.clientBundle === entry.clientBundle,
        );
        if (existing) {
          this.evaluationErrors.delete(key);
          return [existing];
        }
        const client = options.client;
        installation = {
          lifetime: new AbortController(),
          locale: this.dependencies.localeSource.getLocale(),
          i18n: new PluginTranslationRuntime(this.dependencies.localeSource),
          mixer: createMixerApi(client),
          invoke: (method, input) => client.invokePluginRpc(entry.id, method, input),
          id: entry.id,
          serverId,
          clientBundle: entry.clientBundle,
          requirements: entry.requirements,
          queryClient: new QueryClient(),
          cleanup: () => undefined,
          surfaces: [],
          settingsScreens: [],
          sidebarItems: { header: [], footer: [] },
          legacySidebarItems: [],
          filePanels: [],
          workspacePanels: [],
          commandCenterItems: [],
          clientSlashCommands: [],
          attachmentSources: [],
          themes: [],
          timelineTransformers: [],
          timelineRenderers: [],
        };
        const unsubscribeTranslations = installation.i18n.subscribe(() => this.publish());
        installation.lifetime.signal.addEventListener("abort", unsubscribeTranslations, {
          once: true,
        });
        const runtime = this.dependencies.createRuntime(installation, options.audio);
        const evaluated = runPluginClientBundle(entry.id, entry.clientBundle, runtime, () =>
          this.publish(),
        );
        Object.assign(installation, evaluated);
        const mixer = installation.mixer;
        installation.cleanup = async () => {
          const results = await Promise.allSettled([mixer.dispose(), evaluated.cleanup()]);
          const failures = results.filter((result) => result.status === "rejected");
          if (failures.length)
            throw new AggregateError(
              failures.map((result) => result.reason),
              "Plugin cleanup failed",
            );
        };
        this.evaluationErrors.delete(key);
        return [installation];
      } catch (error) {
        installation?.lifetime.abort();
        installation?.i18n.dispose();
        void installation?.mixer
          .dispose()
          .catch((failure) => console.warn(`[Plugins] API cleanup failed for ${key}`, failure));
        this.evaluationErrors.set(key, error instanceof Error ? error.message : String(error));
        console.warn(`[Plugins] Failed to evaluate ${serverId}/${entry.id}`, error);
        return [];
      }
    });
    const configuredIds = new Set(catalog.map((entry) => entry.id));
    for (const key of this.evaluationErrors.keys()) {
      if (key.startsWith(`${serverId}/`) && !configuredIds.has(key.slice(serverId.length + 1))) {
        this.evaluationErrors.delete(key);
      }
    }
    this.byHost.set(serverId, installed);
    // An unchanged catalog keeps the snapshot, so timeline projections cached against the
    // installed transformers stay valid across a reconnect.
    const unchanged =
      installed.length === previous.length &&
      installed.every((plugin, index) => plugin === previous[index]) &&
      this.hostEvaluationErrors(serverId) === previousErrors;
    if (!unchanged) this.publish();
    const installedTimelineBundles = installed
      .filter((plugin) => plugin.timelineTransformers.length > 0)
      .map((plugin) => `${plugin.id}\0${plugin.clientBundle}`);
    return (
      previousTimelineBundles.length !== installedTimelineBundles.length ||
      previousTimelineBundles.some((bundle, index) => bundle !== installedTimelineBundles[index])
    );
  }

  removeHost(serverId: string): void {
    const installed = this.byHost.get(serverId);
    if (!installed) return;
    for (const plugin of installed) this.dispose(plugin);
    for (const key of this.evaluationErrors.keys()) {
      if (key.startsWith(`${serverId}/`)) this.evaluationErrors.delete(key);
    }
    this.byHost.delete(serverId);
    this.clientByHost.delete(serverId);
    this.publish();
  }

  private hostEvaluationErrors(serverId: string): string {
    const prefix = `${serverId}/`;
    return JSON.stringify(
      [...this.evaluationErrors].filter(([key]) => key.startsWith(prefix)).sort(),
    );
  }

  private dispose(plugin: InstalledPlugin): void {
    if (this.disposed.has(plugin)) return;
    this.disposed.add(plugin);
    plugin.lifetime.abort();
    plugin.i18n.dispose();
    plugin.queryClient.clear();
    try {
      void Promise.resolve(plugin.cleanup()).catch((error) => {
        console.warn(`[Plugins] Cleanup failed for ${plugin.serverId}/${plugin.id}`, error);
      });
    } catch (error) {
      console.warn(`[Plugins] Cleanup failed for ${plugin.serverId}/${plugin.id}`, error);
    }
  }

  private publish(): void {
    const snapshot = [...this.byHost.values()]
      .flat()
      // A new presentation snapshot invalidates label selectors without replacing the installation lifetime.
      // eslint-disable-next-line no-map-spread
      .map((plugin) => ({ ...plugin, locale: plugin.i18n.locale }))
      .sort((left, right) =>
        `${left.serverId}/${left.id}`.localeCompare(`${right.serverId}/${right.id}`),
      );
    this.state.publish(snapshot);
  }
}

export const pluginRegistry = new PluginRegistry(
  {
    localeSource: {
      getLocale: () => i18n.resolvedLanguage ?? i18n.language,
      subscribe: (listener) => {
        i18n.on("languageChanged", listener);
        return () => {
          i18n.off("languageChanged", listener);
        };
      },
    },
    version: resolveAppVersion(),
    createRuntime: createPluginClientRuntime,
  },
  pluginRegistryState,
);
