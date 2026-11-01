# Workspace search

## Ownership

`plugins/search` contributes the pinned Search view between Files and Source Control.
The daemon resolves the workspace directory from its own registry. Clients never
supply an executable, shell command, or arbitrary search root. Clicking a result
uses the host's workspace-relative file navigation and existing editor lifecycle.

The plugin is enabled independently of the external-plugin switch. Existing layouts
gain Search on restoration. Like Source Control, Search stays in Explorer and cannot
be closed or moved into a workspace pane.

## VS Code references

The view follows [searchView.ts](https://github.com/microsoft/vscode/blob/main/src/vs/workbench/contrib/search/browser/searchView.ts),
[searchWidget.ts](https://github.com/microsoft/vscode/blob/main/src/vs/workbench/contrib/search/browser/searchWidget.ts),
and [searchResultsView.ts](https://github.com/microsoft/vscode/blob/main/src/vs/workbench/contrib/search/browser/searchResultsView.ts).
The input has case, word, and regex toggles, expandable include/exclude fields,
and file-grouped results. This is a React Native implementation, not a copied
VS Code workbench or extension host.

## Performance and cancellation

Search uses the pinned `@vscode/ripgrep` dependency through the server SDK. No JavaScript
filesystem walk or file-content download runs in the app. Each panel has an opaque
channel ID so replacing a query cancels only that panel's process. Cancellation includes
the request ID, so a delayed cancel cannot stop a newer query. Plugin shutdown aborts
all outstanding searches.
The daemon admits at most four concurrent searches to bound process and output-buffer costs.

Input is debounced for 150 ms. Results use a virtualized, fixed-height list.
Stale results are removed while a new query is pending. There is no disk-result cache
to invalidate when agents change files; Refresh rescans.

Positive ripgrep `--glob` filters override ignore files. When includes and ignore-file
respect are both enabled, a bounded native file listing supplies an independent allowed
scope. This preserves ripgrep's ignore semantics without implementing Git patterns in
JavaScript. The normal unfiltered search remains a single native process.

Result, output, file-size, and elapsed-time budgets bound expensive queries. The UI
reports truncation rather than presenting a partial set as complete. Non-UTF-8 paths
cannot be opened by the app and are omitted. Match byte offsets are converted to UTF-16
columns before preview highlights are rendered.

## Packaging

Electron unpacks the platform ripgrep packages so executables run outside `app.asar`.
The packaging hook verifies a binary exists for the target architecture. Universal
macOS builds need both Intel and ARM64 optional packages. Cross-architecture packaging
must install the target optional dependency; packaging fails rather than shipping a
broken Search view. Normal Node daemon installs must retain optional dependencies.

## Verification

```bash
npx vitest run plugins/search/server/search.test.ts plugins/search/client/model.test.ts --bail=1
npx vitest run packages/server/src/server/plugins/builtin/index.test.ts -t 'Search is built-in' --bail=1
npx tsx plugins/search/scripts/benchmark.ts
```

The benchmark creates 1,500 disposable source files and verifies six matches across six
runs. It reports first-run, median warm, and p95 warm engine times. File creation warms
the filesystem cache; this is not a cold-disk measurement. UI debounce, network latency,
and rendering are not included in the engine timings.

The existing Explorer browser suite covers options, filters, invalid regex, empty
results, and opening a matched line through a real daemon.
