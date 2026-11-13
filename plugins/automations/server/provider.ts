import type { PluginServerContext } from "@mixer/plugin/server";

export async function resolveAgentProvider(
  mixer: PluginServerContext["mixer"],
  selection: string,
  cwd: string,
) {
  if (!selection) throw new Error("Choose an agent provider in Automations settings.");
  if (selection.includes("/")) return selection;
  const { models, error } = await mixer.providers.listModels(selection, { cwd });
  const selectable = models?.filter((model) => model.isSelectable !== false);
  const model = selectable?.find((item) => item.isDefault) ?? selectable?.[0];
  if (!model) throw new Error(error ?? `No selectable model found for ${selection}.`);
  return `${selection}/${model.id}`;
}
