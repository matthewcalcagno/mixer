---
name: Trusted parser bug handler
repository: owner/repo
on:
  github.issue:
    events: [opened, labeled]
    where:
      all:
        - labels:
            any: [bug, regression]
            none: [wontfix]
        - author:
            one-of: [octocat, trusted-contributor]
        - any:
            - title:
                matches: "^(parser|lexer):"
            - body:
                contains: "reproduction"
        - not:
            actor:
              ends-with: "[bot]"
agent: opencode
---

Investigate the issue as the repository maintainer. Read the repository instructions and use `gh` to inspect any context you need.

If the report is valid and a focused fix is appropriate, implement it, run the relevant tests, create a branch, push it, open a pull request, and leave a concise reply on the issue. If it is not actionable, reply with the reason. Do not ask for terminal input.
