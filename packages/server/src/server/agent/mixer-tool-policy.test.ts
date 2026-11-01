import { describe, expect, test } from "vitest";
import type { ProviderMixerToolsPolicy } from "@mixer/protocol/provider-config";

import { isMixerToolEnabled, resolveMixerToolPolicy } from "./mixer-tool-policy.js";

describe("Mixer tool policy", () => {
  test("defaults to all Mixer tools and resolves only the exact provider ID", () => {
    const customPolicy = {
      enabled: true,
      disabledTools: ["list_agents"],
    } satisfies ProviderMixerToolsPolicy;

    expect(
      resolveMixerToolPolicy("custom-claude", {
        claude: { mixerTools: { enabled: false } },
        "custom-claude": { mixerTools: customPolicy },
      }),
    ).toBe(customPolicy);
    expect(resolveMixerToolPolicy("other-custom", { claude: { mixerTools: customPolicy } })).toBe(
      undefined,
    );
    expect(isMixerToolEnabled(undefined, "list_agents")).toBe(true);
  });

  test("applies the provider gate and sparse disabled tools without filtering speak", () => {
    expect(isMixerToolEnabled({ enabled: false }, "list_agents")).toBe(false);
    expect(isMixerToolEnabled({ enabled: false }, "speak")).toBe(true);
    expect(
      isMixerToolEnabled({ enabled: true, disabledTools: ["list_agents"] }, "list_agents"),
    ).toBe(false);
    expect(
      isMixerToolEnabled({ enabled: true, disabledTools: ["list_agents"] }, "create_agent"),
    ).toBe(true);
  });
});
