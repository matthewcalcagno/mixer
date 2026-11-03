# Mixer Changelog

## 0.4.4 - 2026-11-03

### Changed

- Retry transient Apple ticket validation failures ([#24](https://github.com/matthewcalcagno/mixer/pull/24))
- Keep Apple ticket retries active during installer verification ([#26](https://github.com/matthewcalcagno/mixer/pull/26))

### Fixed

- Fix unsigned macOS releases and verify distributed installers ([#22](https://github.com/matthewcalcagno/mixer/pull/22))
- Fix changelog upload to draft desktop releases ([#29](https://github.com/matthewcalcagno/mixer/pull/29))
- Keep each version's changelog focused on its own changes, with concise categorized notes and version comparison links. ([#28](https://github.com/matthewcalcagno/mixer/pull/28))
- Show corrected published Mixer release history in What's new without drafts, betas, or inherited upstream entries. ([#28](https://github.com/matthewcalcagno/mixer/pull/28))

[Full Changelog](https://github.com/matthewcalcagno/mixer/compare/v0.4.0...v0.4.4)

## 0.4.0 - 2026-11-02

### Changed

- Exercise the real Electron app in renderer and plugin UI regression checks. ([#19](https://github.com/matthewcalcagno/mixer/pull/19))

### Fixed

- Prepare the native macOS update before shutting down the daemon, so update installation can complete. ([#20](https://github.com/matthewcalcagno/mixer/pull/20))

[Full Changelog](https://github.com/matthewcalcagno/mixer/compare/v0.3.1...v0.4.0)

## 0.3.1 - 2026-11-02

### Added

- Source Control actions for staging, unstaging, committing, pushing, pulling, synchronizing, and discarding changes. ([#11](https://github.com/matthewcalcagno/mixer/pull/11), [#15](https://github.com/matthewcalcagno/mixer/pull/15))
- Worktree branch selection, creation, and publishing. ([#14](https://github.com/matthewcalcagno/mixer/pull/14))
- Native Help menu with keyboard shortcuts, release notes, diagnostics, and issue links. ([#12](https://github.com/matthewcalcagno/mixer/pull/12))
- Mixer release previews and a dedicated Mixer changelog. ([#6](https://github.com/matthewcalcagno/mixer/pull/6))

### Changed

- Improved commit controls and feedback during remote operations. ([#11](https://github.com/matthewcalcagno/mixer/pull/11))
- Focused CI on desktop delivery and release verification. ([#17](https://github.com/matthewcalcagno/mixer/pull/17))

### Fixed

- Focus the Search input when opening its panel. ([#7](https://github.com/matthewcalcagno/mixer/pull/7))
- Desktop release blockers and Monaco startup. ([#4](https://github.com/matthewcalcagno/mixer/pull/4))
- Disabled subagent actions in native menus. ([#13](https://github.com/matthewcalcagno/mixer/pull/13))

[Full Changelog](https://github.com/matthewcalcagno/mixer/commits/v0.3.1)
