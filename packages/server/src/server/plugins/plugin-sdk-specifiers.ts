// These entries are supplied by the host and remain external in author bundles.
export const PLUGIN_CLIENT_ONLY_SDK_SPECIFIERS = [
  "@mixer/plugin/client",
  "@mixer/plugin/client/ui",
  // COMPAT(pluginReactNativeEntrypoint): added in v0.13.0, remove after 2027-04-20
  "@mixer/plugin/client/react-native",
] as const;

const PLUGIN_SERVER_ONLY_SDK_SPECIFIERS = [
  "@mixer/plugin/server",
  "@mixer/plugin/server/provider",
  "@mixer/plugin/server/usage",
  "@mixer/plugin/server/acp",
] as const;

export const PLUGIN_SDK_SPECIFIERS = [
  "@mixer/plugin",
  ...PLUGIN_SERVER_ONLY_SDK_SPECIFIERS,
  ...PLUGIN_CLIENT_ONLY_SDK_SPECIFIERS,
] as const;

export function isPluginClientOnlySdkSpecifier(name: string): boolean {
  return (PLUGIN_CLIENT_ONLY_SDK_SPECIFIERS as readonly string[]).includes(name);
}

export function isPluginServerOnlySdkSpecifier(name: string): boolean {
  return (PLUGIN_SERVER_ONLY_SDK_SPECIFIERS as readonly string[]).includes(name);
}
