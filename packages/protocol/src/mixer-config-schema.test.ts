import { describe, expect, it } from "vitest";
import { MixerConfigRawSchema, MixerConfigSchema } from "@mixer/protocol/mixer-config-schema";

describe("mixer config schema", () => {
  it("parses an empty config without metadata generation", () => {
    const parsed = MixerConfigSchema.parse({});

    expect(parsed).toEqual({});
    expect(parsed.metadataGeneration).toBeUndefined();
  });

  it("parses old-style worktree and scripts config unchanged", () => {
    const config = {
      worktree: {
        setup: "npm install",
        teardown: ["npm run clean"],
      },
      scripts: {
        dev: {
          type: "service",
          command: "npm run dev",
          port: 5173,
        },
      },
    };

    expect(MixerConfigSchema.parse(config)).toEqual({
      worktree: {
        setup: ["npm install"],
        teardown: ["npm run clean"],
      },
      scripts: config.scripts,
    });
  });

  it("parses service port allocation", () => {
    expect(
      MixerConfigSchema.parse({
        worktree: {
          servicePorts: { range: "3000-4000", portScript: "/usr/bin/portmake" },
        },
      }),
    ).toEqual({
      worktree: {
        setup: [],
        teardown: [],
        servicePorts: { range: "3000-4000", portScript: "/usr/bin/portmake" },
      },
    });
  });

  it("rejects invalid service port ranges", () => {
    expect(() =>
      MixerConfigRawSchema.parse({ worktree: { servicePorts: { range: "4000-3000" } } }),
    ).toThrow("Expected an inclusive TCP port range");
  });

  it("normalizes partial worktree lifecycle config without dropping present commands", () => {
    expect(
      MixerConfigSchema.parse({
        worktree: {
          setup: 'echo "setup ran" > setup.log',
        },
      }),
    ).toEqual({
      worktree: {
        setup: ['echo "setup ran" > setup.log'],
        teardown: [],
      },
    });

    expect(
      MixerConfigSchema.parse({
        worktree: {
          teardown: ["npm run clean"],
        },
      }),
    ).toEqual({
      worktree: {
        setup: [],
        teardown: ["npm run clean"],
      },
    });
  });

  it("parses all metadata generation instruction entries", () => {
    expect(
      MixerConfigSchema.parse({
        metadataGeneration: {
          title: { instructions: "Keep titles to a few words." },
          branchName: { instructions: "Prefix branches with feat/." },
          commitMessage: { instructions: "Use imperative mood." },
          pullRequest: { instructions: "Include risk notes." },
        },
      }),
    ).toEqual({
      metadataGeneration: {
        title: { instructions: "Keep titles to a few words." },
        branchName: { instructions: "Prefix branches with feat/." },
        commitMessage: { instructions: "Use imperative mood." },
        pullRequest: { instructions: "Include risk notes." },
      },
    });
  });

  it("parses partial metadata generation instructions with missing entries undefined", () => {
    const parsed = MixerConfigSchema.parse({
      metadataGeneration: {
        branchName: { instructions: "Keep it short." },
      },
    });

    expect(parsed.metadataGeneration).toEqual({
      branchName: { instructions: "Keep it short." },
    });
    expect(parsed.metadataGeneration?.commitMessage).toBeUndefined();
    expect(parsed.metadataGeneration?.pullRequest).toBeUndefined();
  });

  it("preserves legacy agentTitle metadata instructions as passthrough", () => {
    expect(
      MixerConfigSchema.parse({
        metadataGeneration: {
          agentTitle: { instructions: "Use concise titles." },
        },
      }),
    ).toEqual({
      metadataGeneration: {
        agentTitle: { instructions: "Use concise titles." },
      },
    });
  });

  it("passes through unknown metadata generation fields", () => {
    expect(
      MixerConfigSchema.parse({
        metadataGeneration: {
          futureField: 42,
        },
      }),
    ).toEqual({
      metadataGeneration: {
        futureField: 42,
      },
    });
  });

  it("passes through unknown metadata generator entry fields", () => {
    expect(
      MixerConfigSchema.parse({
        metadataGeneration: {
          branchName: {
            instructions: "Use concise titles.",
            model: "haiku",
          },
        },
      }),
    ).toEqual({
      metadataGeneration: {
        branchName: {
          instructions: "Use concise titles.",
          model: "haiku",
        },
      },
    });
  });

  it("falls back to an empty metadata generator entry when instructions has an invalid type", () => {
    expect(
      MixerConfigSchema.parse({
        metadataGeneration: {
          branchName: { instructions: 42 },
        },
      }),
    ).toEqual({
      metadataGeneration: {
        branchName: {},
      },
    });
  });

  it("raw schema preserves old-style config while accepting legacy agentTitle", () => {
    const config = {
      worktree: {
        setup: "npm install",
        teardown: ["npm run clean"],
      },
      scripts: {
        dev: {
          type: "service",
          command: "npm run dev",
        },
      },
      metadataGeneration: {
        agentTitle: { instructions: "Use concise titles." },
        branchName: { instructions: "Use concise branches." },
      },
    };

    expect(MixerConfigRawSchema.parse(config)).toEqual(config);
  });

  it("raw schema falls back to an empty metadata generator entry when instructions has an invalid type", () => {
    expect(
      MixerConfigRawSchema.parse({
        metadataGeneration: {
          branchName: { instructions: 42 },
        },
      }),
    ).toEqual({
      metadataGeneration: {
        branchName: {},
      },
    });
  });
});
