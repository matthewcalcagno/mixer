import type { PluginHostProps } from "@mixer/plugin/client";
/** The platform plugins see in `layout.platform`. */
export function resolvePluginPlatform(): PluginHostProps["layout"]["platform"] {
  return "web";
}
