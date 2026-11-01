# File icons

The explorer uses SVGs and default associations from
[`material-icon-theme`](https://github.com/material-extensions/vscode-material-icon-theme).
The package is a dev dependency of `packages/app`. Its SVGs are bundled locally so
icons work offline on native, browser, and Electron builds without the VS Code extension.

## Updating the theme

After updating Material Icon Theme or Monaco, run:

```bash
node scripts/generate-material-file-icons.mjs
npm run format:files -- packages/app/src/components/material-file-icons.generated.json
npx vitest run packages/app/src/components/file-icon-svg.test.ts --bail=1
```

Commit the generated JSON and adjacent upstream license. Do not edit the generated
assets or maintain a separate list of supported extensions. The generator reads every
icon definition and association from the installed package and fails on missing assets.

## Rendering

Use `MaterialFileIcon` or `MaterialFolderIcon`. Pass a file path when available so
parent-directory filename associations can match. The resolver supports exact filenames,
dotfiles, longest matching compound extensions, and named open/closed folders.
Unknown entries use the theme's generic file or folder icon. Explorer chevrons remain
separate from folder icons so expansion and loading indicators stay visible.

See [Explorer spacing](design.md#7-density-and-rhythm) for row and indentation geometry.

The explorer uses the default theme associations. The generator also reads Monaco's
language registrations to resolve language-only icons from filenames and extensions.
Explicit theme associations win over these language defaults, including compound
extensions such as `.test.ts`. No Monaco runtime is loaded for icon lookup.

All theme SVGs are bundled. VS Code extensions can add language detection rules that
Monaco does not provide; installing those extensions or user-configured icon packs
does not change Mixer's associations.

`file-icon-svg.ts` tones the vendor colours down because icons share rows with status
dots and diff stats. `ICON_CHROMA` is the single adjustment. Keep upstream SVGs unchanged
and do not add per-icon colour overrides.
