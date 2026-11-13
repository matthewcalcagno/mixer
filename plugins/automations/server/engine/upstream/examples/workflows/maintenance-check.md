---
name: dependency-health
repository: owner/repo
on:
  schedule:
    cron: "0 */12 * * *"
agent: codex
---

Check dependency declarations and lockfiles for one concrete maintenance problem. Do not modify files. Use `gh issue list` to avoid duplicates. If there is a real, untracked problem, open one concise issue explaining the evidence, impact, location, and practical next step. If there is no actionable finding, do nothing. Do not ask for terminal input.
