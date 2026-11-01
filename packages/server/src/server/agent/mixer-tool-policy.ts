import type { ProviderMixerToolsPolicy } from "@mixer/protocol/provider-config";

interface ProviderMixerToolSettings {
  mixerTools?: ProviderMixerToolsPolicy;
}

export function resolveMixerToolPolicy(
  providerId: string,
  providerSettings: Readonly<Record<string, ProviderMixerToolSettings>> | undefined,
): ProviderMixerToolsPolicy | undefined {
  return providerSettings?.[providerId]?.mixerTools;
}

export function isMixerToolEnabled(
  policy: ProviderMixerToolsPolicy | undefined,
  toolName: string,
): boolean {
  if (toolName === "speak") {
    return true;
  }
  if (!isMixerToolPolicyEnabled(policy)) {
    return false;
  }
  return !policy?.disabledTools?.includes(toolName);
}

export function isMixerToolPolicyEnabled(policy: ProviderMixerToolsPolicy | undefined): boolean {
  return policy?.enabled !== false;
}
