import { describe, expect, it } from "vitest";
import { selectReleaseChannels, type GitHubRelease } from "./latest-release";
function desktopRelease({
  version,
  prerelease = false,
  draft = false,
}: {
  version: string;
  prerelease?: boolean;
  draft?: boolean;
}): GitHubRelease {
  return {
    tag_name: `v${version}`,
    assets: [
      { name: `Mixer-${version}-arm64.dmg` },
      { name: "Mixer-x86_64.AppImage" },
      { name: `Mixer-Setup-${version}-x64.exe` },
      { name: `Mixer-Setup-${version}-arm64.exe` },
    ],
    prerelease,
    draft,
  };
}
describe("selectReleaseChannels", () => {
  it("offers the newest prerelease when it leads stable", () => {
    const channels = selectReleaseChannels([
      desktopRelease({ version: "0.3.0-beta.2", prerelease: true }),
      desktopRelease({ version: "0.3.0-beta.1", prerelease: true }),
      desktopRelease({ version: "0.2.5" }),
    ]);
    expect(channels.stable.version).toBe("0.2.5");
    expect(channels.beta?.version).toBe("0.3.0-beta.2");
    expect(channels.beta?.windowsArm64Asset).toBe("Mixer-Setup-0.3.0-beta.2-arm64.exe");
  });
  it("retires the beta channel once stable ships the same version", () => {
    const channels = selectReleaseChannels([
      desktopRelease({ version: "0.3.0" }),
      desktopRelease({ version: "0.3.0-beta.2", prerelease: true }),
    ]);
    expect(channels.stable.version).toBe("0.3.0");
    expect(channels.beta).toBeNull();
  });
  it("skips drafts and releases whose desktop assets are still uploading", () => {
    const channels = selectReleaseChannels([
      desktopRelease({ version: "0.3.0-beta.3", prerelease: true, draft: true }),
      { tag_name: "v0.3.0-beta.2", assets: [], prerelease: true, draft: false },
      desktopRelease({ version: "0.3.0-beta.1", prerelease: true }),
      { tag_name: "v0.2.5", assets: [], prerelease: false, draft: false },
      desktopRelease({ version: "0.2.4" }),
    ]);
    expect(channels.stable.version).toBe("0.2.4");
    expect(channels.beta?.version).toBe("0.3.0-beta.1");
  });
});
