import type { StatusBarMenuRequest, StatusBarMenuResult } from "@/desktop/host";
export type StatusChoice = StatusBarMenuRequest["items"][number];
export type StatusMenuAction = StatusBarMenuResult;
export function updateHiddenStatusItems(
  hidden: readonly string[],
  id: string,
  visible: boolean,
): string[] {
  const next = new Set(hidden);
  if (visible) next.delete(id);
  else next.add(id);
  return [...next].sort();
}
export function uniqueStatusChoices(choices: StatusChoice[]): StatusChoice[] {
  const byId = new Map<string, StatusChoice>();
  for (const choice of choices) if (!byId.has(choice.id)) byId.set(choice.id, choice);
  return [...byId.values()];
}
