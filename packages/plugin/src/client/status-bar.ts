import type { ComponentType } from "react";
import type { PluginText } from "../text.js";
import type { PluginHostProps, PluginIcon, PluginWorkspacePanelProps } from "./contracts.js";

export interface PluginStatusBarItemProps extends PluginHostProps {
  workspaceId: string;
  navigation?: PluginWorkspacePanelProps["navigation"];
}
export type PluginStatusBarContent<Text extends PluginText = string> =
  | {
      kind: "text";
      text: Text;
      icon?: PluginIcon;
      tooltip?: Text;
      disabled?: boolean;
      tone?: "normal" | "warning" | "error" | "success";
      onPress?(): void | Promise<void>;
    }
  | { kind: "custom"; Component: ComponentType<PluginStatusBarItemProps> };

export interface PluginStatusBarItem<Text extends PluginText = string> {
  /** Stable within the plugin; also identifies this item's saved visibility preference. */
  id: string;
  /** Human-readable name in the status bar's visibility menu. */
  name: Text;
  /** Omit to contribute to every workspace on this host. */
  workspaceId?: string;
  alignment?: "left" | "right";
  /** Higher priorities sit closer to the outer edge of their alignment group. */
  priority?: number;
  visible?: boolean;
  content: PluginStatusBarContent<Text>;
}
export type PluginStatusBarItemUpdate<Text extends PluginText = string> = Partial<
  Omit<PluginStatusBarItem<Text>, "id" | "workspaceId">
>;
export interface PluginStatusBarRegistration<Text extends PluginText = string> {
  update(patch: PluginStatusBarItemUpdate<Text>): void;
  remove(): void;
}
