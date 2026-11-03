import { execFileSync } from "node:child_process";
import { getMergedReleasePlan, parseReleaseVersion } from "./release-version-utils.mjs";

export const CHANGELOG_TITLE = "# Mixer Changelog";
export const PREVIEW_MARKER = "<!-- mixer-release-preview -->";
export const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
export function githubApi(endpoint, { method, data, paginate = false } = {}) {
  const args = ["api", endpoint];
  if (paginate) args.push("--paginate", "--slurp");
  if (method) args.push("--method", method);
  if (data) args.push("--input", "-");
  const result = JSON.parse(
    execFileSync("gh", args, {
      encoding: "utf8",
      input: data ? JSON.stringify(data) : undefined,
    }),
  );
  return paginate ? result.flat() : result;
}
export function releaseNotesSection(body = "") {
  const lines = body.split(/\r?\n/);
  const start = lines.findIndex((line) => /^## Release notes\s*$/i.test(line));
  if (start < 0) return "";
  const end = lines.findIndex((line, index) => index > start && /^##\s/.test(line));
  return lines
    .slice(start + 1, end < 0 ? undefined : end)
    .join("\n")
    .trim();
}
function cleanNotes(text) {
  let fence = "";
  return text
    .replace(/<!--[\s\S]*?-->/g, "")
    .split("\n")
    .map((line) => {
      const edge = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
      if (edge) {
        fence = fence ? "" : edge[0];
        return line;
      }
      return fence ? line : line.replace(/^#{1,2}\s+/, "### ");
    })
    .join("\n")
    .trim();
}

function changeCategory(title) {
  if (/^(?:fix(?:\(.+?\))?:|fix(?:ed|es)?\b)/i.test(title)) return "Fixed";
  if (/^(?:feat(?:\(.+?\))?:|add(?:ed|s)?\b|support\b|enable\b)/i.test(title)) return "Added";
  if (/^(?:remove(?:d|s)?\b|drop\b)/i.test(title)) return "Removed";
  if (/^security\b/i.test(title)) return "Security";
  return "Changed";
}

export function renderReleaseNotes(changes, releaseBody = "") {
  const curated = releaseNotesSection(releaseBody);
  const entries = curated ? [{ title: "", body: `## Release notes\n${curated}` }] : changes;
  const groups = new Map();
  const seen = new Set();
  for (const change of entries) {
    let category = changeCategory(change.title);
    const detail = releaseNotesSection(change.body) || change.title;
    const credit = change.url
      ? ` ([${change.number ? `#${change.number}` : change.sha.slice(0, 7)}](${change.url}))`
      : "";
    for (const line of cleanNotes(detail).split("\n")) {
      const heading = /^#{1,3}\s+(Added|Changed|Fixed|Removed|Deprecated|Security)\s*$/i.exec(line);
      if (heading) {
        category = heading[1][0].toUpperCase() + heading[1].slice(1).toLowerCase();
        continue;
      }
      if (!line.trim() || line.startsWith("#")) continue;
      const text = line
        .replace(/^\s*[-*]\s+/, "")
        .replace(/\s+/g, " ")
        .trim();
      if (seen.has(text.toLowerCase())) continue;
      seen.add(text.toLowerCase());
      if (!groups.has(category)) groups.set(category, []);
      groups.get(category).push(`- ${text}${credit}`);
    }
  }
  return (
    ["Added", "Changed", "Deprecated", "Removed", "Fixed", "Security"]
      .filter((category) => groups.has(category))
      .map((category) => `### ${category}\n\n${groups.get(category).join("\n")}`)
      .join("\n\n") + "\n"
  );
}
export function writeReleaseChangelog({ version, date, notes, previous = "" }) {
  if (previous && !previous.startsWith(CHANGELOG_TITLE))
    throw new Error("Refusing to include a non-Mixer changelog");
  const history = previous.replace(/^# Mixer Changelog\s*/, "");
  const entries = /^## \d+\.\d+\.\d+/m.exec(history);
  return `${CHANGELOG_TITLE}\n\n## ${version} - ${date}\n\n${notes.trim()}\n${entries ? `\n${history.slice(entries.index).trim()}\n` : ""}`;
}
export function renderPreview({ plan, notes, head, baseline }) {
  return `${PREVIEW_MARKER}\n## Mixer release preview: ${plan.version}\n\nBump: **${plan.mode}** (major > minor > patch; patch is the default).\n\nSource: \`${head}\` · Previous published release: ${baseline || "first Mixer release"}\n\n${notes}\n---\nThis is a preview, not a published release. It refreshes on commits, PR edits, label changes, main updates, and published releases. The version is recalculated at merge if another release advances first. Add a \`## Release notes\` section to this PR or its included feature PRs for curated feature descriptions; otherwise titles and commit subjects are listed.\n`;
}
export function getReleaseContext({ source, labels, repo, releasePr, additionalSource }) {
  const currentVersion = JSON.parse(git("show", `${source}:package.json`)).version;
  const tags = git("tag", "--list", "desktop-v*").split("\n").filter(Boolean);
  const plan = getMergedReleasePlan({ currentVersion, tags, labels });
  const releases = repo ? githubApi(`repos/${repo}/releases?per_page=100`, { paginate: true }) : [];
  const published = releases
    .filter(
      (release) =>
        !release.draft &&
        !release.prerelease &&
        release.assets?.some((asset) => asset.name === "CHANGELOG.md"),
    )
    .sort((a, b) => {
      const x = parseReleaseVersion(a.tag_name.replace(/^v/, ""));
      const y = parseReleaseVersion(b.tag_name.replace(/^v/, ""));
      return y.major - x.major || y.minor - x.minor || y.patch - x.patch;
    })[0];
  const baseline = published?.tag_name || git("rev-list", "--max-parents=0", source).split("\n")[0];
  const previous = published
    ? execFileSync(
        "gh",
        [
          "api",
          `repos/${repo}/releases/assets/${published.assets.find((asset) => asset.name === "CHANGELOG.md").id}`,
          "-H",
          "Accept: application/octet-stream",
        ],
        { encoding: "utf8" },
      )
    : "";
  const commits = git(
    "log",
    "--no-merges",
    "--format=%H%x09%s",
    source,
    ...(additionalSource ? [additionalSource] : []),
    `^${baseline}`,
  )
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [sha, ...title] = line.split("\t");
      return { sha, title: title.join("\t") };
    })
    .filter(({ title }) => !title.startsWith("chore(release):"));
  const seen = new Set();
  const changes = [];
  for (const commit of commits.toReversed()) {
    const pulls = repo
      ? githubApi(`repos/${repo}/commits/${commit.sha}/pulls?per_page=100`, { paginate: true })
      : [];
    const included = pulls.filter(
      (pr) =>
        pr.number !== releasePr?.number &&
        pr.merged_at &&
        pr.base.repo.full_name === repo &&
        !(pr.head.ref === "develop" && pr.base.ref === "main"),
    );
    if (included.length) {
      for (const pr of included)
        if (!seen.has(pr.number)) {
          seen.add(pr.number);
          changes.push({
            number: pr.number,
            title: pr.title,
            body: pr.body || "",
            url: pr.html_url,
          });
        }
    } else
      changes.push({
        ...commit,
        url: repo ? `https://github.com/${repo}/commit/${commit.sha}` : "",
      });
  }
  const comparison = published
    ? `compare/${published.tag_name}...v${plan.version}`
    : `commits/v${plan.version}`;
  const notes =
    renderReleaseNotes(changes, releasePr?.body || "") +
    (repo ? `\n[Full Changelog](https://github.com/${repo}/${comparison})\n` : "");
  return { plan, notes, previous, baseline: published?.tag_name || null, head: source };
}
