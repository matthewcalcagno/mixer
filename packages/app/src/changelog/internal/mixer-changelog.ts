const REPOSITORY = "matthewcalcagno/mixer";
export const MIXER_RELEASE_URL = `https://api.github.com/repos/${REPOSITORY}/releases?per_page=100`;

export async function fetchMixerChangelog(signal: AbortSignal): Promise<string> {
  const entries: { version: number[]; body: string }[] = [];
  for (let page = 1; ; page++) {
    const response = await fetch(
      page === 1 ? MIXER_RELEASE_URL : `${MIXER_RELEASE_URL}&page=${page}`,
      { signal },
    );
    if (!response.ok) throw new Error(`Mixer release request failed: ${response.status}`);
    const metadata: unknown = await response.json();
    if (!Array.isArray(metadata)) throw new Error("Invalid Mixer release list");
    for (const release of metadata) {
      if (
        !release ||
        typeof release !== "object" ||
        release.draft ||
        release.prerelease ||
        !Array.isArray(release.assets) ||
        !release.assets.some((asset: { name?: string }) => asset.name === "CHANGELOG.md")
      )
        continue;
      const match =
        typeof release.tag_name === "string"
          ? /^v(\d+)\.(\d+)\.(\d+)$/.exec(release.tag_name)
          : null;
      if (!match) throw new Error("Invalid Mixer release tag");
      const expectedAsset = `https://github.com/${REPOSITORY}/releases/download/${release.tag_name}/CHANGELOG.md`;
      if (
        !release.assets.some(
          (asset: { name?: string; browser_download_url?: string }) =>
            asset.name === "CHANGELOG.md" && asset.browser_download_url === expectedAsset,
        )
      )
        throw new Error("Invalid Mixer changelog asset");
      const version = match.slice(1).map(Number);
      if (
        typeof release.body !== "string" ||
        !release.body.startsWith(`## ${version.join(".")} - `) ||
        release.body.split("\n").filter((line: string) => line.startsWith("## ")).length !== 1
      )
        throw new Error("The release does not contain version-specific Mixer changelog notes");
      entries.push({ version, body: release.body.trim() });
    }
    if (metadata.length < 100) break;
  }
  if (!entries.length) throw new Error("No published Mixer changelog is available");
  entries.sort(
    (a, b) =>
      b.version[0] - a.version[0] || b.version[1] - a.version[1] || b.version[2] - a.version[2],
  );
  // GitHub's API supports renderer CORS; release asset downloads do not.
  return `# Mixer Changelog\n\n${entries.map((entry) => entry.body).join("\n\n")}\n`;
}
