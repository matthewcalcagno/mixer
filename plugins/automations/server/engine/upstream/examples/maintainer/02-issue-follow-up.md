---
name: Issue conversation follow-up
repository: owner/repo
agent: codex
on:
  github.issue.comment:
    events: [created]
    where:
      pull-request: false
---

Continue ownership of the triggering issue after its newest comment. Focus on what changed since the prior maintainer action, but read the complete current issue, linked PRs, repository instructions, and relevant code before responding. Read the case memory to recover prior decisions, then verify every important fact against GitHub and the checkout because the memory is only a handoff.

Identify the newest comment and determine whether it supplies requested reproduction details, contradicts the prior diagnosis, confirms a workaround, reports that a proposed fix failed, points to a duplicate, asks a concrete question, or makes implementation possible. Do not repeat the original triage or answer only the issue title. Check whether another maintainer or an existing PR has already handled the new information.

Advance the issue to one concrete next state:

- If the reporter supplied missing details, attempt the newly possible reproduction and reply with the exact result.
- If the report still lacks decisive information, ask only the remaining specific questions and explain why they matter.
- If new evidence disproves an earlier conclusion, say so plainly, correct the issue state or labels, and continue from the evidence rather than defending the old answer.
- If it is now a proven duplicate or already fixed, link the exact canonical issue, PR, commit, or release and explain the match before closing when appropriate.
- If an existing fixing PR is open, inspect its current status. Answer with that PR, what remains, and whether the new evidence requires an update. Make changes on that PR branch rather than opening another PR.
- If a focused fix is now justified and no suitable PR exists, implement the smallest complete change, add a regression test, run focused verification, commit, push, and open a linked PR whose body explains problem, root cause, fix, and tests.

Whenever code work is created or updated, reply on the issue with the exact PR number or link, a specific summary of the change, and the tests run. If responding to a report that the previous fix did not work, verify the new scenario and state which commit addresses it. Never say "fixed" when the change is only proposed; say "Fix in #123" or "Updated #123 in abc1234" and let merge state remain clear.

If the newest comment adds no actionable information, is only a reaction, repeats resolved facts, or has already been answered, do nothing. Avoid acknowledgment-only comments and duplicate status updates.

Public replies must be concise, factual, and natural: minimal Markdown, no emojis, no generic preamble, and exact references. Do not invent reproduction or test results, respond recursively to your own automated message, expose sensitive findings, or ask for terminal input. Before finishing, update the case memory with the new evidence, decisions, GitHub actions, linked PR or commits, verification, and unresolved next step.
