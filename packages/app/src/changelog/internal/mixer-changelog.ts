const REPOSITORY = "matthewcalcagno/mixer";
export const MIXER_RELEASE_URL = `https://api.github.com/repos/${REPOSITORY}/releases/latest`;

export async function fetchMixerChangelog(signal: AbortSignal): Promise<string> {
  const release = await fetch(MIXER_RELEASE_URL, { signal });
  if (!release.ok) throw new Error(`Mixer release request failed: ${release.status}`);
  const metadata: unknown = await release.json();
  const tag =
    typeof metadata === "object" && metadata !== null && "tag_name" in metadata
      ? metadata.tag_name
      : null;
  if (typeof tag !== "string" || !/^v\d+\.\d+\.\d+$/.test(tag))
    throw new Error("Invalid Mixer release tag");
  const response = await fetch(
    `https://raw.githubusercontent.com/${REPOSITORY}/${tag}/CHANGELOG.md`,
    { signal },
  );
  if (!response.ok) throw new Error(`Mixer changelog request failed: ${response.status}`);
  const markdown = await response.text();
  if (!markdown.startsWith("# Mixer Changelog\n"))
    throw new Error("The release does not contain a Mixer changelog");
  return markdown;
}
