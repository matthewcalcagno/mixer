# Source Control

`plugins/source-control` is the fork-owned implementation. It started from the existing
standalone plugin without changing the source directory. Its RPC handlers run on the
workspace's daemon, so a remote workspace never uses the Electron machine's Git checkout.

The built-in registry publishes the panel even when external plugins are disabled.
An old directory installation with the same ID cannot shadow or stop the built-in.
Do not install an additional `source-control` plugin over it.

## VS Code comparison

VS Code's SCM workbench is a provider UI. Git-specific operations live in the Git
extension, not in the SCM view itself. This fork keeps its Git operations and plugin
RPCs rather than copying VS Code's workbench services or extension-host dependencies.

The implementation follows these upstream behaviors:

- [scmViewPane.ts](https://github.com/microsoft/vscode/blob/main/src/vs/workbench/contrib/scm/browser/scmViewPane.ts): list and tree presentation, path/name/status sorting, resource groups, folder actions.
- [menus.ts](https://github.com/microsoft/vscode/blob/main/src/vs/workbench/contrib/scm/browser/menus.ts): separate view, group, folder, and resource actions.
- [scmInput.ts](https://github.com/microsoft/vscode/blob/main/src/vs/workbench/contrib/scm/browser/scmInput.ts): scoped accept-input shortcut and multiline commit input.
- [scm.css](https://github.com/microsoft/vscode/blob/main/src/vs/workbench/contrib/scm/browser/media/scm.css): compact rows, hover/focus actions, collapsible groups, and count badges.
- [Git commands](https://github.com/microsoft/vscode/blob/main/extensions/git/src/commands.ts): separate merge resources, explicit staging, and tracked-only destructive actions.

Filtering is an adaptation of the workbench's tree-find behavior. It never changes group-wide
action scope. Folder actions on a filtered tree explicitly say "matching files".

## Untracked files

Untracked rows offer **Move to Trash** through the same discard arrow. Confirmation uses
Electron's native warning dialog. Files go to the local operating system Trash/Recycle Bin;
remote hosts are rejected rather than falling back to permanent deletion. Ordinary discard
and group discard remain tracked-only. New desktop bridge methods require relaunching Mixer.

## Branch selection

Click the status bar's branch to open the shared searchable branch picker. Git operations
use the active workspace directory, so a linked worktree switches independently of the
main checkout. Search runs on the host rather than filtering only the first suggestion page. A name
that is absent from the host results can be created from the current branch. Creation
never replaces an existing branch and leaves the new branch without an upstream.
Branch switches and creation use normal Git checkout semantics: compatible staged,
unstaged, and untracked changes carry across. A dirty status alone must not block
checkout. Offer Stash & Switch only after Git refuses to overwrite local changes;
never force checkout or stash automatically. Checkout commands use the C locale
because the client recognizes Git's overwrite refusal in the error response.

A clean branch without an upstream offers **Publish branch**. Publishing sets its upstream
on `origin`, or the sole configured remote. Changes keep **Commit** available; an existing
upstream with outgoing commits offers **Sync Changes**, which pulls before pushing,
even when the last fetched status shows no incoming commits. Sync honors branch-specific
rebase settings before `pull.rebase`, defaults to merge, and stops before pushing if
integration fails. A clean checkout with only incoming commits offers fast-forward-only
**Pull**. Push-only remains in the action menu.

## File selection

The open diff and resource selection are separate. A plain click selects one row and opens its
diff. Cmd/Ctrl-click toggles rows; Shift-click selects a range in rendered order. Arrow keys move
focus, Shift-arrow extends the range, Cmd/Ctrl+A selects visible rows, Space toggles a row, and
Escape clears selection. Selected rows are highlighted without checkboxes or a selection toolbar.

Row actions use the current selection when the clicked row belongs to it, otherwise only that
row. Right-click preserves an existing selection, or selects only the clicked unselected row,
then exposes the compatible stage, unstage, and tracked-file discard actions. Desktop uses the
host's [native context menu](menus.md#desktop-context-menus). A path
that appears in both Staged Changes and Changes has two independent selection identities.
Filtering removes hidden rows from selection; refresh removes entries that left their group.
Select-all excludes collapsed descendants. Group-wide actions retain their full-group scope.
Failed mutations preserve selection while repository status rolls back.

## Commit controls

The Changes header places Discard All Changes immediately before Stage All Changes.
Discard targets tracked worktree changes and preserves untracked files and the index.

Ordinary commit, push, and Commit & Push run directly. Keep confirmation for
amending history, synchronization that pulls changes, aborting a Git operation,
and destructive discard. During a combined operation the primary button retains
the selected label and busy state through the remote step. Clear the message only
after Git commits successfully; a failed push offers Push without restoring the
already-committed message. Keep the empty Changes group while staged files exist,
then hide resource groups when the repository becomes clean.

## Safety and ownership

The index/worktree status pair defines conflicts. Checking a single letter misclassifies
`AA`, `DD`, and other unmerged entries as staged files. Both the UI and commit handler
reject commits with unmerged entries. Ordinary stage-all skips Merge Changes.

`server/action.ts` validates repository revisions before mutation. Destructive operations
keep confirmations and refuse untracked deletion. Existing Git hooks run normally.
The imported diff renderer is sandboxed and receives file contents as editor text.
Diff tabs use the host's [shared preview lifecycle](file-editor.md#opening-files-and-restoring-work),
so switching between Files and Source Control does not create independent replaceable slots.

Material assets are synchronized from Files through
`node plugins/source-control/scripts/sync-mixer-icons.mjs "$PWD"`.
Add `--check` to verify the snapshot. Do not edit the vendored SVG table.

## Diff syntax

The offline diff iframe shares the normal desktop file editor's TextMate adapter,
Dark+/Light+ themes, Oniguruma engine, and filename-to-grammar selection. Do not
replace it with Monaco's default tokenizers or approximate the colors with theme
rules. TSX and JSX require their own grammars, not the plain TS/JS grammar.
`useEditorSyntaxOptions` carries the host's bracket-color preference into the
iframe; model-level bracket decorations must not override a disabled setting.

Dark diff highlights follow GitHub Dark Turbo, the VS Code reference theme: its text
highlight overrides are layered over VS Code's default line backgrounds. Comparing only
the default VS Code tokens misses those overrides and produces a yellow-green result.
Keep gutters transparent. Light mode retains the default VS Code diff colors.

`scripts/build-editor.mjs` embeds the grammar registry as individually compressed,
deduplicated JSON grammars. Opening a diff decompresses only its language and
embedded dependencies. No grammar fetch or external connection is allowed from
the sandbox. The iframe stays hidden until its opening viewport has syntax tokens.

After changing the shared adapter or upgrading Monaco/Shiki, regenerate the offline
iframe before rebuilding the server's built-in plugin copy:

```bash
node plugins/source-control/scripts/build-editor.mjs
node plugins/source-control/scripts/test-editor.mjs
npm run build:server
```

Changing a built-in client bundle requires the development daemon to restart;
reloading the app window alone does not replace a bundle cached by that daemon.

## Verification

Run only the relevant existing test files:

```bash
npx vitest run plugins/source-control/tests/git.test.ts --bail=1
npx vitest run plugins/source-control/tests/syntax-assets.test.mjs --bail=1
npx vitest run packages/server/src/server/plugins/builtin/index.test.ts --bail=1
node plugins/source-control/scripts/test-sidebar.mjs
```

The Git cases use disposable repositories and a local bare remote. Built-in lifecycle tests
use a real daemon. The sidebar fixture renders the actual client in Chromium but substitutes
RPC responses and icons; it does not prove a connected Electron workflow.

### Interrupted Git operations

Read operation metadata from the worktree Git directory, including Git’s prepared
commit message. Preserve edits to that message across status refreshes. During a
merge, rebase, cherry-pick, or revert, use Continue as the primary action and keep
unresolved files in Merge Changes. Stage resolved files directly; reject remaining
conflict markers. Open conflicted files in the editable source editor.

Expected conflicts belong in the file list, without a second error banner. Show
other failures as a short summary with expandable technical details. Keep Abort
available as an icon action with confirmation. This follows the upstream
[VS Code Git action button](https://github.com/microsoft/vscode/blob/main/extensions/git/src/actionButton.ts)
and its use of Git’s prepared message.
