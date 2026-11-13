---
name: Small feature PR review
repository: owner/repo
on:
  github.pull-request:
    events: [opened, synchronize, ready_for_review]
    where:
      all:
        - pull-request: true
        - head-branch:
            starts-with: "feature/"
        - base-branch:
            not-matches: "^release/v1(?:\\.|$)"
        - changed-files:
            lte: 20
agent: codex
---

Review the pull request as a maintainer. Read the repository instructions, inspect the complete diff and relevant code, and run focused checks when useful. Submit a concise GitHub review with only actionable findings. If there are no findings, approve it when appropriate. Do not ask for terminal input.
