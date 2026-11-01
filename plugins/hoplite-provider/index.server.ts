import type { PluginServerContext } from "@mixer/plugin/server";
import { createHopliteProvider } from "./server/provider.js";

export default function contribute(server: PluginServerContext) {
  server.registerProvider(createHopliteProvider());
  return () => {};
}
