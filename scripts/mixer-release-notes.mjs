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

function meaningfulLines(text = "") {
  return text
    .split("\n")
    .filter(
      (line) =>
        !/^\s*(?:Closes|Fixes|Resolves)\s+#?\s*$/i.test(line) &&
        !/^\s*- \[ \]/.test(line) &&
        !/^(?:Validation|Testing|Test plan):/i.test(line),
    )
    .join("\n")
    .trim();
}
function descriptionNotes(body = "") {
  const explicit = releaseNotesSection(body);
  if (explicit) return explicit;
  const sections = body.replace(/<!--[\s\S]*?-->/g, "").split(/^#{2,3}[ \t]+(.+?)[ \t]*$/m);
  const kept = [meaningfulLines(sections[0])];
  for (let index = 1; index < sections.length; index += 2) {
    const heading = sections[index].trim();
    if (
      /^(?:linked issues?|related issues?|type of change|test(?:ing|s| plan)?|validation|checklist|screenshots?|demo|qa)$/i.test(
        heading,
      )
    )
      continue;
    const content = meaningfulLines(sections[index + 1]);
    if (content) kept.push(`### ${heading}\n\n${content}`);
  }
  return kept.filter(Boolean).join("\n\n");
}

export function renderReleaseNotes(changes, releaseBody = "") {
  const curated = releaseNotesSection(releaseBody);
  const notes = changes.map((change) => {
    const detail = descriptionNotes(change.body);
    const credit = change.url
      ? ` ([${change.number ? `#${change.number}` : change.sha.slice(0, 7)}](${change.url}))`
      : "";
    return detail
      ? `${detail}\n\nSource: [#${change.number}](${change.url})`
      : `- ${change.title.replace(/\s+/g, " ")}${credit}`;
  });
  return cleanNotes([curated, ...notes].filter(Boolean).join("\n\n")) + "\n";
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
  const previous = published ? git("show", `${baseline}:CHANGELOG.md`) : "";
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
      (pr) => pr.number !== releasePr?.number && pr.base.repo.full_name === repo,
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
  const notes = renderReleaseNotes(changes, releasePr?.body || "");
  return { plan, notes, previous, baseline: published?.tag_name || null, head: source };
}
