import { createRequire } from "node:module";
import * as pluginSharedRuntime from "@mixer/plugin";
import * as pluginProviderRuntime from "@mixer/plugin/server/provider";
import * as pluginAcpRuntime from "@mixer/plugin/server/acp";
import * as pluginUsageRuntime from "@mixer/plugin/server/usage";
import * as pluginServerRuntime from "@mixer/plugin/server";
import type { PluginServerContribution } from "@mixer/plugin/server";
import * as zod from "zod";
import * as automationsEngine from "@mixer/automations-engine";
import { isPluginClientOnlySdkSpecifier } from "./plugin-sdk-specifiers.js";

const nodeRequire = createRequire(import.meta.url);

function runtimeRequire(name: string): unknown {
  if (isPluginClientOnlySdkSpecifier(name)) {
    throw new Error(`${name} is available only in plugin client code`);
  }
  if (name === "@mixer/plugin") return pluginSharedRuntime;
  if (name === "@mixer/plugin/server") return pluginServerRuntime;
  if (name === "@mixer/plugin/server/provider") return pluginProviderRuntime;
  if (name === "@mixer/plugin/server/acp") return pluginAcpRuntime;
  if (name === "@mixer/plugin/server/usage") return pluginUsageRuntime;
  if (name === "zod") return zod;
  if (name === "@mixer/automations-engine") return automationsEngine;
  if (name === "@mixer/plugin/client/host") throw new Error(`${name} is private to the app host`);
  return nodeRequire(name);
}

export function evaluateBundle(bundle: string): PluginServerContribution {
  const evaluate: (source: string) => unknown = globalThis.eval;
  const factory = evaluate(bundle);
  if (typeof factory !== "function") throw new Error("Plugin server bundle is not executable");
  const exports = factory(runtimeRequire);
  const setup =
    exports !== null && typeof exports === "object" ? Reflect.get(exports, "default") : undefined;
  if (typeof setup !== "function") {
    throw new Error("Plugin server bundle must default export a function");
  }
  return setup as PluginServerContribution;
}
