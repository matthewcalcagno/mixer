# Release

Mixer distributes the Electron desktop app through GitHub Releases. Workspace
packages stay private and are bundled into the app. You do not need npm publishing,
an npm token, or ownership of the `@mixer` scope. All workspaces share one version
because the desktop build consumes their generated output.

## One-time macOS setup

Use an Apple Developer Program team and a **Developer ID Application** certificate
for distribution outside the Mac App Store. Keep the app ID `sh.mixer.desktop`
and the signing team consistent across releases so installed apps can update.

1. Create the Developer ID Application certificate in Apple Developer, install it
   in Keychain Access, and verify that its private key is present.
2. Export the certificate **with its private key** as a password-protected `.p12`.
3. Base64-encode that file and add the following repository Actions secrets in
   GitHub → Settings → Secrets and variables → Actions.

| Secret                       | Value                                          |
| ---------------------------- | ---------------------------------------------- |
| `APPLE_CERTIFICATE`          | Base64-encoded Developer ID Application `.p12` |
| `APPLE_CERTIFICATE_PASSWORD` | Password used when exporting the `.p12`        |
| `APPLE_ID`                   | Apple Account email used for notarization      |
| `APPLE_PASSWORD`             | App-specific password for that Apple Account   |
| `APPLE_TEAM_ID`              | Developer Program team ID                      |

On macOS, copy the encoded certificate without printing it to a terminal log:

```bash
base64 -i /path/to/DeveloperID.p12 | pbcopy
```

The workflow uses its automatic `GITHUB_TOKEN` to upload release assets. No npm
or GitHub personal access token is required. Keep the repository public: the
installed app downloads updates without embedding a GitHub credential.
The workflow requires all five Apple secrets and forces code signing. Hardened
runtime, entitlements, and notarization are enabled in the builder configuration.
Windows signing needs separate certificate setup before distributing Windows
builds; the Apple credentials cover only macOS.

## Preparation and authorization

Prepare locally before publishing: resolve the release source to one commit,
confirm its CI is green, review changes since the previous stable release, choose
a patch or minor version, and draft the changelog for review. Keep release inputs
separate from code fixes. If the user requests only setup or a preview, do not
commit, tag, push, or publish a release.

The default source is a clean `main` matching freshly fetched `origin/main`.
An explicit source ref overrides that default. Surface sanity-check findings and
wait for approval of the concrete release contents before publishing. A release
skill invocation starts preparation; it does not authorize publication.

## Release by merging develop into main

Merge a PR from this repository's `develop` branch into `main` to publish a stable
macOS release automatically. CI already checks PRs against every base branch;
push checks run on both `develop` and `main`. Keep `main` as the production branch.
You can select `develop` as the default branch in repository settings.

In GitHub settings, protect `main` by requiring a PR and passing CI checks.
Do not require another person's approval for a solo repository. Branch settings
are separate from these workflow files and must be configured in GitHub.

The default bump is patch. Add one PR label, `release:minor` or `release:major`,
for a larger bump (`release:patch` is also accepted). Conflicting labels fail
preparation. Create those labels in GitHub before selecting them. Review release
contents and changelog before merging: the merge starts publication automatically.
Closed, unmerged PRs, fork PRs, and merges from other branch names do not release.

The merge workflow creates a version commit based on the exact merged commit and
pushes only its `desktop-v...` tag, leaving protected `main` unchanged. Versions
advance from the highest stable desktop tag or checkout version, so `develop`
does not need to carry each automated bump. This tagged commit is the release
source; every workspace and the lockfile carry its release version. Merge releases
are serialized; wait for the active release before merging another release PR.

The workflow calls Desktop Release directly with the repository signing secrets.
It does not rely on a bot-pushed tag starting another workflow and needs no PAT.
A rerun reuses the merge's original release tag rather than allocating a new
version. To retry a failed build, rerun all jobs for that merge workflow. A direct
push to `main` does not release; the manual tag path remains available below.
Do not run a manual release concurrently with an automatic one.

## Publish a desktop release manually

After the source and changelog are approved and committed, run one command:

```bash
npm run release:patch
# Or: npm run release:minor
```

These commands build the workspace dependencies, run typecheck and lint, bump all
workspace versions, commit the version change, and push the current branch and a
`desktop-vX.Y.Z` tag. The version hook stages files, so start from a clean checkout.
The commands do not publish npm packages. Desktop tags avoid the separate Docker
workflow's generic `v*` push trigger.

For beta releases use `release:beta:patch`, `release:beta:minor`, or
`release:beta:next`. Use `release:promote` to remove the beta suffix after review.
The source tag is `desktop-vX.Y.Z[-beta.N]`; the downloadable GitHub Release uses
canonical tag `vX.Y.Z[-beta.N]`. Do not push a second generic version tag yourself.

The **Desktop Release** workflow defaults to macOS, building Apple Silicon and
Intel installers. Its quality job must pass before a draft release is created.
Notes are generated and then replaced with the matching changelog entry when one
exists. Platform jobs upload binaries to the draft; finalization merges the macOS
architecture manifests, validates selected-platform manifests, and publishes the
release only after every selected build succeeds. A failed build leaves the new
release as a draft.

For manual runs, select **Actions → Desktop Release → Run workflow**:

- `tag`: an existing source tag whose version matches every workspace.
- `platform`: `macos` by default; opt into `linux`, `windows`, or `all`.
- `publish`: `false` keeps downloads in workflow artifacts rather than publishing.
- `rollout_hours`: `36` by default; use `0` for immediate update eligibility.
- `checkout_ref`: leave empty to build the tag itself. An override must have the
  same package versions and is intended for diagnosing a failed draft build.

Manual macOS builds still require signing and notarization credentials. Download
workflow artifacts from the run summary when `publish=false`. Once a version is
public, ship different code under a new version rather than replacing its assets.
Retry a failed draft workflow from its recorded source before publishing it.

## Installation and auto-updates

Download the matching architecture's DMG from
[GitHub Releases](https://github.com/matthewcalcagno/mixer/releases), open it, and
move Mixer to Applications. The updater uses the ZIP, blockmap, and
`latest-mac.yml` assets; retain them on the release alongside the DMGs. Beta
builds use `beta-mac.yml`. Never upload only a DMG.

Unpackaged development builds do not check for updates. An ad-hoc local build is
not a production signing or update test. Verify the first release on a clean
machine or user profile: Gatekeeper accepts it, the app launches, and its bundled
daemon starts. Then publish a higher signed version and verify that checking,
downloading, quitting, installing, and relaunching work from the earlier version.
This needs two real signed versions and cannot be proven by a single local build.

Stable releases use a 36-hour linear rollout. Run **Desktop Rollout** for an
existing release with `rollout_hours=0` to admit everyone immediately, or change
the duration while retaining the original release date. Manual update checks
bypass the rollout delay. See the updater implementation for eligibility rules.

## Completion checklist

- Selected platform jobs and finalization are green.
- GitHub Release is public with the intended stable/prerelease status and notes.
- Both macOS architectures have DMG and ZIP assets and a merged channel manifest.
- Signing, notarization, first launch, and a real older-to-newer update are verified.
- Changelog entries and translations match the released version.
- Report the release link and any verification that still requires a real install.

## Release branch discipline

While you finalize a release on `main`, use a temporary `next` branch for work intended for the following
release. This applies to both beta and stable releases.

- Create each new `next` from freshly fetched `origin/main`. Reuse it while active.
- "This goes to next" means create the PR against `next` or retarget an existing
  PR, and keep that destination through delivery.
- Keep `next` current by merging `origin/main` into it as release fixes land.
  Avoid rebasing this shared branch because agents and open PRs depend on its history.
- After the release ships, bring `next` up to date and open a `next` → `main` PR.
  Pass CI and merge without squashing away the individual PR commits needed for
  the changelog. Retarget remaining PRs based on `next` to `main` and delete the integrated
  `next`. Create it fresh when needed again.

**Setup still needed:** PR checks run for every base branch, but CI, Docker, and Nix
push runs target only `main`, and GitHub permits only squash merges. Enable
required-check protection for `next`, CI on its pushes, and merge commits for the
integration PR. Handle PR
base changes (`edited` events) so retargeting runs checks against the new base;
GitHub's default PR events do not cover this. Deployment triggers stay unchanged.

### Hotfix from a release tag

If `main` contains changes you do not want to release, branch from the affected
release tag and cherry-pick only the required fixes. Run CI on that branch, then
use the normal release flow with it as the explicit source, choosing a new patch
or beta version. Ensure the fixes and changelog also reach `main` and any active
`next`, preserving newer development and version changes there. This is a
short-lived hotfix branch, not another maintained release track.

## Changelog format

Release notes depend on the changelog heading format. The heading **must** be strictly followed:

```
## X.Y.Z - YYYY-MM-DD
## X.Y.Z-beta.N - YYYY-MM-DD
```

No prefix (`v`), no extra text. `Release Notes Sync` matches the `## X.Y.Z` (or `## X.Y.Z-beta.N`) line for the pushed tag to extract the version. A malformed heading breaks the release-notes sync for that tag.

`CHANGELOG.md` on `main` is also what the app's **What's new** sheet fetches and renders, so the file is a shipped product surface, not just a release input. `##` starts a release and `###` starts a section; the app reads section titles from the document, so renaming or adding one needs no app change. Everything under a section is rendered as Markdown: prose, lists, links, inline code, fenced code, block quotes, tables, and images. Raw HTML does not render — the shared Markdown parser runs with `html: false`, so a `<video>`, `<iframe>` or `<embed>` tag reaches the reader as visible markup. Keep media out of the changelog, or link to it. A GitHub callout renders as a block quote with its `[!NOTE]` marker still in the text. A release entry is what a user reads on the desktop when they are offered the update — write it for them.

## Changelog policy

- `CHANGELOG.md` holds stable releases and at most one entry for the current beta series.
- The first beta of a version inserts a top entry like `## 0.1.60-beta.1 - YYYY-MM-DD`.
- Each subsequent beta rewrites that entry in place: the heading becomes the new beta number and date, and the body describes the full change from the previous stable release to this beta. Never add a second beta entry.
- The entry is a list of changes, not of PRs. When a later beta reverts, reworks, or follows up on something an earlier beta added, rewrite the bullet to the current behavior or delete it. A stable user never saw the earlier beta behavior, so fixes to it are not "Fixed" bullets.
- Anything that already shipped to stable through a patch release on an older line stays out of the beta entry.
- Stable promotion renames the entry to `## 0.1.60 - YYYY-MM-DD` after a final review.

Older prerelease bodies on GitHub keep the notes they were synced with; `Release Notes Sync` only writes the release whose tag matches the top entry.

## Changelog translations

`CHANGELOG.zh-CN.md` holds the Chinese notes for `paseo.sh/zh-CN/changelog`. Only the website reads it; the app's **What's new** sheet, GitHub release bodies read `CHANGELOG.md`.

- The release agent writes the Chinese entry in the changelog commit, after the English entry is approved. Every beta that rewrites the English entry rewrites the Chinese one too, and promotion renames both. `packages/website/e2e/i18n.spec.ts` fails CI on the release commit when any entry has no current translation.
- A translated entry uses the English heading unchanged: `## X.Y.Z - YYYY-MM-DD`. The website uses it only while the version and date both match the English entry. Otherwise it shows that release whole in English under a notice. Delete Chinese entries whose English entry was renamed.
- Keep the English sections, bullets and links one to one. Section titles: Added 新增, Improved 改进, Changed 变更, Fixed 修复, Security 安全, Breaking 破坏性变更, Plugins 插件, Notes 说明. Wording follows [website-i18n.md](website-i18n.md#chinese-style).

## Changelog ownership

- **The agent running the release writes the changelog entry — beta or stable.** The release context and final wording stay with that agent.
- **Commit history is only an index of the changes. Never draft the changelog from commit subjects or diffs alone.** For every PR in the release range, read the full PR description and every issue it links to before deciding what changed, why users care, or how changes should be grouped. Use the implementation only to verify the resulting understanding.
- Every entry, beta or stable, is drafted from the previous stable release to the release source. For a later beta, read the PRs since the previous beta tag, then rework the existing entry so each bullet still describes current behavior. Review the result against the changelog policy below, show it to the user, and wait for approval before committing it.

## Changelog wording

The changelog is shown on the Mixer homepage. Each bullet is a compact factual record of
product behavior that changed.

- **Name the exact change.** Prefer `Added <capability>`, `Removed <behavior>`,
  `Changed <behavior>`, or `Fixed <failure> when <condition>`.
- **Keep the scope exact.** A conditional bug is not a general reliability problem. Do not
  broaden one failure into claims that Mixer is now faster, smoother, responsive, or reliable.
- **Use concrete product and runtime terms.** Git polling, persisted cache, provider catalog,
  and WebSocket reconnects can identify the affected behavior. Component names, internal
  modules, code symbols, and implementation techniques cannot: omit `WorkingIndicator`,
  `reconcileAndEmitWorkspaceUpdates`, remounts, memoization, and controlled inputs.
- **State the consequence only when the change itself is unclear.** Keep the condition that
  makes the consequence true. Do not replace a precise change with a broad benefit claim.
- **Do not invent context.** Mention an upgrade, platform, workload, or user action only when
  the PR or linked issue establishes that scope.

| Avoid                                                        | Write                                                 |
| ------------------------------------------------------------ | ----------------------------------------------------- |
| Mixer stays responsive with many idle Git workspaces         | Removed periodic Git polling for idle workspaces      |
| Incompatible saved app data no longer crashes after upgrades | Fixed crash when persisted cache was incompatible     |
| Splitting layouts no longer remounts the active agent        | Fixed scroll position resetting when splitting a pane |
| Mobile model selector is faster and more straightforward     | Added search to the mobile model selector             |

Test each bullet against the source PR and issue: can a reviewer point to the exact behavior
that changed, the failure that was fixed, or the capability that was added? If the bullet only
claims a general improvement, rewrite it with the concrete change.

- **Use the entry's release scope.** Include changes within the matching range in **Changelog scope**.
- **Collapse internal iterations within that scope.** Present a feature added and fixed in one range as working.
- **Cut low-signal entries.** "Toolbar buttons have consistent sizing" is too granular. Combine small polish items or drop them.

## Changelog conciseness

Every bullet must be scannable at a glance. The changelog is not release documentation — it's a list.

- **One sentence per bullet, max.** If a bullet contains two sentences, the second one is doing work that belongs in product docs, not the changelog. Cut it.
- **No trailing periods.** Bullets are list items, not prose. Drop the period at the end of every bullet, including the period inside any bolded lead-in. `**Configurable terminal scrollback**` not `**Configurable terminal scrollback.**`.
- **One line per bullet.** If a bullet wraps to three lines in a narrow column, it's too long.
- **Split bullets that pack multiple distinct changes.** If a bullet uses "and", "plus", a comma list, or an em-dash to chain several independent improvements, break them into separate bullets — even when they share a theme or author. One bullet = one user-facing change.
- **Trim qualifying clauses.** Drop "with a hint shown when…", "matching the CLI's behaviour", "across common install shapes". If the detail doesn't change whether a user cares, cut it.
- **Stop after identifying the change.** Do not explain LAN/WAN topology, TLS handshakes, IPC, or other architecture in a changelog bullet. Put necessary background in product docs.
- **Attribution follows the split.** When you split a dense bullet, move each PR/author to the bullet it belongs to. Never duplicate the same PR across multiple bullets.

## Changelog attribution

Every changelog bullet must credit contributors and link to the PR(s) that delivered the change. This is not one-PR-per-line — a single bullet describes a user-facing change and may reference multiple PRs.

Format: append `([#123](https://github.com/matthewcalcagno/mixer/pull/123) by [@user](https://github.com/user))` at the end of each bullet. For changes spanning multiple PRs or contributors:

```markdown
- Voice mode now works on tablets with proper microphone permissions. ([#210](https://github.com/matthewcalcagno/mixer/pull/210), [#215](https://github.com/matthewcalcagno/mixer/pull/215) by [@alice](https://github.com/alice), [@bob](https://github.com/bob))
```

Rules:

- **Always link the PR number** as `[#N](https://github.com/matthewcalcagno/mixer/pull/N)`.
- **Always link the contributor's GitHub profile** as `[@user](https://github.com/user)`.
- **One bullet = one user-facing change**, regardless of how many PRs went into it. Group related PRs on the same bullet.
- **De-duplicate contributors.** If the same person authored multiple PRs in one bullet, list them once.
- **Only credit external contributors.** Skip attribution for [@boudra](https://github.com/boudra). The changelog credits community contributions — core team work is the default.
- **Credit the commit author, not the PR opener.** A maintainer often opens a PR that lands work authored by someone else (cherry-pick, rebase of a contributor's branch, manual extraction from a stacked PR). The squash commit preserves the original commit's author, but `gh pr view N --json author` returns the PR opener — using that field will silently mis-credit the work to the maintainer (and then the "skip @boudra" rule drops the attribution entirely). Always resolve attribution from commit authors.

  Use this command to get the GitHub logins for each PR:

  ```bash
  gh pr view N --json commits --jq '[.commits[].authors[].login] | unique | .[]'
  ```

  This returns every distinct GitHub login that authored or co-authored a commit in the PR. Use those logins for attribution. Fall back to `gh pr view N --json author` only if the commits command returns nothing (which should not happen for merged PRs).

  When listing PR numbers, `git log --format='%H %s' v<previous>..<release-source-sha> | grep -E '\(#[0-9]+\)$'` pulls the PR number out of squash commit subjects.

## Changelog ordering

Entries within each section (Added, Improved, Fixed) are ordered by user impact:

1. **User-facing features and changes first** — things users will notice, want to try, or that change their workflow.
2. **Quality-of-life improvements** — polish, performance, smoother interactions.
3. **Internal/infra changes last** — only include if they have a tangible user benefit (e.g. "faster startup" is user-facing even if the fix was internal).

## Pre-release sanity check

Before cutting a **stable** release, the release agent reviews the diff as a last line of defence against shipping bugs. Skip this for betas — the beta itself is the smoke test, and gating each beta on a code review defeats the point of using betas as fast release candidates.

Review the diff between the latest release tag and the resolved release source. Focus on:

1. **Breaking changes** — especially in the WebSocket protocol, agent lifecycle, and any server↔client contract.
2. **Backward compatibility** — the important direction is old app clients talking to newly updated daemons. Users update desktop and daemon first, then keep running the old app for a while. Flag anything that breaks old clients against new daemons or requires both sides to update in lockstep.
3. **Regressions** — anything that looks like it could break existing functionality.

Use `git diff <latest-release-tag>..<release-source-sha>` as the review input. This is a deep sanity check, not a full code review. If anything looks risky, investigate before proceeding and surface the finding to the user.

## Changelog scope

Changelog scope follows the release being described:

Every entry covers `previous stable release → release source`: first beta, later beta, direct stable release, and promotion alike. The beta entry always reads as the stable entry would if the beta were promoted today.
