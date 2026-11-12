import { createHash } from "node:crypto";
import type { PluginServerContext } from "@mixer/plugin/server";
import {
  automationSettings,
  chatRpc,
  createRpc,
  listRpc,
  openRpc,
  startRunRpc,
  listRunsRpc,
  getRunRpc,
  importRpc,
  applyActionRpc,
  runtimeStatusRpc,
  runtimeControlRpc,
} from "./shared/contracts.js";
import { resolveAgentProvider } from "./server/provider.js";
import { createRuntime } from "./server/runtime.js";
import { createWorkflowStore } from "./server/workflows.js";

export default function contribute(server: PluginServerContext) {
  if (!server.hostDataDirectory) throw new Error("Automations host storage is unavailable.");
  const store = createWorkflowStore(server.hostDataDirectory);
  const settings = server.registerSettings(automationSettings);
  const runtime = createRuntime(server.hostDataDirectory, server.mixer, store, settings);

  server.handle(runtimeStatusRpc, runtime.status);
  server.handle(runtimeControlRpc, ({ action }) => runtime.control(action));
  server.handle(listRpc, () => store.describe());
  server.handle(startRunRpc, ({ path }) => runtime.start(path));
  server.handle(listRunsRpc, () => runtime.list());
  server.handle(importRpc, ({ home }) => runtime.import(home));
  server.handle(applyActionRpc, ({ id, action, sha }) => runtime.applyRunAction(id, action, sha));
  server.handle(getRunRpc, ({ id }) => runtime.get(id));
  server.handle(openRpc, async ({ path }, { mixer }) => {
    const file = await store.validate(path);
    const workspace = await mixer.workspaces.open(file.root);
    return { workspaceId: workspace.id, path: file.path };
  });
  server.handle(createRpc, async ({ name, kind }, { mixer }) => {
    const file = await store.create(name, kind);
    const workspace = await mixer.workspaces.open(file.root);
    return { workspaceId: workspace.id, path: file.path };
  });
  server.handle(chatRpc, async ({ path }, { mixer }) => {
    const root = path ? (await store.validate(path)).root : await store.initialize();
    const preferences = await settings.read();
    if (preferences.status !== "ready") throw new Error(preferences.error);
    const provider = await resolveAgentProvider(mixer, preferences.values.agentProvider, root);
    const workspace = await mixer.workspaces.open(root);
    const hash = createHash("sha256")
      .update(JSON.stringify([workspace.id, path, provider]))
      .digest("hex");
    const agent = await workspace.agents.create({
      idempotencyKey: `automations-chat-${hash}`,
      title: path ? `Automation: ${path}` : "Automations",
      env: preferences.values.integrations.githubActionTokenEnv
        ? { [preferences.values.integrations.githubActionTokenEnv]: "" }
        : undefined,
      config: {
        provider,
        systemPrompt: path
          ? `Help the user edit the workflow at workspace-relative path ${JSON.stringify(path)}. Read it for context. Only run it when the user asks.`
          : "Help the user with their Mixer Automations workflows. Only run them when the user asks.",
      },
    });
    return { agentId: agent.id };
  });
  return runtime.close;
}
