import { parsePluginIcon } from "../icons";
import { PluginStatusBarStore } from "./model";

export const pluginStatusBarStore = new PluginStatusBarStore({
  parseIcon: (icon) => parsePluginIcon("Status bar item", icon),
});
