# File editor

## Editor and file ownership

Electron uses Monaco in `file-panels/source/editor/view.electron.tsx`. Browser web
keeps CodeMirror, and native keeps the existing read-only source view. The editor
platform split does not change file panel registration or Explorer navigation.

`WorkspaceDocuments` owns one `FileEditorModel` per host file. Panels borrow the
buffer instead of owning its lifetime. Autosave, line endings, and conflict
handling remain in the model. Monaco never writes through Electron or opens a
local file itself, because a workspace can belong to a remote daemon. The existing
1 MiB editing limit remains. Plugin-owned diff editors are still separate buffers.

The trusted editor runs in a same-origin frame to isolate Monaco's styles and
workers from Metro and React Native Web. User file content enters only as text,
never executable HTML. Both sides validate messages and check the sending frame
and origin. The packaged protocol serves `/monaco/index.html` as its own document;
only the root `/index.html` redirects into the app router. Redirecting nested editor
HTML into the app shell leaves the hidden startup frame waiting until recovery.
Revision numbers prevent delayed host updates from replacing newer
keystrokes. The HTML preview uses a separate, untrusted-content sandbox.

## Editor preferences

App layout shortcuts take precedence while an editor has focus. Cmd+D deliberately splits a
pane instead of running Monaco's next-occurrence selection. Host-authored editor frames carry
`data-mixer-editor`; sandboxed diff frames use a validated shortcut policy without gaining
same-origin access. HTML previews never participate. Find, Save, and other editing keys stay local.

Settings → Editor stores per-client preferences, not workspace configuration. It
does not write `.vscode` files or change formatting on disk. Blank font family and
font size inherit Appearance; explicit editor overrides leave terminals and chat
unchanged. Reset restores JetBrains Mono with system fallbacks, 14.3px text, and
ligatures. Clear the font fields to inherit Appearance. Ligatures require a font
that supports them.

Apply changes to existing editor instances rather than recreating working copies.
Selection, undo, drafts, and disk conflict state must survive a preference change.
Desktop source and refactor-review editors use the same Monaco option mapping.
Browser source views use CodeMirror compartments. Hide controls whose engine does
not implement them; native source remains read-only. Indentation detection takes
precedence over the configured tab width and spaces on desktop when enabled.
Visual preference changes must not re-detect indentation in an edited buffer.

The option names and behavior follow VS Code's
[editor options](https://github.com/microsoft/vscode/blob/main/src/vs/editor/common/config/editorOptions.ts)
and [model configuration](https://github.com/microsoft/vscode/blob/main/src/vs/editor/common/services/modelService.ts).
Rainbow brackets and bracket pair guides use Monaco's native coloring, without
decorations layered over source text.

The desktop status bar follows the focused source editor. Its language picker uses
the registered grammar catalog and changes shared-document metadata, not file bytes
or the editor model. A manual mode wins over file associations; Auto Detect restores
filename and shebang detection. Associations are client preferences and never write
`.vscode` files. Language-service document ownership follows the resolved mode, even
when it differs from the filename. Switching modes must preserve text, selection,
and undo, and must stop diagnostics from the previous language service.

## Opening files and restoring work

Files and Source Control use one replaceable preview per pane. Preview titles are italic.
Editing or double-clicking a tab title keeps it open permanently; autosave must not return it
to preview state. Unsaved state alone cannot identify a preview. The shared tab owner tracks
that choice independently, and restored tabs are permanent.

Fast opens use an editor-colored blank background. Progress appears only after
200 ms, without loading text. Errors still expose Retry. Keep an editor alive
after its first Source visit when switching between Source and Preview; do not
start workers for files that have only been previewed.

For supported highlighted files, the first exposed viewport must already have
syntax colors. Registering a grammar
is not sufficient: Monaco and CodeMirror can otherwise paint text before their
idle tokenizers run. Prioritize the opening viewport before reporting ready,
including the lexical context before a restored deep-file position. Initial
navigation is immediate, not an animated scroll through untokenized lines.
Language-server startup is independent of syntax readiness, including JSON's
local worker.

Desktop Files opportunistically preloads the runtime, common grammars, CSS, and
icon font at low priority. These hints do not execute an editor or start workers.
`monaco/build.mjs` derives the hashed asset names from esbuild's module graph;
do not hard-code generated chunk names. Cold file reads and grammar setup still
take time. The first-paint contract prevents a later recolor, not all cold-start
latency. The browser test deliberately starves idle callbacks and observes actual
text colors on the first visible frame.

View state belongs to the editor view, not the working copy. Caret, selections,
scroll, and folding use Monaco's native view-state API, with an equivalent record
for CodeMirror. A fresh navigation target takes precedence over restored state.
A remembered line target on a hydrated tab must not reset the caret on reload or
each theme update. See `EditorViewSession` for that distinction.

Draft backups and view state live in the client profile's `mixer-editor`
IndexedDB database. They are separate from daemon files and are scoped by host
identity and workspace path. Clearing site data removes them. Backups coalesce
typing at 100 ms and preserve the last committed checkpoint; a process crash can
still lose edits whose transaction has not committed. Storage failures are
visible and do not stop ordinary editing or host saves.

Recovery restores a draft when you reopen its existing text file. It does not
recreate deleted host files. Recovered text never autosaves before an explicit
save decision. If the disk changed since the draft's base, use the existing
conflict controls. Saving or explicitly discarding resolves the backup. Each
working copy has its own record, and Web Locks identify live renderer owners so
one window cannot consume another live window's backup. Backup deletion also
checks the recovered record's content before removing it.

## Git history annotations

Desktop source editors use Monaco decorations, CodeLens, and Markdown hovers for
GitLens-style history. Settings → Editor → Git history controls each surface without
replacing the editor model. The reference implementations are GitLens's
[inline decorations](https://github.com/gitkraken/vscode-gitlens/blob/main/src/annotations/annotations.ts),
[CodeLens provider](https://github.com/gitkraken/vscode-gitlens/blob/main/src/codelens/codeLensProvider.ts),
and [hovers](https://github.com/gitkraken/vscode-gitlens/blob/main/src/hovers/hovers.ts).
GitLens's `plus` directories have a separate license; do not copy them into Mixer.
This integration is not a VS Code extension host and does not expose unsupported
GitKraken AI or other extensions' complexity lenses.

Git runs on the workspace host, never through Electron's local filesystem. Blame
must use the current shared buffer through `--contents`, not the saved file: inserted
or edited lines otherwise inherit another line's author. A late response cannot
replace annotations for a newer buffer or a renamed file. Cursor moves read indexed
blame results locally; do not spawn Git per cursor event. Cache identity includes
the canonical path, HEAD, and buffer contents so commits and branch changes cannot
reuse stale authorship. Local history remains usable when forge enrichment fails.
Disable repository clean/process, fsmonitor, and text-conversion helpers for these reads:
Git's `--contents` path otherwise executes configured filter commands.
PR association belongs to the [forge adapter](forge-providers.md#server).

Repository-controlled text is untrusted Markdown. Escape it and allow only the
editor's own copy and retry commands in hover links. Route commit and PR web links through the
host opener. The host resolves avatars from the forge's immutable commit author,
never an email lookup. Only bounded PNG/JPEG/WebP images from the resolved forge
host or GitHub's avatar host are accepted, without redirects. Send inline image
data to keep the editor frame's CSP unchanged and avoid renderer tracking requests.
The hover's diff preview contains only the blamed line, not neighboring hunk lines.
Let Monaco own hover heights and scroll bounds. CSS height overrides invalidate its placement
measurements, pushing long commit cards outside the editor iframe where the status bar clips
them. A higher z-index inside the iframe cannot escape that boundary.
Normal file editing does not require this feature;
`server_info.features.editorGitAnnotations` gates the read-only, workspace-scoped
Git RPCs once at the editor boundary.
An older host gets an update hint instead of new Git requests; ordinary editing stays available.

## TextMate and language services

Shiki loads TextMate grammars and Oniguruma WASM from bundled assets. Grammar
imports are lazy. Tokenization preserves each line's grammar state, including
multiline strings and comments. The token color map must retain TextMate's index
positions when passed to Monaco. Rebuilding that map through Monaco's theme rules
changes the indices and assigns the wrong colors.
Desktop editor syntax uses GitHub Dark Turbo scopes, with darker shades for light
mode. Keep these registrations syntax-only: Appearance still owns the editor
background, cursor, selection, and widget colors. Do not import the upstream
theme's UI colors or token backgrounds.
Source Control diffs use the same adapter; see [diff syntax](source-control.md#diff-syntax)
for offline packaging and regeneration.

Desktop project language services run on the selected daemon. The host bundles
TypeScript Language Server with TypeScript, and Pyright. Go (`gopls`), Rust
(`rust-analyzer`), and C/C++ (`clangd`) are discovered on the host PATH; their
toolchains are not bundled or installed when you open a file. Missing executables
produce an editor hint. Retry refreshes discovery after you install a tool.
Provider discovery requires `server_info.features.languageProviders`; older hosts
keep the existing TypeScript/Python integration. The registry, not renderer input,
owns executable paths, arguments, environment, initialization options, and settings.
Plugins can contribute [language servers](plugins.md#language-server-contributions).

Language servers
resolve project configuration, imports, and dependencies against that workspace,
including unsaved documents from its other editor tabs. Opening an editor does not
install packages or choose an executable from the repository. Language services
require `workspace.write`, because they launch host processes.
TypeScript's project process uses a 3 GiB heap ceiling, matching VS Code's default.
The language-server wrapper remains capped at 512 MiB. Do not apply that smaller
cap to the project process: dependency-heavy projects can exhaust it during the
first document request, which surfaces as a disposed JSON-RPC connection.

A source owns its language-service channels. Servers are shared by workspace and
language within that source, not across clients. Closing the last channel or losing
the connection terminates the process tree. Keep this ownership in the daemon;
Electron can be connected to a remote host and must not launch its own server.
Intentional teardown must not emit a server-failure notification. Notifications are
workspace-scoped, so a late exit from the previous process can otherwise mark its
replacement editor as failed.
The host admits at most eight active servers across physical clients and initializes
at most two concurrently. A server has 20 seconds to initialize by default; provider registrations can
raise this to five minutes for project imports before the process tree is terminated. These are admission limits, not a memory sandbox or an RSS cap.
Unloading or replacing a provider invalidates its active processes. Do not retain
an installed plugin's executable after that installation has been disabled.
Reconnect replays the open buffers before further queries. Cancellation and
document versions travel with requests, so a delayed result cannot apply an edit
to a newer buffer.
Shared buffers use incremental changes when the server negotiates incremental
synchronization; full synchronization remains available for servers that require it.
The editor uses static capabilities for type/implementation navigation, semantic
tokens, inlay hints, and folding. It does not acknowledge unsupported dynamic
registrations. File watches, configuration changes, and pull diagnostics support
dynamic registration. Dependency-library watches are read-only observations; they
do not widen workspace edit permissions. Work-done progress is shown by the editor,
with cancellation when the server offers it. Keep the declared client capabilities
aligned with implemented handlers: acknowledging an unsupported capability can
silently suppress server features.

Plugin extension declarations and initialization options are documented in the
[plugin API reference](../public-docs/plugins/reference.md#language-servers).
Virtual dependency documents stay in read-only previews; never route their URIs
through ordinary file saves. Server-specific commands remain explicit and return
workspace edits through the existing review path. Extension requests require the
`languageServerExtensions` feature on the host.

Unexpected process exits invalidate the host's channel lease. The client owns
recovery because its shared buffers contain text that has not reached disk.
Reinitialize and replay those buffers before resuming queries; never reload the
Monaco frame or replace its model to recover language services. Explicit Retry
reconnects only the language connection, preserving the editor's undo and view state.
Limit automatic recovery to five restarts in five minutes. After that, keep editing
available and require explicit Retry. Do not retry edit commands or file moves:
their effects may have completed before the response was lost.
VS Code's [`serviceStarted`](https://github.com/microsoft/vscode/blob/main/extensions/typescript-language-features/src/typescriptServiceClient.ts)
likewise reinitializes buffer synchronization after a restart. Its crash policy
distinguishes rapid failures from less frequent crashes; Mixer uses a fixed window
to bound process creation across remote workspace sessions.

Navigation opens ordinary file tabs. Reference previews read shared buffers and
remain read-only. One language-service channel owns the workspace's shared
documents, so displaying a file in another frame does not open a second LSP owner.
Do not forward iframe-local versions as shared document versions.

Rename and text-edit code actions go through a diff review over the current
buffers, including unsaved edits. Applying a review validates every buffer before
changing any buffer. Undo is grouped across affected files and remains available
after autosave. A stale frame keeps its rejected draft for copying instead of
replacing a newer shared buffer. Ordered keystrokes from the same frame can arrive
before their acknowledgements; another actor or a refactor breaks that frame's
accepted edit chain.

Explorer source-file renames review import edits and retarget open tabs. Enter a
path relative to the file's current directory in the name field to move it. The
move and its text edits share an undo entry. The destination must not exist, and its parent
directory must already exist. Pyright does not provide file-move import updates,
so Python moves are refused. Folder renames retain the Explorer's existing
behavior. Do not discard an unsupported part of a refactor and apply the rest.
Save failures keep the review open. **Open unsaved files** exposes the affected
buffers and their conflict controls, including files that had no tab before the
refactor. Applying buffers is not an atomic filesystem transaction across files.

`LanguageEditCommandSchema` is the command allowlist for both the UI and the host.
Commands return proposed text edits for review, not permission to write files.
Keep file-creating refactors, plugin configuration, dependency installation, and
arbitrary commands blocked. The bundled TypeScript server calls `ensureFile`
before some refactors, even when the client refuses `workspace/applyEdit`.
Allowing the command name without constraining its refactor arguments would bypass
review. The host captures `workspace/applyEdit` and returns `applied: false` while
the proposal awaits review. It does not claim that pending edits were applied.

This is not a VS Code extension host. Python formatting, third-party language
extensions, and Rust's language server are not bundled. Browser web retains its
CodeMirror language support. Monaco's HTML and CSS workers remain local to the
frame. JSON uses a dedicated worker with `vscode-json-languageservice`; it has no
schema download service, so file content cannot trigger external schema requests.

## VS Code source references

These source files informed the integration:

- [AbstractTextCodeEditor](https://github.com/microsoft/vscode/blob/main/src/vs/workbench/browser/parts/editor/textCodeEditor.ts)
  separates resource-owned view state from explicit editor navigation options.
- [WorkingCopyBackupTracker](https://github.com/microsoft/vscode/blob/main/src/vs/workbench/services/workingCopy/common/workingCopyBackupTracker.ts)
  tracks dirty working copies and schedules backups independently of host saves.

- [TextMateTokenizationFeature](https://github.com/microsoft/vscode/blob/main/src/vs/workbench/services/textMate/browser/textMateTokenizationFeatureImpl.ts)
  loads Oniguruma, registers token providers, and applies the theme color map.
- [TokenizationTextModelPart](https://github.com/microsoft/vscode/blob/main/src/vs/editor/common/model/tokens/tokenizationTextModelPart.ts)
  separates accurate foreground tokenization from background tokenization work.
- [TMGrammarFactory](https://github.com/microsoft/vscode/blob/main/src/vs/workbench/services/textMate/common/TMGrammarFactory.ts)
  resolves scope names, injected grammars, and embedded languages.
- [TypeScript extension](https://github.com/microsoft/vscode/blob/main/extensions/typescript-language-features/src/extension.ts)
  activates the TypeScript service separately from the editor.
- [JSON language client](https://github.com/microsoft/vscode/blob/main/extensions/json-language-features/client/src/node/jsonClientMain.ts)
  starts the JSON language server through `vscode-languageclient`.

## Build and verification

Electron's Metro configuration builds local editor assets before dev startup and
export. `monaco/build.mjs` owns that browser bundle. The generated
`packages/app/public/monaco/` directory is ignored. Runtime changes require
rebuilding those assets and reloading the editor. No CDN is used.

Desktop packaging also copies the language-server packages outside `app.asar`.
Their physical inputs include TypeScript's `.d.ts` libraries and Pyright's Python
stubs; a JavaScript-only package can start successfully but produce broken type
information. Keep the resource-path resolver and packaging copy in sync.

Run the Electron overlay's integration cases through the existing browser suite:

```bash
cd packages/app
MIXER_WEB_PLATFORM=electron npx playwright test --project=browser e2e/browser/file-editing.spec.ts --grep 'Monaco Electron'
```

This exercises the Electron renderer module in Chromium. It does not replace a
packaged Electron smoke test of asset URLs and worker startup.
