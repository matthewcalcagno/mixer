import type { PluginServerContext } from "@mixer/plugin/server";
import { languageServers } from "./server/servers";

export default function contribute(server: PluginServerContext) {
  for (const definition of languageServers()) server.registerLanguageServer(definition);
  return () => {};
}
