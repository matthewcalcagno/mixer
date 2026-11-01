import { describe, expect, test } from "vitest";

import { MutableDaemonConfigPatchSchema, MutableDaemonConfigSchema } from "./messages.js";
import { ProviderOverrideSchema, ProviderMixerToolsPolicySchema } from "./provider-config.js";

describe("provider Mixer-tool policy", () => {
  test("accepts arbitrary tool IDs and leaves an empty policy enabled by default", () => {
    expect(
      ProviderMixerToolsPolicySchema.parse({
        disabledTools: ["future_tool", "browser_future_tool"],
      }),
    ).toEqual({
      disabledTools: ["future_tool", "browser_future_tool"],
    });
    expect(ProviderMixerToolsPolicySchema.parse({})).toEqual({});
    expect(ProviderOverrideSchema.parse({}).mixerTools).toBeUndefined();
  });

  test("accepts mixerTools on persisted provider overrides", () => {
    expect(
      ProviderOverrideSchema.parse({
        extends: "claude",
        mixerTools: {
          enabled: false,
          disabledTools: ["create_workspace"],
        },
      }).mixerTools,
    ).toEqual({
      enabled: false,
      disabledTools: ["create_workspace"],
    });
  });

  test("accepts mixerTools when reading and patching mutable daemon providers", () => {
    expect(
      MutableDaemonConfigSchema.parse({
        mcp: { injectIntoAgents: true },
        providers: {
          codex: {
            mixerTools: { enabled: false, disabledTools: ["future_tool"] },
          },
        },
      }).providers.codex?.mixerTools,
    ).toEqual({
      enabled: false,
      disabledTools: ["future_tool"],
    });

    expect(
      MutableDaemonConfigPatchSchema.parse({
        providers: {
          codex: {
            mixerTools: { disabledTools: ["browser_future_tool"] },
          },
        },
      }).providers?.codex?.mixerTools,
    ).toEqual({ disabledTools: ["browser_future_tool"] });
  });
});
