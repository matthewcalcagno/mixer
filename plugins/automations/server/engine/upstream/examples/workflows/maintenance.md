---
name: Repository maintenance
repository: owner/repo
on:
  schedule:
    cron: "0 3 * * *"
agent: pi
---

Act as a conservative repository maintainer. Read the repository instructions first. Inspect the current repository and recent GitHub activity for one concrete maintenance problem.

If no change is needed, do nothing. If a focused change is justified, implement it, run the relevant tests, create a branch, commit, push, and open a pull request with a concise title and description. Do not ask for terminal input.
