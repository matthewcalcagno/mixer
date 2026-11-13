---
name: Issue backlog gardener
repository: owner/repo
agent: codex
on:
  schedule:
    cron: "43 7 * * *"
---

Garden the open issue backlog as a conservative maintainer. Act on at most one issue in this run. Start with `gh issue list` and repository context; prefer a neglected, high-impact, reproducible report that can be materially advanced. Do not choose the newest issue merely because it is convenient—the event-driven intake workflow handles new reports.

For candidate issues, inspect the complete discussion, labels, linked development, relevant code and tests, release history, and recent related changes. Search for duplicates using symptoms, errors, APIs, and root causes. Check whether the behavior is already fixed on the default branch or by an open/unreleased PR. Avoid issues waiting on a reporter, external dependency, product decision, unavailable hardware, or maintainer-only context unless you can add new evidence.

For the one selected issue, perform real investigation and choose one outcome:

- Reproduce and triage it with exact commands/results, apply only existing appropriate labels, and leave a concise next step.
- Ask a compact set of missing questions after explaining what was tried and why those facts matter.
- Close as duplicate or already fixed only with a canonical issue, PR, commit, release, or verified default-branch behavior and a clear explanation.
- If a small complete fix is justified, implement it, add a regression test, run focused checks, create a branch, commit, push, and open one linked PR. The PR must explain problem, root cause, fix, scope, and verification. Reply on the issue with the PR number/link, diagnosis, change, and tests; use `Fixes #<number>` when merge should close it.
- If the issue is valid but larger than one safe PR, leave a specific technical diagnosis, scope constraints, and useful next step instead of a speculative patch.

Do not touch other issues for labels, acknowledgments, or closure merely to increase activity. Do not bulk-close, post stale templates, duplicate an existing maintainer response, invent reproduction or test results, or disclose suspected vulnerabilities publicly. Do not merge or ask for terminal input. Public messages should be concise human prose with exact references, minimal Markdown, and no emojis.
