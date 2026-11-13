# Mixer Changelog

## 0.10.1 - 2026-11-13

### Added

- feat: new stuff ([626b686](https://github.com/matthewcalcagno/mixer/commit/626b6862c8fe16bfcb11a91372e5eb89ceda8343))
- feat: changes ([aedfe0f](https://github.com/matthewcalcagno/mixer/commit/aedfe0f9c475bb0937c05ebabb4bba809af0151c))

[Full Changelog](https://github.com/matthewcalcagno/mixer/compare/v0.10.0...v0.10.1)

## 0.10.0 - 2026-11-13

### Added

- feat: new stuff ([255e1ef](https://github.com/matthewcalcagno/mixer/commit/255e1efb92d3455b4275b28fa7de04f581e57778))
- feat: changes ([01b7bed](https://github.com/matthewcalcagno/mixer/commit/01b7bed69d3304739c9db559fb9afd998a9930c7))

### Fixed

- Fix Automations Ask AI and public npm installs ([a3568b5](https://github.com/matthewcalcagno/mixer/commit/a3568b595648f8a0e28a4abef21396027eb5b69f))

[Full Changelog](https://github.com/matthewcalcagno/mixer/compare/v0.9.0...v0.10.0)

## 0.9.0 - 2026-11-11

### Added

- feat: new stuff ([d2a6537](https://github.com/matthewcalcagno/mixer/commit/d2a6537eca2622f03dfca897c10b780f4990d207))

### Changed

- Simplify Source Control conflict workflow ([#48](https://github.com/matthewcalcagno/mixer/pull/48))
- Automatically reveal active files in Explorer ([#49](https://github.com/matthewcalcagno/mixer/pull/49))
- Match VS Code workbench typography and spacing ([#50](https://github.com/matthewcalcagno/mixer/pull/50))
- Align macOS traffic lights and inset the status bar ([97b8ba5](https://github.com/matthewcalcagno/mixer/commit/97b8ba5e1a524afc11597b2be233a1657669c59f))
- Brighten file Explorer labels and use medium weight ([5ba0844](https://github.com/matthewcalcagno/mixer/commit/5ba0844f09c17481c78b2ba1f2148cfc52bec90f))
- Align Search and Source Control typography with Files ([6b2cdc6](https://github.com/matthewcalcagno/mixer/commit/6b2cdc6e5ac7725522e7a359874f836ed96e68ef))
- Refine API client environments and focus active subagents ([449151a](https://github.com/matthewcalcagno/mixer/commit/449151aaddc9937989c4d70843caaa23e8da955b))

[Full Changelog](https://github.com/matthewcalcagno/mixer/compare/v0.8.0...v0.9.0)

## 0.8.0 - 2026-11-08

### Added

- Add file-tree Git decorations and native untracked-file Trash action ([#45](https://github.com/matthewcalcagno/mixer/pull/45))

### Changed

- Allow branch switching with compatible local changes ([#44](https://github.com/matthewcalcagno/mixer/pull/44))
- Use blue for modified file decorations ([#46](https://github.com/matthewcalcagno/mixer/pull/46))

### Fixed

- Fix Usage pinning and move summaries into the status bar ([#43](https://github.com/matthewcalcagno/mixer/pull/43))

[Full Changelog](https://github.com/matthewcalcagno/mixer/compare/v0.7.0...v0.8.0)

## 0.7.0 - 2026-11-07

### Changed

- Extend plugin language services for project language servers ([#40](https://github.com/matthewcalcagno/mixer/pull/40))
- Reveal Mixer promptly when startup tasks are delayed ([#41](https://github.com/matthewcalcagno/mixer/pull/41))

[Full Changelog](https://github.com/matthewcalcagno/mixer/compare/v0.6.0...v0.7.0)

## 0.6.0 - 2026-11-06

### Added

- Add API Client workspace with collections, environments, and themed editors ([#38](https://github.com/matthewcalcagno/mixer/pull/38))

### Changed

- Simplify History and custom plugin page headers ([#37](https://github.com/matthewcalcagno/mixer/pull/37))

### Removed

- Remove Schedule from the IDE, daemon, CLI, and agent tools ([#36](https://github.com/matthewcalcagno/mixer/pull/36))

[Full Changelog](https://github.com/matthewcalcagno/mixer/compare/v0.5.1...v0.6.0)

## 0.5.1 - 2026-11-04

### Removed

- Remove redundant work from desktop startup ([#34](https://github.com/matthewcalcagno/mixer/pull/34))

[Full Changelog](https://github.com/matthewcalcagno/mixer/compare/v0.5.0...v0.5.1)

## 0.5.0 - 2026-11-03

### Added

- Add reveal actions to file tabs ([#31](https://github.com/matthewcalcagno/mixer/pull/31))
- Support dragging workspace folders into chat ([#32](https://github.com/matthewcalcagno/mixer/pull/32))

[Full Changelog](https://github.com/matthewcalcagno/mixer/compare/v0.4.4...v0.5.0)

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
