# Third-party notices

The offline editor in `client/generated/editor-html.ts` bundles Microsoft Monaco Editor under MIT and DOMPurify under its Apache-2.0 option. License texts are included alongside the generated editor. Run `npm run build:editor` to rebuild from the pinned npm dependencies. No editor scripts or fonts are loaded from a CDN.

`client/vendor/material-file-icons.ts`, `file-icon-svg.ts`, and `color.ts` are vendored from https://github.com/getpaseo/paseo under Apache-2.0. See MIXER-LICENSE. File SVGs originate in Material Icon Theme by Philipp Kief, distributed under MIT: https://github.com/material-extensions/vscode-material-icon-theme.

The import paths are adjusted to work without importing private Mixer application modules. Run `node scripts/sync-mixer-icons.mjs /path/to/mixer` to refresh the snapshot, including `material-file-icons.generated.json` and its upstream license. Add `--check` to verify that the assets, filename mappings, and color adjustment match the checkout without writing files.

## Material Icon Theme license

The MIT License (MIT)
Copyright (c) 2025 Material Extensions

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
