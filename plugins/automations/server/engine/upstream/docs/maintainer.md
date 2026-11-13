# GitHub maintainer workflows

Before authoring or modifying these workflows, read `mixer-automations docs workflow-authoring` for the exact schema and delivery-mode limitations. The maintainer examples describe behavior and prompts; the workflow-authoring topic is authoritative for syntax.

Mixer Automations can provide the control-plane behavior of a persistent GitHub maintainer: route repository and scheduled events, invoke one unattended harness in an exact disposable checkout, preserve issue/PR memory across runs, serialize work on the same case, and let the harness use normal `gh` and `git` credentials.

The example pack in `examples/maintainer` covers:

- new and reopened issue triage, duplicate detection, reproduction, replies, labels, fixes, and linked PRs;
- follow-up issue conversations with persistent case memory;
- requested reviews of contributor PRs;
- focused follow-up when contributors reply to inline review findings authored by the PAT account;
- proactive shepherding of PRs authored by the PAT account;
- conversation comments, inline comments, and submitted reviews on those PRs;
- failed-check diagnosis and repair for those PRs;
- scheduled default-branch CI health, backlog gardening, and proactive maintenance;
- optional allowlisted bot-PR approval and immediate or GitHub auto-merge through explicit Safe Actions.
- final readiness review and allowlisted merge of an ordinary maintainer-authored PR.

The installed example guide explains the operating model and each workflow in detail:

```bash
mixer-automations docs maintainer-examples
mixer-automations docs example-maintainer-01-issue-intake
mixer-automations docs example-maintainer-03-incoming-pr-review
mixer-automations docs example-maintainer-12-approved-pr-merge
```

These are complete workflow prompts rather than shortened excerpts. They demonstrate the scope, evidence, decision criteria, verification, GitHub follow-up, no-op behavior, and case-memory handoff expected from an unattended workflow.

## Capability mapping

| Visible maintainer behavior | Mixer Automations mechanism | Starter workflow |
| --- | --- | --- |
| Reproduce, classify, label, deduplicate, reply, or fix a report | Issue lifecycle event plus exact checkout and `gh` | `01-issue-intake.md` |
| Continue a long issue conversation without losing prior decisions | Issue-comment event plus case `memory.md` | `02-issue-follow-up.md` |
| Review a contributor PR when requested | PAT-aware reviewer matching | `03-incoming-pr-review.md` |
| Follow up when a contributor replies to my inline finding | Live parent-comment author matching | `10-contributor-pr-follow-up.md` |
| Keep an authored PR accurate, mergeable, tested, and current | PAT-aware PR-author matching | `04-own-pr-shepherd.md` |
| Evaluate feedback, amend code, push, and answer with the commit | Conversation, inline-comment, and review events plus serialized PR memory | `05-own-pr-feedback.md` |
| Diagnose a red PR and distinguish a regression from unrelated CI | PR-bound check-run webhook event | `06-own-pr-failed-check.md` |
| Find persistent default-branch CI breakage and file or fix it | Bounded scheduled prompt | `07-ci-health.md` |
| Revisit neglected or duplicate reports | Bounded scheduled prompt | `08-backlog-gardener.md` |
| Discover and implement focused proactive maintenance | Bounded scheduled prompt | `09-maintenance-audit.md` |
| Repair, babysit, approve, and merge Dependabot PRs in one run | Branch-update allowlist, guarded publication chain, current-head check validation, and explicit Safe Action | `11-dependabot-merge.md` |
| Recheck the complete review and CI state, then merge an approved maintained PR | Successful-check webhook plus exact-head activation and explicit merge Safe Action | `12-approved-pr-merge.md` |

Copy the pack into a repository-specific directory below the global workflow home:

```bash
mkdir -p ~/.roboplane/automations/owner--repo
cp examples/maintainer/*.md ~/.roboplane/automations/owner--repo/
```

Then replace `owner/repo`, select the desired `agent` and optional `model` and `thinking` mode, replace `YOUR_GITHUB_LOGIN` in the approved-PR merge workflow, remove any workflows you do not want, and run. The approved-PR merge example explicitly uses `model: gpt-6-astra` with `thinking: high` to demonstrate a per-workflow model choice; replace it with a model supported by your harness or remove the field to use that harness's default.

```bash
mixer-automations automations validate
mixer-automations restart
```

The files are intentionally usable together: issue intake and follow-up have separate events; PR authorship divides incoming review from maintenance of your own PRs; feedback events are separate from PR lifecycle events; and each scheduled workflow has one bounded responsibility. The approved-PR merge workflow reacts to successful check-run webhooks. The Dependabot caretaker reacts to PR events, exact maintainer commands, and its bounded schedule. Both independently re-evaluate the exact PR head, complete check set, reviews, conversations, and mergeability. Runs for one issue or PR share memory and execute serially.

## Maintainer completion contract

The starter prompts require complete GitHub outcomes rather than isolated code edits. When a workflow fixes an issue, it must open or update the appropriate PR, link it correctly, and return to the issue with the PR reference, diagnosis, change, and verification. PR descriptions must explain problem, root cause, fix, scope, and exact tests. Review-feedback runs must reply in the relevant thread with the pushed commit and verification, then resolve the thread only when fully addressed. CI runs must compare the PR and default branch before deciding whether a failure belongs to the change.

Public messages are intentionally shorter than the internal investigation: direct human prose, exact issue/PR/commit/check references, minimal Markdown, no emojis, no generic acknowledgments, no invented evidence, and no progress comments that add no maintainer value.

## What remains the harness's job

Mixer Automations decides when and where to invoke the prompt. It attests the exact checkout, enforces the harness project directory, and assigns one branch capability. New work can claim one new branch; PAT-authored PRs can update only their exact observed head; and workflow frontmatter may allow named human or bot authors through `github.pullRequests.branchUpdates.allowedAuthors`. All other contributor PRs are commitless and review-only. Guarded fast-forward pushes are recorded as a same-run publication chain, allowing that run to validate, approve, and merge its final confirmed head without a second activation. The selected harness remains responsible for understanding repository instructions and skills, using `gh` and `git`, editing code, testing, committing when authorized, opening or updating PRs, reviewing, and communicating naturally. Reliability therefore still depends on the harness, model, repository guidance, available tools, PAT permissions, CI, and branch protection as well as Mixer Automations.

Mixer Automations structurally rejects normal `gh pr merge` commands and direct base-branch pushes. Merge is possible only through an explicit `github.pr.merge` Safe Action whose policy and live target validate. It does not bypass branch protection, infer organization policy, guarantee that an AI diagnosis is correct, or turn one scheduled scan into isolated child runs for every backlog item. The starter prompts deliberately bound scheduled work to one item. `github.check` is webhook-only because GitHub's polling events API does not emit check-run events.

This is functional coverage, not infrastructure parity with RoboBun. RoboBun visibly runs on dedicated always-on infrastructure with bespoke review gates, CI integrations, and very high throughput. Mixer Automations runs only while its daemon and host are available; its quality and iteration depth come from the selected harness and repository skills. For a local installation, polling is the simplest reliable default and a webhook tunnel improves latency and enables failed-check events.

For team review requests, change `reviewer: me` in the incoming-review workflow to an array such as `[me, organization/team-slug]`. Repository-local workflow files remain unsupported; repository-local `AGENTS.md` files and skills are discovered by the harness from the disposable checkout.
