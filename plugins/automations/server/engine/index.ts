import { fileURLToPath } from "node:url";
import { Runtime } from "./upstream/packages/core/src/runtime.js";
import { BUILTINS } from "./upstream/packages/cli/src/builtins.js";
import { configureEmbeddedEnvironment } from "./environment.js";
export { startControlServer as startEmbeddedControl } from "./generated/control-server.js";

export * from "./upstream/packages/core/src/index.js";
export { configSchema as configurationSchema } from "./upstream/packages/core/src/config.js";
export type { Run, Workflow, AgentResult } from "./upstream/packages/sdk/src/index.js";

export function embeddedAuthoringResources() {
  return {
    docs: fileURLToPath(new URL("./docs/", import.meta.url)),
    sdk: fileURLToPath(new URL("./sdk/", import.meta.url)),
    cli: fileURLToPath(new URL("./embedded-cli.js", import.meta.url)),
  };
}

export function createEmbeddedEngine(home: string) {
  if (Number(process.versions.node.split(".")[0]) < 24)
    throw new Error("Mixer Automations requires a Node 24 or newer host runtime.");
  // A built-in plugin runs in its own subprocess. These flags never change the daemon environment.
  configureEmbeddedEnvironment(home, fileURLToPath(new URL("./sdk", import.meta.url)));
  return new Runtime({
    home,
    builtins: BUILTINS,
    consoleLogs: false,
    cli: {
      command: process.execPath,
      args: [fileURLToPath(new URL("./embedded-cli.js", import.meta.url)), "--home", home],
    },
  });
}
