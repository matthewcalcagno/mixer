import { afterEach, describe, expect, it } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { createMixerApi } from "@mixer/client";
import { DaemonClient } from "@mixer/client/internal/daemon-client";
import { PluginTranslationRuntime } from "@mixer/plugin/client/host";
import type { InstalledPlugin } from "../types";
import { PluginStatusBarStore, statusItemsForWorkspace } from "./model";
import { updateHiddenStatusItems } from "@/status-bar/model";

const plugins: InstalledPlugin[] = [];
afterEach(async () => {
  for (const plugin of plugins.splice(0)) {
    plugin.lifetime.abort();
    plugin.i18n.dispose();
    plugin.queryClient.clear();
    await plugin.mixer.dispose();
  }
});
function installation(
  input: Partial<Pick<InstalledPlugin, "id" | "serverId">> = {},
): InstalledPlugin {
  const plugin: InstalledPlugin = {
    id: input.id ?? "example",
    serverId: input.serverId ?? "host",
    lifetime: new AbortController(),
    locale: "en",
    i18n: new PluginTranslationRuntime({ getLocale: () => "en", subscribe: () => () => {} }),
    mixer: createMixerApi(
      new DaemonClient({ url: "ws://127.0.0.1:1/ws", clientId: "status-bar-test" }),
    ),
    invoke: async () => undefined,
    queryClient: new QueryClient(),
    clientBundle: "",
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
  plugins.push(plugin);
  return plugin;
}
function store() {
  return new PluginStatusBarStore({ parseIcon: (icon) => icon });
}
const content = { kind: "text" as const, text: "Ready" };
describe("plugin status bar contributions", () => {
  it("scopes items to their installation host and optional workspace and orders by alignment priority", () => {
    const items = store();
    const plugin = installation();
    items.add(plugin, { id: "inner", name: "Inner", content, priority: 1 });
    items.add(plugin, { id: "outer", name: "Outer", content, priority: 10 });
    items.add(plugin, {
      id: "right-outer",
      name: "Right outer",
      content,
      alignment: "right",
      priority: 10,
    });
    items.add(plugin, {
      id: "right-inner",
      name: "Right inner",
      content,
      alignment: "right",
      priority: 1,
    });
    items.add(plugin, { id: "local", name: "Local", content, workspaceId: "one" });
    items.add(installation({ serverId: "another" }), { id: "remote", name: "Remote", content });
    expect(
      statusItemsForWorkspace(items.getSnapshot(), "host", "two").map((entry) => entry.id),
    ).toEqual(["outer", "inner", "right-inner", "right-outer"]);
    expect(
      statusItemsForWorkspace(items.getSnapshot(), "host", "one").map((entry) => entry.id),
    ).toEqual(["outer", "inner", "local", "right-inner", "right-outer"]);
  });
  it("updates atomically, persists user hiding independently, and cannot resurrect removed items", () => {
    const items = store();
    const plugin = installation();
    const registration = items.add(plugin, { id: "task", name: "Build", content });
    const hidden = updateHiddenStatusItems([], "plugin:example:task", false);
    registration.update({ content: { kind: "text", text: "Building…" }, visible: true });
    expect(items.getSnapshot()[0].content).toMatchObject({ kind: "text", text: "Building…" });
    expect(hidden).toEqual(["plugin:example:task"]);
    expect(() => registration.update({ priority: NaN })).toThrow();
    expect(items.getSnapshot()[0].priority).toBe(0);
    registration.remove();
    registration.remove();
    registration.update({ visible: true });
    expect(items.getSnapshot()).toEqual([]);
  });
  it("namespaces preference IDs and removes all contributions when a plugin stops", () => {
    const items = store();
    const first = installation({ id: "first" });
    const second = installation({ id: "second" });
    items.add(first, { id: "status", name: "First", content });
    items.add(second, { id: "status", name: "Second", content });
    expect(() => items.add(first, { id: "status", name: "Duplicate", content })).toThrow(
      "Duplicate status bar item",
    );
    first.lifetime.abort();
    expect(items.getSnapshot().map((entry) => entry.preferenceKey)).toEqual([
      "plugin:second:status",
    ]);
  });
  it("prevents duplicate asynchronous actions and clears busy state after failures", async () => {
    const items = store();
    let complete: () => void = () => {
      throw new Error("Missing completion callback");
    };
    let calls = 0;
    const pending = new Promise<void>((resolve) => {
      complete = resolve;
    });
    items.add(installation(), {
      id: "run",
      name: "Run",
      content: {
        kind: "text",
        text: "Run",
        onPress: () => {
          calls++;
          return pending;
        },
      },
    });
    const key = items.getSnapshot()[0].key;
    const running = items.run(key);
    await items.run(key);
    expect(calls).toBe(1);
    expect(items.getSnapshot()[0].pending).toBe(true);
    complete();
    await running;
    expect(items.getSnapshot()[0].pending).toBe(false);
    const failure = items.add(installation({ id: "failing" }), {
      id: "run",
      name: "Fail",
      content: {
        kind: "text",
        text: "Fail",
        onPress: () => {
          throw new Error("Failed action");
        },
      },
    });
    await expect(items.run(items.getSnapshot()[1].key)).rejects.toThrow("Failed action");
    expect(items.getSnapshot()[1].pending).toBe(false);
    failure.remove();
  });
});
