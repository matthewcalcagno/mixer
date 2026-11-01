import { expect, test } from "vitest";
import type { EditorGitCommit, EditorGitCommitDetails } from "@mixer/protocol/editor-git";
import {
  gitFileAuthorship,
  gitHoverMarkdown,
  gitInlineText,
  gitPatchPreview,
  relativeCommitTime,
  absoluteCommitTime,
} from "./git-presentation";

const commit: EditorGitCommit = {
  sha: "a".repeat(40),
  author: "Alice",
  email: "alice@example.test",
  authoredAt: Date.UTC(2026, 4, 19, 11, 55),
  summary: "Implement price formatting (#113)",
};
const now = commit.authoredAt + 150 * 86400_000;
const details: EditorGitCommitDetails = {
  commit,
  message: "Implement price formatting (#113)\n\nCo-authored-by: Bob <bob@example.test>",
  parents: ["b".repeat(40)],
  patch:
    "diff --git a/price.ts b/price.ts\n@@ -1,2 +1,3 @@\n const one = 1;\n+const price = 2;\n export {};\n",
  url: `https://github.com/example/project/commit/${commit.sha}`,
  pullRequest: {
    number: 113,
    title: "Price formatting",
    url: "https://github.com/example/project/pull/113",
    state: "MERGED",
  },
  pullRequestError: null,
};

test("matches the current-line author, relative date, PR, and summary layout", () => {
  expect(gitInlineText(commit, details, now)).toBe(
    "Alice, 5 months ago via PR #113 • Implement price formatting (#113)",
  );
  expect(relativeCommitTime(commit.authoredAt, commit.authoredAt + 7 * 86400_000)).toBe(
    "last week",
  );
  expect(gitInlineText({ ...commit, sha: "0".repeat(40) }, undefined, now)).toBe(
    "Not Committed Yet • Uncommitted changes",
  );
});

test("matches GitLens's ordinal date format and links verified PR references in the commit message", () => {
  expect(absoluteCommitTime(new Date(2026, 9, 28, 9, 47).getTime())).toBe(
    "October 28th, 2026 9:47 AM",
  );
  expect(absoluteCommitTime(new Date(2026, 9, 11, 9, 47).getTime())).toBe(
    "October 11th, 2026 9:47 AM",
  );
  expect(gitHoverMarkdown(commit, 2, details, now)).toContain(
    "[\\#113](https://github.com/example/project/pull/113)",
  );
});

test("hover contains local details, co-authors, a real PR link, and the line's change preview", () => {
  const hover = gitHoverMarkdown(commit, 2, details, now);
  expect(hover).toContain("**Alice**  $(history) 5 months ago");
  expect(hover).toContain("Co-authored-by: Bob \\<bob@example\\.test\\>");
  expect(hover).toContain(
    "[GitHub Issue or Pull Request \\#113](https://github.com/example/project/pull/113)",
  );
  expect(hover).toContain("+const price = 2;");
  expect(hover).toContain("command:mixer.git.copyCommit?");
  expect(hover).not.toContain("merged");
});

test("escapes repository-controlled Markdown and rejects non-web action URLs", () => {
  const dangerous: EditorGitCommitDetails = {
    ...details,
    message: "[Run](command:evil)\n<script>alert(1)</script>",
    url: "javascript:alert(1)",
    pullRequest: null,
  };
  const hover = gitHoverMarkdown(commit, 2, dangerous, now);
  expect(hover).toContain("\\[Run\\]\\(command:evil\\)");
  expect(hover).not.toContain("[Run](command:evil)");
  expect(hover).not.toContain("<script>");
  expect(hover).not.toContain("javascript:");
  const unavailable = gitHoverMarkdown(
    commit,
    2,
    { ...details, pullRequest: null, pullRequestError: "Provider temporarily unavailable" },
    now,
  );
  expect(unavailable).toContain("Provider temporarily unavailable");
  expect(unavailable).toContain("[Retry Git history](command:mixer.git.refresh)");
  expect(gitHoverMarkdown({ ...commit, sha: "0".repeat(40) }, 1)).toBe(
    "**Not Committed Yet**\n\nThis line contains uncommitted changes in the editor.",
  );
});

test("authors are counted from committed lines, excluding unsaved lines and duplicate metadata", () => {
  const author = gitFileAuthorship({
    kind: "ready",
    head: commit.sha,
    commits: [
      commit,
      {
        ...commit,
        sha: "b".repeat(40),
        author: "Bob",
        email: "bob@example.test",
        authoredAt: commit.authoredAt - 1000,
      },
      { ...commit, sha: "0".repeat(40), author: "You" },
    ],
    lines: [
      { line: 1, originalLine: 1, sha: commit.sha },
      { line: 2, originalLine: 2, sha: commit.sha },
      { line: 3, originalLine: 1, sha: "b".repeat(40) },
      { line: 4, originalLine: 4, sha: "0".repeat(40) },
    ],
  });
  expect(author.authors).toEqual([
    { name: "Alice", lines: 2 },
    { name: "Bob", lines: 1 },
  ]);
  expect(author.latest?.sha).toBe(commit.sha);
  expect(author.latestLine).toBe(1);
});

test("diff preview chooses the authored line's hunk and preserves meaningful trailing spaces", () => {
  expect(gitPatchPreview("@@ -1 +1 @@\n-old\n+new\n@@ -20 +20 @@\n-previous\n+updated  ", 20)).toBe(
    "+updated  ",
  );
});

test("diff preview contains only the selected line, not neighboring additions or context", () => {
  expect(gitPatchPreview("@@ -1,2 +1,4 @@\n first\n+inserted\n+selected\n last\n", 3)).toBe(
    "+selected",
  );
  expect(gitPatchPreview("@@ -1,2 +1,4 @@\n first\n+inserted\n+selected\n last\n", 4)).toBe(
    " last",
  );
  expect(gitPatchPreview("@@ -1 +1 @@\n-old\n+new\n", 20)).toBe("");
});

test("hides sign-off trailers and PR status without removing the message or co-authors", () => {
  const hover = gitHoverMarkdown(
    commit,
    2,
    {
      ...details,
      message:
        "Implement formatting\n\nKeep this explanation.\n\nSigned-off-by: Alice <alice@example.test>\nsigned-off-by: Bob <bob@example.test>\nCo-authored-by: Carol <carol@example.test>",
    },
    now,
  );
  expect(hover).toContain("Keep this explanation");
  expect(hover).toContain("Co-authored-by: Carol");
  expect(hover).not.toMatch(/signed-off-by/i);
  expect(hover).not.toContain("merged");
});

test("renders only host-provided inline avatars, never arbitrary external images", () => {
  expect(
    gitHoverMarkdown(commit, 2, { ...details, authorAvatar: "data:image/png;base64,aGVsbG8=" }),
  ).toContain("![Author avatar](data:image/png;base64,aGVsbG8=|width=32,height=32)");
  expect(
    gitHoverMarkdown(commit, 2, { ...details, authorAvatar: "https://evil.example/track" }),
  ).not.toContain("evil.example");
});
