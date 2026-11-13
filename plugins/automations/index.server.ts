import type { PluginServerContext } from "@mixer/plugin/server";
import {
  automationSettings,
  prepareChatRpc,
  createRpc,
  createDirectoryRpc,
  moveWorkflowRpc,
  replayRunRpc,
  cancelRunRpc,
  listRpc,
  openRpc,
  startRunRpc,
  listRunsRpc,
  getRunRpc,
  importRpc,
  applyActionRpc,
  runtimeStatusRpc,
  runtimeControlRpc,
  readWorkflowRpc,
  saveWorkflowRpc,
  deleteWorkflowRpc,
  setWorkflowEnabledRpc,
  configurationInfoRpc,
  reconcileActionRpc,
} from "./shared/contracts.js";
import { createEngineRuntime } from "./server/engine-runtime.js";
import { createWorkflowStore } from "./server/workflows.js";
import { automationAuthoringContext } from "./server/authoring-context.js";

export default function contribute(server: PluginServerContext) {
  if (!server.hostDataDirectory) throw new Error("Automations host storage is unavailable.");
  const authoringContext = automationAuthoringContext(server.hostDataDirectory);
  const runtime = createEngineRuntime(server.hostDataDirectory);
  const store = createWorkflowStore(server.hostDataDirectory, runtime.validation);
  const legacySettings = server.registerSettings(automationSettings);

  server.handle(runtimeStatusRpc, runtime.status);
  server.handle(runtimeControlRpc, ({ action }) => runtime.control(action));
  server.handle(configurationInfoRpc, async () => {
    const preferences = await legacySettings.read();
    if (preferences.status !== "ready")
      return { fileConfigured: true, agentProvider: "", error: preferences.error };
    return runtime.configurationInfo(preferences.values.agentProvider);
  });
  server.handle(listRpc, () => store.describe());
  server.handle(readWorkflowRpc, ({ path }) => store.read(path));
  server.handle(saveWorkflowRpc, (input) => store.save(input));
  server.handle(deleteWorkflowRpc, (input) => store.remove(input));
  server.handle(setWorkflowEnabledRpc, (input) => store.setEnabled(input));
  server.handle(startRunRpc, ({ path }) => runtime.start(path));
  server.handle(listRunsRpc, () => runtime.list());
  server.handle(importRpc, ({ home }) => runtime.import(home));
  server.handle(applyActionRpc, () => {
    throw new Error(
      "Safe Actions are applied and reconciled by the Mixer Automations engine. Legacy proposals require manual review.",
    );
  });
  server.handle(reconcileActionRpc, () => {
    throw new Error(
      "Legacy Safe Action records are read-only. Review their external state before starting a new engine run.",
    );
  });
  server.handle(replayRunRpc, ({ id, workflow }) => runtime.replay(id, workflow));
  server.handle(cancelRunRpc, ({ id, reason }) => runtime.cancel(id, reason));
  server.handle(getRunRpc, ({ id }) => runtime.get(id));
  server.handle(openRpc, async ({ path }, { mixer }) => {
    const file = await store.validate(path);
    const workspace = await mixer.workspaces.open(file.root);
    return { workspaceId: workspace.id, path: file.path };
  });
  server.handle(createRpc, async ({ path }) => {
    const file = await store.create(path);
    return { path: file.path };
  });
  server.handle(createDirectoryRpc, ({ path }) => store.createDirectory(path));
  server.handle(moveWorkflowRpc, (input) => store.move(input));
  server.handle(prepareChatRpc, async ({ path }, { mixer }) => {
    const root = path ? (await store.validate(path)).root : await store.initialize();
    const workspace = await mixer.workspaces.open(root);
    const instructions = path
      ? `Help the user edit the workflow at workspace-relative path ${JSON.stringify(path)}. Read it for context. Only run it when the user asks.`
      : "Help the user with their Mixer Automations workflows. Only run them when the user asks.";
    return {
      workspaceId: workspace.id,
      cwd: root,
      title: path ? `Automation: ${path}` : "Automations",
      systemPrompt: `${authoringContext}\n\n${instructions}`,
    };
  });
  return runtime.close;
}
