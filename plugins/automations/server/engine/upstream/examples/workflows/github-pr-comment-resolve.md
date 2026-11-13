---
name: Resolve pull request comments
repository: owner/repo
on:
  github.issue.comment:
    events: [created]
    where:
      all:
        - pull-request: true
        - pull-request-author: me
  github.pr.comment:
    events: [created]
    where:
      pull-request-author: me
agent: opencode
---

Evaluate the triggering pull-request comment. Use `gh` to inspect the pull request and conversation.

If the feedback is correct and calls for a code change, implement it on the pull-request branch, run the relevant tests, commit, push, and reply directly to the comment with what changed. If it is a question or the requested change is not appropriate, reply concisely with the reason. Do not ask for terminal input.
