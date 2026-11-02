# Mixer Changelog

## 0.2.0 - 2026-11-02

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
