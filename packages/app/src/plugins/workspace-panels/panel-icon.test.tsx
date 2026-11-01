/** @vitest-environment jsdom */
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import { createMixerApi } from "@mixer/client";
import { DaemonClient } from "@mixer/client/internal/daemon-client";
import { PluginTranslationRuntime } from "@mixer/plugin/client/host";
import type { PluginIconProps } from "@mixer/plugin";
import type { InstalledPlugin } from "../types";
import { pluginPanelRegistration } from "./panel";

const installed = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("../registry-state", () => ({ useInstalledPlugin: installed.get }));
vi.mock("@/runtime/host-runtime", () => ({ useHostRuntimeClient: () => null, useHosts: () => [] }));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function CountIcon({ workspaceId }: PluginIconProps) {
  const status = useQuery<{ files: string[] }>({
    queryKey: ["source-control", workspaceId],
    queryFn: async () => ({ files: [] }),
    enabled: false,
  });
  return <span data-testid="activity-count">{status.data?.files.length ?? 0}</span>;
}
function IconSurface() {
  const descriptor = pluginPanelRegistration.useDescriptor(
    { kind: "plugin", pluginId: "scm-test", panelId: "source-control", context: "workspace" },
    { serverId: "host", workspaceId: "workspace", tabId: "scm" },
  );
  const Icon = descriptor.icon;
  return <Icon size={16} color="#fff" />;
}

it("updates the activity icon from its installation's query cache instead of the app cache", async () => {
  const appCache = new QueryClient();
  const pluginCache = new QueryClient();
  const client = new DaemonClient({ url: "ws://127.0.0.1:1/ws", clientId: "icon-cache-test" });
  const mixer = createMixerApi(client);
  const i18n = new PluginTranslationRuntime({ getLocale: () => "en", subscribe: () => () => {} });
  const plugin: InstalledPlugin = {
    id: "scm-test",
    serverId: "host",
    clientBundle: "test",
    queryClient: pluginCache,
    lifetime: new AbortController(),
    locale: "en",
    i18n,
    mixer,
    invoke: async () => undefined,
    cleanup: () => {},
    surfaces: [],
    settingsScreens: [],
    sidebarItems: { header: [], footer: [] },
    legacySidebarItems: [],
    filePanels: [],
    commandCenterItems: [],
    clientSlashCommands: [],
    attachmentSources: [],
    themes: [],
    timelineTransformers: [],
    timelineRenderers: [],
    workspacePanels: [
      {
        id: "source-control",
        title: "Source Control",
        icon: CountIcon,
        context: "workspace",
        locations: ["explorer"],
        Component: () => null,
      },
    ],
  };
  installed.get.mockReturnValue(plugin);
  const key = ["source-control", "workspace"];
  appCache.setQueryData(key, { files: ["stale-app-cache"] });
  pluginCache.setQueryData(key, { files: ["a.txt", "b.txt"] });
  try {
    render(
      <QueryClientProvider client={appCache}>
        <IconSurface />
      </QueryClientProvider>,
    );
    expect(await screen.findByText("2")).toBeTruthy();
    await act(async () => {
      pluginCache.setQueryData(key, { files: [] });
    });
    await waitFor(() => expect(screen.getByTestId("activity-count").textContent).toBe("0"));
    await act(async () => {
      appCache.setQueryData(key, { files: ["wrong", "cache", "updates"] });
    });
    expect(screen.getByTestId("activity-count").textContent).toBe("0");
  } finally {
    cleanup();
    appCache.clear();
    pluginCache.clear();
    i18n.dispose();
    await mixer.dispose();
    await client.close();
  }
});
