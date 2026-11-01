import type {
  EditorGitBlame,
  EditorGitCommit,
  EditorGitCommitDetails,
} from "@mixer/protocol/editor-git";

export const COPY_GIT_COMMIT = "mixer.git.copyCommit";
export const REFRESH_GIT = "mixer.git.refresh";

export function isUncommitted(sha: string): boolean {
  return /^0+$/.test(sha);
}
export function relativeCommitTime(timestamp: number, now = Date.now()): string {
  const seconds = (timestamp - now) / 1000;
  const absolute = Math.abs(seconds);
  if (absolute < 60) return "just now";
  let unit: Intl.RelativeTimeFormatUnit = "minute";
  let divisor = 60;
  if (absolute >= 365 * 86400) {
    unit = "year";
    divisor = 365 * 86400;
  } else if (absolute >= 30 * 86400) {
    unit = "month";
    divisor = 30 * 86400;
  } else if (absolute >= 7 * 86400) {
    unit = "week";
    divisor = 7 * 86400;
  } else if (absolute >= 86400) {
    unit = "day";
    divisor = 86400;
  } else if (absolute >= 3600) {
    unit = "hour";
    divisor = 3600;
  }
  return new Intl.RelativeTimeFormat("en", { numeric: "auto" }).format(
    Math.trunc(seconds / divisor),
    unit,
  );
}
function inlineText(value: string): string {
  return value
    .replace(/\p{Cc}|\p{Bidi_Control}/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}
export function escapeGitMarkdown(value: string): string {
  return value.replace(/\r/g, "").replace(/([\\`*_{}[\]()#+.!<>|])/g, "\\$1");
}
export function gitInlineText(
  commit: EditorGitCommit,
  details?: EditorGitCommitDetails,
  now = Date.now(),
): string {
  if (isUncommitted(commit.sha)) return "Not Committed Yet • Uncommitted changes";
  const summary = [...inlineText(commit.summary)];
  const message = summary.length > 50 ? `${summary.slice(0, 49).join("")}…` : summary.join("");
  const pr = details?.pullRequest ? ` via PR #${details.pullRequest.number}` : "";
  return `${inlineText(commit.author)}, ${relativeCommitTime(commit.authoredAt, now)}${pr} • ${message}`;
}
function link(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:"
      ? parsed.href.replace(/\)/g, "%29")
      : null;
  } catch {
    return null;
  }
}
export function gitPatchPreview(patch: string, originalLine: number): string {
  const hunks = patch.split(/(?=^@@ )/m);
  const hunk = hunks.find((entry) => {
    const header = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(entry);
    return (
      header &&
      originalLine >= Number(header[1]) &&
      originalLine < Number(header[1]) + Number(header[2] ?? "1")
    );
  });
  if (!hunk) return "";
  const lines = hunk.split("\n");
  let current = Number(/^@@ -\d+(?:,\d+)? \+(\d+)/.exec(hunk)?.[1] ?? "1");
  for (const line of lines.slice(1)) {
    if (line.startsWith("-") || line.startsWith("\\")) continue;
    if (current === originalLine) return line;
    current++;
  }
  return "";
}
export function absoluteCommitTime(timestamp: number): string {
  const date = new Date(timestamp);
  const day = date.getDate();
  const suffix =
    day % 100 >= 11 && day % 100 <= 13 ? "th" : (["th", "st", "nd", "rd"][day % 10] ?? "th");
  const month = new Intl.DateTimeFormat("en", { month: "long" }).format(date);
  const time = new Intl.DateTimeFormat("en", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(date);
  return `${month} ${day}${suffix}, ${date.getFullYear()} ${time}`;
}

function authorHeader(
  commit: EditorGitCommit,
  details: EditorGitCommitDetails | undefined,
  now: number,
): string {
  const author = escapeGitMarkdown(inlineText(commit.author));
  const date = absoluteCommitTime(commit.authoredAt);
  const authorUrl = details?.authorProfileUrl ? link(details.authorProfileUrl) : null;
  const authorName = authorUrl ? `[**${author}**](${authorUrl})` : `**${author}**`;
  const avatar = details?.authorAvatar?.match(
    /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/,
  )
    ? `![Author avatar](${details.authorAvatar}|width=32,height=32) `
    : "";
  return `${avatar}${authorName}  $(history) ${relativeCommitTime(commit.authoredAt, now)} _(${date})_`;
}

function hoverCommitMessage(
  commit: EditorGitCommit,
  details: EditorGitCommitDetails | undefined,
): string {
  const message = (details?.message ?? commit.summary)
    .split("\n")
    .filter((line, index) => index === 0 || !/^\s*Signed-off-by:/i.test(line))
    .join("\n")
    .trim();
  const escaped = escapeGitMarkdown(message);
  const pr = details?.pullRequest;
  const url = pr ? link(pr.url) : null;
  if (!pr || !url) return escaped;
  return escaped.replace(/\\#(\d+)\b/g, (reference, number: string) =>
    Number(number) === pr.number ? `[${reference}](${url})` : reference,
  );
}

export function gitHoverMarkdown(
  commit: EditorGitCommit,
  originalLine: number,
  details?: EditorGitCommitDetails,
  now = Date.now(),
): string {
  if (isUncommitted(commit.sha))
    return "**Not Committed Yet**\n\nThis line contains uncommitted changes in the editor.";
  const pr = details?.pullRequest;
  const prUrl = pr ? link(pr.url) : null;
  const parts = [authorHeader(commit, details, now)];
  parts.push(hoverCommitMessage(commit, details));
  if (pr) {
    const text = `GitHub Issue or Pull Request #${pr.number}`;
    parts.push(
      `---\n\n$(link) ${prUrl ? `[${escapeGitMarkdown(text)}](${prUrl})` : escapeGitMarkdown(text)}`,
    );
  } else if (details?.pullRequestError)
    parts.push(
      `_Pull request details unavailable. Local Git history is still available._\n\n${escapeGitMarkdown(details.pullRequestError)}\n\n[Retry Git history](command:${REFRESH_GIT})`,
    );
  const copy = `command:${COPY_GIT_COMMIT}?${encodeURIComponent(JSON.stringify([commit.sha]))}`;
  const commitUrl = details?.url ? link(details.url) : null;
  parts.push(
    `---\n\n${commitUrl ? `[$(git-commit) \`${commit.sha.slice(0, 7)}\`](${commitUrl} "Open Commit")` : `$(git-commit) \`${commit.sha.slice(0, 7)}\``}  [$(copy)](${copy} "Copy SHA")${commitUrl ? `  |  [$(globe)](${commitUrl} "Open Commit on GitHub")` : ""}`,
  );
  const preview = details ? gitPatchPreview(details.patch, originalLine) : "";
  if (preview) {
    const longest = [...preview.matchAll(/`+/g)].reduce(
      (length, entry) => Math.max(length, entry[0].length + 1),
      3,
    );
    const fence = "`".repeat(longest);
    parts.push(
      `${fence}diff\n${preview}\n${fence}\n\nChanges ${preview.startsWith("+") ? "added" : "introduced"} in ${commitUrl ? `[$(git-commit) ${commit.sha.slice(0, 7)}](${commitUrl})` : `$(git-commit) \`${commit.sha.slice(0, 7)}\``}`,
    );
  }
  return parts.join("\n\n");
}

export function gitFileAuthorship(blame: Extract<EditorGitBlame, { kind: "ready" }>) {
  const commits = new Map(blame.commits.map((commit) => [commit.sha, commit]));
  const authors = new Map<string, { name: string; lines: number }>();
  let latest: EditorGitCommit | null = null;
  let latestLine = 1;
  for (const line of blame.lines) {
    const commit = commits.get(line.sha);
    if (!commit || isUncommitted(commit.sha)) continue;
    const key = commit.email || commit.author;
    const author = authors.get(key) ?? { name: commit.author, lines: 0 };
    author.lines++;
    authors.set(key, author);
    if (
      !latest ||
      commit.authoredAt > latest.authoredAt ||
      (commit.authoredAt === latest.authoredAt &&
        commit.sha === blame.head &&
        latest.sha !== blame.head)
    ) {
      latest = commit;
      latestLine = line.line;
    }
  }
  const sorted = [...authors.values()].sort(
    (a, b) => b.lines - a.lines || a.name.localeCompare(b.name),
  );
  return { latest, latestLine, authors: sorted };
}
