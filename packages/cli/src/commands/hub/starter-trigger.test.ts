import { describe, expect, it } from "vitest";
import { availableStarterTriggerConnections } from "./starter-trigger.js";

describe("starter trigger connections", () => {
  it("returns only concrete connections that can back the generated trigger", () => {
    expect(
      availableStarterTriggerConnections(
        {
          github: [
            {
              slug: "github-mixer",
              accountLogin: "mixer",
              accountType: "Organization",
              repositories: ["mixer/mixer"],
            },
          ],
          slack: [{ slug: "mixer", teamName: "Mixer" }],
          discord: [{ slug: "mixer-discord", guildName: "Mixer Discord" }],
          daemons: [],
          linear: [],
        },
        "mixer/mixer",
      ),
    ).toEqual([
      {
        id: "github:mixer/mixer",
        label: "GitHub — mixer/mixer",
        provider: "github",
        filters: { connection: "github-mixer", repo: "mixer/mixer" },
      },
      {
        id: "slack:mixer",
        label: "Slack — Mixer",
        provider: "slack",
        filters: { connection: "mixer" },
      },
      {
        id: "discord:mixer-discord",
        label: "Discord — Mixer Discord",
        provider: "discord",
        filters: { connection: "mixer-discord" },
      },
    ]);
  });

  it("does not offer GitHub when the current repository is not connected", () => {
    expect(
      availableStarterTriggerConnections(
        {
          github: [
            {
              slug: "github-mixer",
              accountLogin: "mixer",
              accountType: "Organization",
              repositories: ["mixer/hub"],
            },
          ],
          slack: [],
          discord: [],
          daemons: [],
          linear: [],
        },
        "mixer/mixer",
      ),
    ).toEqual([]);
  });
});
