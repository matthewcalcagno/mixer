# Mixer Automations GitHub maintainer example pack

This directory is a working reference for building a serious autonomous repository
maintainer. The Markdown files are complete Mixer Automations workflow examples. This guide uses
a `.txt` extension so Mixer Automations will ignore it if the whole directory is copied
into the workflow directory; the CLI installs the same contents as Markdown docs.

The examples are intentionally detailed. A maintainer prompt should define the
whole responsibility of one unattended run, not merely tell a model to "handle an
issue" or "review a PR." The harness cannot stop to ask what the author intended.
It needs enough context to investigate, distinguish outcomes, perform the selected
work, verify it, update GitHub, and know when silence is the correct result.

## Install the pack

1. Copy the workflows below the global workflow home. Keeping each repository in
   its own directory makes a multi-repository installation easier to inspect:

     mkdir -p ~/.roboplane/workflows/owner--repo
     cp examples/maintainer/*.md ~/.roboplane/workflows/owner--repo/

2. Replace every `owner/repo` with the repository to maintain.
3. Select the desired `agent`, and optionally set its `model` and `thinking` mode.
   `12-approved-pr-merge.md` demonstrates a workflow-specific Codex selection with
   `model: gpt-6-astra` and `thinking: high`. Change that model to one supported by
   your selected harness, or remove `model` to use the harness default. Different
   workflows in the same installation may choose different models and reasoning
   levels.
4. In `12-approved-pr-merge.md`, replace `YOUR_GITHUB_LOGIN` in both locations
   with the exact login of the account whose PRs this workflow may merge.
5. Read every workflow and delete the responsibilities you do not want. These
   files are designed to coexist, but an installation should enable only work it
   actually wants performed.
6. Run `mixer-automations automations validate` and inspect `mixer-automations automations files` before restarting.

     mixer-automations automations validate
     mixer-automations automations files
     mixer-automations restart

Run `mixer-automations docs maintainer-examples` for this guide after installation. Every
complete prompt is also installed as a documentation topic named
`example-maintainer-<filename>`, such as:

     mixer-automations docs example-maintainer-01-issue-intake
     mixer-automations docs example-maintainer-03-incoming-pr-review
     mixer-automations docs example-maintainer-12-approved-pr-merge

## What the pack demonstrates

01-issue-intake.md owns a newly opened, reopened, or edited issue. It reads the
complete conversation and repository, searches for duplicates, attempts a real
reproduction, distinguishes several valid triage outcomes, and can carry a small
verified fix through a linked pull request and issue reply.

02-issue-follow-up.md reacts to a new comment on an existing issue. It uses case
memory to continue the prior investigation while rechecking live state, recognizes
what changed, avoids repeating questions, updates an existing fixing PR when one
exists, and stays silent for comments that need no maintainer response.

03-incoming-pr-review.md reviews a contributor PR at its current head. It derives
the intended contract, reads surrounding code and history, checks CI, produces
only concrete findings, revisits earlier findings after synchronization, and
chooses an approval, comment, request-for-changes, or no-op outcome.

04-own-pr-shepherd.md maintains a PR authored by the configured GitHub account. It
keeps the description and linked issue accurate, fixes incomplete implementation
or CI problems on the existing branch, avoids duplicate status comments, and
leaves an already healthy PR alone.

05-own-pr-feedback.md responds to issue comments, inline comments, and submitted
reviews on an owned PR. It verifies every request against the current revision,
changes and tests the code when appropriate, pushes to the same branch, replies in
the relevant thread with a commit and verification, and resolves only work that
is actually complete.

06-own-pr-failed-check.md handles a failed check-run webhook for an owned PR. It
detects stale deliveries, reads full logs, separates branch regressions from
default-branch, flaky, and infrastructure failures, fixes only branch-caused
problems, and records a precise diagnosis.

07-ci-health.md periodically investigates default-branch CI. It deliberately
chooses one persistent or high-impact failure, finds its first bad revision when
possible, and either creates a focused repair PR, opens a useful issue, contributes
new evidence to existing work, or produces no GitHub noise.

08-backlog-gardener.md revisits one neglected issue. It can reproduce and advance
the report, identify a verified duplicate or already-fixed behavior, request the
remaining information, implement a bounded fix, or leave a larger issue with an
actionable technical next step.

09-maintenance-audit.md demonstrates proactive work that is not triggered by a
reported bug. It examines dependencies, tooling, tests, documentation, resource
lifecycle, compatibility, performance, and developer experience, but opens at
most one evidence-backed issue or pull request.

10-contributor-pr-follow-up.md reacts specifically when a contributor replies to
an inline finding previously authored by the maintainer account. It rechecks the
new head, corrects the record when the original finding was wrong, and remains a
review-only workflow that never edits a contributor branch.

11-dependabot-merge.md demonstrates a one-run dependency caretaker. Its frontmatter
allowlists guarded updates to exact same-repository Dependabot branches. It examines
manifests, lockfiles, release notes, compatibility, and scope; makes bounded repairs;
pushes without rewriting history; babysits the final head; and requests one
approval-and-squash-merge Safe Action after the complete check set passes.

12-approved-pr-merge.md demonstrates a normal maintained-PR merge gate. It
reconstructs review history at the exact head, checks unresolved conversations,
linked issues, scope, mergeability, and CI before requesting the merge Safe Action.
It does not treat one successful check event as proof that a PR is ready.

## The maintainer operating model

Each workflow follows the same general operating model even though its trigger and
authority differ.

First, establish current state. Read repository instructions before editing. Fetch
the current GitHub object rather than trusting a possibly stale event payload.
Read the complete relevant conversation, current head and base revisions, linked
issues, reviews, checks, and prior automation output. Use case memory as a handoff,
then verify material facts against the checkout and GitHub.

Second, investigate before choosing an action. Locate the implementation and its
tests, inspect history when intent is unclear, reproduce claimed behavior where
practical, and compare PR failures with the base branch. Search existing issues and
PRs using symptoms, APIs, errors, and likely causes. Do not infer a duplicate,
regression, or fix from titles and status badges alone.

Third, choose one complete outcome. Good prompts enumerate legitimate outcomes:
fix, reply, triage, review, report, merge, blocked, or no-op. They explain the
evidence required for each. This prevents the harness from always editing code or
posting a comment solely because the workflow ran.

Fourth, finish the selected outcome. A code fix includes focused implementation,
regression coverage where meaningful, required checks, a clear commit, a pushed
branch, an accurate PR, and an update on the originating issue or review thread.
A review includes the exact head, concrete line-level findings, CI classification,
and an appropriate review state. A merge decision includes the entire observed
check set and current review state. A no-op deliberately leaves GitHub unchanged.

Fifth, communicate evidence rather than process. Public comments should tell a
developer what was found, what changed, where the change lives, which verification
actually ran, and what remains. Internal investigation can be extensive; public
output should be concise. Avoid progress chatter, generic acknowledgements,
repeated summaries, invented results, and claims that an unmerged PR is already a
released fix.

Finally, leave a durable handoff. For issue and PR runs, record the important new
facts, decisions, current head, linked work, test results, GitHub actions, and next
blocker in case memory. A later event should continue the case rather than restart
the investigation from the title.

## Delivery and runtime notes

The failed-check and approved-PR merge workflows require GitHub webhooks because
GitHub polling does not expose check_run events. The Dependabot caretaker uses PR,
maintainer-comment, and schedule triggers, so it works with polling or webhooks.
Webhooks still provide lower latency and more event actions.

Repository instructions and skills stay in the repository. Each harness starts in
an exact disposable checkout, so it discovers AGENTS.md and its normal skills as
it would in a manually started coding session. Related issue and PR runs share case
memory and are serialized, while unrelated cases may run concurrently.

The merge workflows are examples of explicit Safe Actions. Their frontmatter is
part of the example: the prompt may request only the declared action, and the
configured policy fixes the author allowlist, method, mode, and check minimum. A
successful check delivery is only a reason to investigate current readiness.
The Dependabot example separately declares `github.pullRequests.branchUpdates`;
that authorizes guarded branch repair but does not itself authorize approval or merge.

These workflows are a starting point, not universal repository policy. Adjust the
prompt to the repository's language, test commands, supported platforms, release
process, labeling conventions, definition of merge readiness, and maintainer
communication norms. Keep those repository-specific facts in AGENTS.md or the
workflow instead of expecting the harness to guess them.
