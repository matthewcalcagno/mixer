import { PluginTranslationRuntime } from "@mixer/plugin/client/host";
import { useMixer, useRpc } from "@mixer/plugin/client";
import { defineRpc } from "@mixer/plugin";
import type { MixerApi } from "@mixer/client";
import { QueryClient, useQueryClient } from "@tanstack/react-query";
import React, { type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { z } from "zod";
import { PluginInstallationProvider } from "./installation-provider";
import type { InstalledPlugin } from "./types";
import { AgentChatEnvironment } from "./react-native/agent-chat-environment";
import { queryClient as hostQueryClient } from "@/data/query-client";

vi.mock("@/screens/workspace/sheet-pane/host", () => ({
  SheetPaneHostProvider: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@/git/diff-document/workspace-cache", () => ({
  DiffDocumentWorkspaceCacheProvider: ({ children }: { children: ReactNode }) => children,
}));

const status = defineRpc({
  name: "deploys.status",
  input: z.object({}),
  output: z.object({ state: z.string() }),
});

const conversationHost = {
  workspaceKey: "host:workspace",
  serverId: "host",
  workspaceId: "workspace",
  isWorkspaceFocused: true,
  buildContent: () => {
    throw new Error("This test does not open supporting panes");
  },
};

it("embedded host conversations read live host model defaults without changing plugin query ownership", () => {
  const plugin = installation([]);
  const key = ["providersSnapshot", "embedded-conversation-cache-test"];
  plugin.queryClient.setQueryData(key, "Loading");
  hostQueryClient.setQueryData(key, "Ready");
  function ModelStatus({ name }: { name: string }) {
    const cache = useQueryClient();
    return (
      <span>
        {name}: {cache.getQueryData<string>(key)}
      </span>
    );
  }
  try {
    const markup = renderToStaticMarkup(
      <PluginInstallationProvider plugin={plugin}>
        <ModelStatus name="Plugin" />
        <AgentChatEnvironment host={conversationHost}>
          <ModelStatus name="Conversation" />
        </AgentChatEnvironment>
        <ModelStatus name="Plugin after conversation" />
      </PluginInstallationProvider>,
    );
    expect(markup).toBe(
      "<span>Plugin: Loading</span><span>Conversation: Ready</span><span>Plugin after conversation: Loading</span>",
    );
  } finally {
    hostQueryClient.removeQueries({ queryKey: key });
    plugin.queryClient.clear();
    plugin.i18n.dispose();
  }
});

function installation(invoked: string[]): InstalledPlugin {
  return {
    id: "deploys",
    serverId: "host",
    clientBundle: "",
    lifetime: new AbortController(),
    locale: "en",
    i18n: new PluginTranslationRuntime({ getLocale: () => "en", subscribe: () => () => {} }),
    mixer: { dispose: async () => undefined } as MixerApi,
    invoke: async (method) => {
      invoked.push(method);
      return { state: "green" };
    },
    queryClient: new QueryClient(),
    cleanup: () => undefined,
    settingsScreens: [],
    surfaces: [],
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
}

it("gives every surface the installation's client and RPCs on its first frame", async () => {
  const invoked: string[] = [];
  const plugin = installation(invoked);
  const received: MixerApi[] = [];
  let rpc: ((input: Record<string, never>) => Promise<unknown>) | null = null;
  function Surface({ name }: { name: string }) {
    received.push(useMixer());
    rpc = useRpc(status);
    return <span>{name}</span>;
  }

  const markup = ["Screen", "Sidebar item", "Popover"]
    .map((name) =>
      renderToStaticMarkup(
        <PluginInstallationProvider plugin={plugin}>
          <Surface name={name} />
        </PluginInstallationProvider>,
      ),
    )
    .join("");

  expect(markup).toBe("<span>Screen</span><span>Sidebar item</span><span>Popover</span>");
  expect(received).toEqual([plugin.mixer, plugin.mixer, plugin.mixer]);
  expect(received.every((mixer) => mixer === plugin.mixer)).toBe(true);
  await expect(rpc!({})).resolves.toEqual({ state: "green" });
  expect(invoked).toEqual(["deploys.status"]);
});
