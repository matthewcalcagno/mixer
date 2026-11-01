import { z } from "zod";
import type {
  PluginStatusBarItem,
  PluginStatusBarRegistration,
  PluginStatusBarContent,
  PluginText,
  PluginIcon,
} from "@mixer/plugin/client";
import type { InstalledPlugin } from "../types";

const layoutSchema = z.object({
  id: z
    .string()
    .max(128)
    .regex(/^[a-z][a-z0-9-]*$/),
  workspaceId: z.string().trim().min(1).optional(),
  alignment: z.enum(["left", "right"]).default("left"),
  priority: z.number().finite().default(0),
  visible: z.boolean().default(true),
});
type TextContent = Extract<PluginStatusBarContent<PluginText>, { kind: "text" }>;
export interface ResolvedTextContent extends Omit<TextContent, "text" | "tooltip"> {
  text: string;
  tooltip: string;
}
type ResolvedContent =
  | ResolvedTextContent
  | Extract<PluginStatusBarContent<PluginText>, { kind: "custom" }>;
export interface RegisteredStatusItem {
  key: number;
  preferenceKey: string;
  installation: InstalledPlugin;
  id: string;
  workspaceId: string | null;
  name: string;
  alignment: "left" | "right";
  priority: number;
  visible: boolean;
  pending: boolean;
  content: ResolvedContent;
}
interface StatusValidation {
  parseIcon(icon: PluginIcon): PluginIcon;
}

function resolveContent(
  source: PluginStatusBarContent<PluginText>,
  name: string,
  plugin: InstalledPlugin,
  validation: StatusValidation,
): ResolvedContent {
  switch (source.kind) {
    case "text": {
      const text = plugin.i18n.resolve(source.text);
      if (typeof text !== "string" || text.length > 4096)
        throw new Error("Status bar text must be at most 4096 characters");
      const icon = source.icon === undefined ? undefined : validation.parseIcon(source.icon);
      if (!text.trim() && !icon) throw new Error("Status bar item needs text or an icon");
      if (source.onPress !== undefined && typeof source.onPress !== "function")
        throw new Error("Status bar action must be a function");
      const disabled = z.boolean().optional().parse(source.disabled);
      const tone = z.enum(["normal", "warning", "error", "success"]).optional().parse(source.tone);
      const tooltip = source.tooltip === undefined ? name : plugin.i18n.resolve(source.tooltip);
      return { kind: "text", text, icon, tooltip, disabled, tone, onPress: source.onPress };
    }
    case "custom":
      if (
        typeof source.Component !== "function" &&
        !(
          typeof source.Component === "object" &&
          source.Component !== null &&
          "$$typeof" in source.Component
        )
      )
        throw new Error("Status bar item needs a React component");
      return source;
    default:
      throw new Error("Invalid status bar content kind");
  }
}

export class PluginStatusBarStore {
  private entries: readonly RegisteredStatusItem[] = [];
  private listeners = new Set<() => void>();
  private nextKey = 0;
  constructor(private validation: StatusValidation) {}
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  getSnapshot = (): readonly RegisteredStatusItem[] => this.entries;

  add(
    installation: InstalledPlugin,
    input: PluginStatusBarItem<PluginText>,
  ): PluginStatusBarRegistration<PluginText> {
    const layout = layoutSchema.parse(input);
    const workspaceId = layout.workspaceId ?? null;
    if (installation.lifetime.signal.aborted) throw new Error("Plugin has stopped");
    if (
      this.entries.some(
        (entry) =>
          entry.installation === installation &&
          entry.id === layout.id &&
          entry.workspaceId === workspaceId,
      )
    )
      throw new Error(`Duplicate status bar item: ${layout.id}`);
    const key = this.nextKey++;
    let source = input;
    const normalize = (): RegisteredStatusItem => {
      const fields = layoutSchema.parse(source);
      const name = installation.i18n.resolve(source.name).trim();
      if (!name || name.length > 256)
        throw new Error("Status bar item needs a name of at most 256 characters");
      return {
        key,
        preferenceKey: `plugin:${installation.id}:${layout.id}`,
        installation,
        id: layout.id,
        workspaceId,
        name,
        alignment: fields.alignment,
        priority: fields.priority,
        visible: fields.visible,
        pending: false,
        content: resolveContent(source.content, name, installation, this.validation),
      };
    };
    this.publish([...this.entries, normalize()]);
    const refresh = () => {
      const previous = this.entries.find((entry) => entry.key === key);
      if (previous) this.replace(key, { ...normalize(), pending: previous.pending });
    };
    const unsubscribe = installation.i18n.subscribe(refresh);
    let removed = false;
    const remove = () => {
      if (removed) return;
      removed = true;
      unsubscribe();
      installation.lifetime.signal.removeEventListener("abort", remove);
      if (this.entries.some((entry) => entry.key === key))
        this.publish(this.entries.filter((entry) => entry.key !== key));
    };
    installation.lifetime.signal.addEventListener("abort", remove, { once: true });
    return {
      update: (patch) => {
        if (!this.entries.some((entry) => entry.key === key)) return;
        const previous = source;
        source = { ...source, ...patch };
        try {
          refresh();
        } catch (error) {
          source = previous;
          throw error;
        }
      },
      remove,
    };
  }
  async run(key: number): Promise<void> {
    const entry = this.entries.find((candidate) => candidate.key === key);
    if (
      !entry ||
      !entry.visible ||
      entry.pending ||
      entry.content.kind !== "text" ||
      entry.content.disabled ||
      !entry.content.onPress
    )
      return;
    this.replace(key, { pending: true });
    try {
      await entry.content.onPress();
    } finally {
      this.replace(key, { pending: false });
    }
  }
  private replace(key: number, patch: Partial<RegisteredStatusItem>) {
    if (this.entries.some((entry) => entry.key === key))
      this.publish(
        this.entries.map((entry) => (entry.key === key ? { ...entry, ...patch } : entry)),
      );
  }
  private publish(entries: readonly RegisteredStatusItem[]) {
    this.entries = entries;
    for (const listener of this.listeners) listener();
  }
}

export function statusItemsForWorkspace(
  entries: readonly RegisteredStatusItem[],
  serverId: string,
  workspaceId: string,
): RegisteredStatusItem[] {
  return entries
    .filter(
      (entry) =>
        entry.installation.serverId === serverId &&
        (entry.workspaceId === null || entry.workspaceId === workspaceId) &&
        entry.visible,
    )
    .sort((a, b) => {
      if (a.alignment !== b.alignment) return a.alignment === "left" ? -1 : 1;
      const priority = a.alignment === "left" ? b.priority - a.priority : a.priority - b.priority;
      return priority || a.preferenceKey.localeCompare(b.preferenceKey) || a.key - b.key;
    });
}
