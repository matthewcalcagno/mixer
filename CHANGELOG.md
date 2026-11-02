# Mixer Changelog

## 0.3.1 - 2026-11-02

- feat: changes ([a9c8f99](https://github.com/matthewcalcagno/mixer/commit/a9c8f9906cca5d7637c3be94756737f3187f7a0c))

- feat: changes in source control ([3fcdea7](https://github.com/matthewcalcagno/mixer/commit/3fcdea7e0278eecfb5a4d71d0d6276678df6bc1b))

- feat: changes ([54cb1ae](https://github.com/matthewcalcagno/mixer/commit/54cb1aefa92499b82d50a9cccae55b7393738531))

- Finish app changes before release ([fb6fac7](https://github.com/matthewcalcagno/mixer/commit/fb6fac7f8729e06a7e0e4671236f205632fcb927))

- chore: update workflows ([#1](https://github.com/matthewcalcagno/mixer/pull/1))

CI fails on the migrated tests and packaging inputs, Wrangler's unexported CLI path, and an AI SDK dependency with unusable provenance metadata. The macOS file-observation runner is also in its retirement brownout.

Move native-bridge tests into the existing desktop suite, restore the plugin authoring example and server skill packaging, update the SDK export and migration documentation expectations, and repair the renamed subsequence fixture. Resolve Wrangler through its exported package manifest, use AI SDK 5.0.282 to replace the affected gateway artifact, and move the macOS job to macOS 15.

Source: [#3](https://github.com/matthewcalcagno/mixer/pull/3)

Packaged builds reject twelve bundled plugins because their manifests retain upstream 0.9–0.11 requirements while Mixer releases as 0.1.x. After signing succeeds, startup also stalls for 90 seconds: the app protocol redirects `/monaco/index.html` into the main app shell, so the editor warmup frame never boots.

Align bundled plugin requirements with Mixer >=0.1.0 while retaining external-plugin compatibility enforcement. Restrict app-entry redirects to the root `/index.html`, preserving nested HTML documents. The packaged smoke now waits for editor preparation to finish without the recovery screen. Regression tests cover all built-in plugins at the actual package version and the protocol's editor document, app-entry redirect, and SPA fallback.

Source: [#4](https://github.com/matthewcalcagno/mixer/pull/4)

### Reasoning

Selecting Search in the right panel now focuses its query input, so users can immediately type. The shared plugin input adapter honors autofocus when a retained panel becomes visible again, allowing the same workflow after switching away and back without letting hidden panels take focus.

### Goals

- Focus the Search query on opening the panel and returning from another tab.
- Preserve the query, forwarded input refs, and existing focus outlines.
- Cover immediate typing and tab switching in the existing real-daemon browser test.

### Non-goals

- Change search execution, results, or keyboard shortcuts.

Source: [#7](https://github.com/matthewcalcagno/mixer/pull/7)

Desktop releases now start only after a merged develop-to-main PR. Add a single updating preview comment to eligible open PRs, refreshed on commits (including force pushes), PR edits, labels, main updates, and publication. Preview and merge preparation share one version planner: release:major overrides release:minor, which overrides release:patch; patch is the default.

Generate notes from all included Mixer PR descriptions/release-notes sections and direct commits since the last published Mixer release. Filter empty PR templates and exclude the upstream import. Write the actual version, UTC date, and accumulated Mixer history to CHANGELOG.md in the versioned release commit; publish the same file as an asset and use it for GitHub release notes.

The IDE resolves the latest published stable Mixer tag and loads that tag's CHANGELOG.md from matthewcalcagno/mixer, rejecting upstream documents. Preserve inherited history in separate upstream archives. The privileged preview workflow runs only trusted base-branch scripts and treats PR content as data; it never checks out or executes head code.

Source: [#6](https://github.com/matthewcalcagno/mixer/pull/6)

The first develop-to-main promotion starts the preview workflow from develop, but checkout selects main's older commit, where update-release-preview.mjs does not exist. PR #8 consequently fails before generating its comment.

Check out github.workflow_sha instead, pinning the helper scripts to the exact trusted revision that supplied the workflow definition. Do not choose the PR head as the executable source. This supports the initial promotion without requiring the preview setup to land on main first.

Source: [#9](https://github.com/matthewcalcagno/mixer/pull/9)

- Add Discard All Changes beside stage-all, with confirmation and preservation of untracked files and staged changes
- Run Commit & Push directly and retain its label, spinner, and green disabled appearance until the remote step finishes
- Show the platform-specific commit shortcut and branch in the message placeholder, retain the empty Changes group while files are staged, and hide groups after the repository becomes clean

Source: [#11](https://github.com/matthewcalcagno/mixer/pull/11)

Move Help from the window's question-mark icon into the native application menu bar. Keep Keyboard shortcuts, What's new, diagnostics, issue links, and app/host version information in its submenu.

Menu actions target the focused window. Registrations are cleared on main-frame reload and window destruction, and Help remains available when compact layouts hide the titlebar. Browser previews retain the in-app popup. Electron needs a relaunch to load the main-process and preload changes.

Source Control now shows `Commit message for "<current branch>"` in the message input, or `Commit message` for detached HEAD. The commit keyboard shortcut is unchanged.

Source: [#12](https://github.com/matthewcalcagno/mixer/pull/12)

### Reasoning

Opening the subagents pill on desktop produced a native menu whose custom track rows were captured as disabled text. Register `ComposerTrackRow` with the native menu registry so subagents can be opened and finished children can be archived.

### Goals

- Register actionable track rows with their callbacks, disabled state, and destination page.
- Verify that native menu definitions enable subagent navigation and that selecting Archive finished archives a real finished child.

### Non-goals

- Change subagent lifecycle or archive eligibility.
- Include the unrelated Source Control work in the current checkout.

Source: [#13](https://github.com/matthewcalcagno/mixer/pull/13)

### Reasoning

Clicking the status-bar branch now opens the existing searchable branch selector instead of Source Control. Users can switch the active worktree's branch, create a missing branch, and publish it without leaving Mixer. Results remain visible while searches run, avoiding Loading/result flicker on each keystroke.

Creating a branch opens an Electron-native confirmation with Create branch / Cancel and an unchecked Push to origin checkbox. Source Control offers Commit for file changes, Push for outgoing commits on published branches, and Publish branch for a clean branch without an upstream.

### Goals

- Reuse the branch picker and bind all Git operations to the selected workspace directory.
- Keep the current branch marked, search beyond the initial suggestion page, and retain results during pending requests.
- Recheck branch existence before creation; preserve cancellation and existing branches.
- Optionally push a created branch to origin; show push failures while retaining the local branch.
- Publish branches with upstream tracking and preserve repository-revision checks.
- Include the branch's existing Source Control polish: commit progress feedback, discard-all, and tooltip dismissal after actions.

### Non-goals

- Change unrelated desktop menus, titlebar controls, or composer behavior. Those local edits are excluded.
- Force-push or replace branches.

Source: [#14](https://github.com/matthewcalcagno/mixer/pull/14)

- Release 0.3.0 ([#10](https://github.com/matthewcalcagno/mixer/pull/10))

### Reasoning

A clean branch with incoming commits previously showed a disabled Commit button. Outgoing commits offered Push, which could reject when the remote had advanced. Source Control now offers Pull for incoming-only changes and Sync Changes for outgoing commits, including divergent histories. Sync pulls before pushing even when the cached remote status appears current, following the [VS Code sync workflow](https://code.visualstudio.com/docs/sourcecontrol/repos-remotes).

### Goals

- Show incoming/outgoing counts, correct icons, pending feedback, and actionable errors.
- Retain Commit for changed files and Publish branch without an upstream.
- Integrate incoming changes using branch-specific rebase settings, then pull.rebase, defaulting to merge.
- Stop before pushing on conflicts, refuse dirty syncs, and retain push-only in the menu.

### Non-goals

- Force-push, discard changes, or automatically resolve conflicts.
- Run interactive rebases; these report a terminal instruction.

Source: [#15](https://github.com/matthewcalcagno/mixer/pull/15)

### Reasoning

Mixer Desktop does not require standalone web app/website/relay deployments, Docker image publishing, or Nix packaging. These inherited workflows consume runners or require unrelated infrastructure credentials. Remove those six workflows while preserving CI, packaged desktop smoke tests, merged desktop releases, installer/updater publishing, rollout control, release notes, and release preview. Runtime daemon, relay, and CLI tests remain because they support the desktop app.

An older desktop release also failed with HTTP 403 while creating its draft GitHub release despite Contents: write. Its `desktop-v...` source tag existed, but the canonical `v...` release tag did not. Publish both names atomically before release creation and use `gh release create --verify-tag` instead of asking the release API to implicitly create a tag at a detached commit. Existing tags must resolve to the intended release commit and are never overwritten. This avoids the implicit-tag creation path; a live signed release is still required to validate publishing end to end.

### Goals

- Remove Deploy App, Deploy Website, Deploy Relay, Docker, Nix, and Nix Update Hash workflows.
- Preserve all desktop delivery workflows and their dependent runtime tests.
- Verify existing canonical tags before creating releases; keep reruns idempotent and reject mismatches.
- Update CI contracts and owning docs for the reduced workflow inventory.

### Non-goals

- Remove daemon/relay/CLI code or desktop test coverage.
- Publish a release, change signing credentials, cancel running jobs, or remove existing release assets.

Source: [#17](https://github.com/matthewcalcagno/mixer/pull/17)
