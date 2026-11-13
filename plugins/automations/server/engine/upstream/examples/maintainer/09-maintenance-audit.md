---
name: Weekly repository maintenance audit
repository: owner/repo
agent: codex
on:
  schedule:
    cron: "29 4 * * 1"
---

Perform one bounded proactive repository-maintenance audit and carry one useful finding to a complete outcome. Read repository instructions and recent development first. Inspect the areas relevant to this project: dependency declarations and lockfiles, deprecated APIs, build and release tooling, tests and fixtures, documentation accuracy, accessibility, error handling, logging, resource cleanup, compatibility, performance-sensitive paths, dead code, generated artifacts, and developer experience. This is not permission to run a broad rewrite.

Choose at most one finding that has concrete evidence, meaningful impact, clear ownership, and a scope small enough to understand. Verify it against the current default branch. Search open and closed issues and PRs using the affected API, file, error, symptom, and likely root cause. Review recent commits to avoid rediscovering intentional work or opening a duplicate.

Decide the appropriate GitHub artifact:

- Small, confidently correct maintenance change: implement the smallest complete fix, add or update tests where behavior changes, run focused verification plus relevant lint/format/type checks, create a descriptive branch, commit, push, and open one PR. The PR title should describe the result. Its body must explain the observed problem with exact evidence, root cause, fix, scope boundaries, compatibility or risk, and commands/results used to verify it. Link existing issues and credit related work.
- User-visible bug or broader work that should be tracked before implementation: open one issue with a searchable title, exact evidence and reproduction, impact, affected area or versions, likely cause clearly marked as analysis, scope, and a practical next step. If you can then implement a safe focused fix in the same run, open a linked PR and reply on the issue with the PR, change, and tests.
- Existing issue or PR already covers it: add only material new evidence or a focused fix there. Do not create another artifact.
- Speculative, cosmetic, low-value, or unverified finding: do nothing.

After opening a PR for an existing issue, always comment on the issue with the PR number/link, concise diagnosis, what changed, and verification. After opening a discovered issue, ensure its description is sufficient for another maintainer to act without repeating your investigation. Do not post separate status comments when the PR body already contains the information and no issue needs an update.

Avoid broad dependency churn, generated lockfile changes without a reason, mass formatting, speculative abstractions, weakening tests, public disclosure of suspected vulnerabilities, or activity for its own sake. Never claim tests or measurements you did not run. Do not merge or ask for terminal input. Use direct professional prose, minimal Markdown in short comments, exact references, and no emojis or automation self-description.
