import type { DaemonClient } from "@mixer/client/internal/daemon-client";
import {
  LEGACY_LANGUAGE_PROVIDERS,
  type LanguageProvider,
} from "@mixer/protocol/language-services";

export async function readLanguageProviders(client: DaemonClient): Promise<LanguageProvider[]> {
  // COMPAT(languageProviderCatalog): added in v0.14.0, remove after 2027-04-30 once the host floor includes provider discovery.
  if (client.getLastServerInfoMessage()?.features?.languageProviders !== true)
    return LEGACY_LANGUAGE_PROVIDERS;
  return client.getWorkspaceLanguageProviders();
}
