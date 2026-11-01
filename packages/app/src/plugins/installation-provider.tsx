import { QueryClientProvider } from "@tanstack/react-query";
import {
  MixerApiProvider,
  PluginRpcProvider,
  PluginTranslationProvider,
} from "@mixer/plugin/client/host";
import React, { type ReactNode } from "react";
import type { InstalledPlugin } from "./types";

/** Every plugin surface renders under its installation: one query cache, one Mixer client, RPCs. */
export function PluginInstallationProvider({
  plugin,
  children,
}: {
  plugin: InstalledPlugin;
  children: ReactNode;
}) {
  return (
    <QueryClientProvider client={plugin.queryClient}>
      <MixerApiProvider mixer={plugin.mixer}>
        <PluginRpcProvider invoke={plugin.invoke}>
          <PluginTranslationProvider runtime={plugin.i18n}>{children}</PluginTranslationProvider>
        </PluginRpcProvider>
      </MixerApiProvider>
    </QueryClientProvider>
  );
}
