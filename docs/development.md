# Development

## Desktop-only renderer

Mixer ships an Electron desktop app. `packages/app` contains its Expo/React Native Web
renderer, not an iOS/Android application. Web tooling remains for renderer development
and browser tests. Native modules, mobile build targets, device scanning, mobile push
delivery, store packaging, and simulator tooling are not supported.

Run `npm run dev:desktop` for development and `npm run build:desktop:local` for a local
desktop package. Compact layouts support narrow desktop windows; they do not imply
a mobile target. Keep the existing desktop voice, clipboard, and notification behavior.

## Local Mixer identity

This checkout builds Mixer with private `@mixer/*` workspaces. No npm publication
or ownership of the `@mixer` scope is needed. The CLI is `mixer`; configuration
files are `mixer.json` and `mixer-plugin.json`; environment variables use `MIXER_`.
New runtime state uses `~/.mixer`, or `.dev/mixer-home` for checkout development.
Existing Paseo homes, credentials, and Electron profiles are not moved or deleted.
The two products still use the same default ports, so do not start both daemons
on the same endpoint. Changing the home does not change the listening port.

Packaged builds check GitHub Releases in `matthewcalcagno/mixer` for updates;
unpackaged development builds do not. See [release.md](release.md) for signing,
notarization, publishing, and update verification. `npm run build:desktop:local`
creates a manual development install with ad-hoc signing and no hardened runtime.
Use the signed release workflow for production distribution.
Upstream hosted service endpoints and license attribution retain their original
URLs and names; the rename does not provision services or transfer accounts.
Existing WebSocket discriminants and attachment MIME types retain their wire
identities so the branding change does not break message parsing. Rebuild all
packages and renderer assets before launching Mixer; do not hot-reload the rename
into a running Paseo session. Mobile store credentials and build identities are not used.

## Prerequisites

- Node.js (see `.tool-versions` for exact version)
- npm workspaces (comes with Node)

## Running the dev server

```bash
npm run dev:server
npm run dev:app
npm run dev:desktop
```

Root checkout dev is intentionally split across terminals:

- `npm run dev:server` runs the daemon on `127.0.0.1:6768`.
- `npm run dev:app` runs Expo on `http://localhost:8081` and connects to the dev daemon.
- `npm run dev:desktop` runs its own Electron-flavored Expo server on the first free port from `8082` through `8089`. It never claims port `8081`.

Desktop dev launches its desktop-managed daemon with `MIXER_NODE_ENV=development`,
so development-only providers such as Mock Load Test are available. Packaged
desktop launches always force the daemon to production mode.

Desktop dev rebuilds the daemon stack before launch, including the copied built-in
plugin sources. Built-in plugin changes require restarting desktop dev, not only
reloading the renderer window. An already-running daemon keeps its compiled plugin
bundles until it stops.

`npm run dev` is only a shorthand for `npm run dev:server`. Keep `127.0.0.1:6767` for the packaged app and production-style `~/.mixer` state.

### Startup readiness

Electron's `ready-to-show` means a frame can be painted, not that the IDE is usable.
The window remains hidden until the renderer has applied appearance, resolved its initial
route, prepared the bundled Monaco runtime, and initialized any visible source editors.
Hidden tabs and language servers do not participate. Normal startup has no logo splash.

Keep both renderer and main-process deadlines. A renderer-only timeout cannot reveal a window
when JavaScript fails to boot. Slow or failed startup reveals recovery UI instead of leaving
an invisible process. Hidden-window rendering stays unthrottled until the first reveal.
The renderer's readiness signal is authoritative: never add a second native paint gate,
because hidden windows can withhold that event until shown. The startup deadline stays referenced
until readiness or close so an idle main process still reveals recovery UI. Delayed startup must
activate the application and focus its first revealed window, rather than opening behind its caller.
Restoring maximized geometry must also wait for readiness, because `maximize()` can show a window.

The startup bridge is preload/main-process code. Relaunch Electron to load changes; reloading
the renderer alone does not update it. Verify the window gate with:

```bash
npm run test:e2e:window-startup --workspace=@mixer/desktop
```

The focused startup/editor-restoration test lives in
`packages/app/e2e/browser/file-editing.spec.ts`.

## Nix desktop package

The flake exposes `packages.<system>.desktop` on Linux and macOS:

```bash
nix build .#desktop
```

Linux produces the `mixer-desktop` launcher and desktop entry. macOS produces
`Applications/Mixer.app` plus the `mixer-desktop` launcher. Both use the nixpkgs
Electron runtime and the checkout's built daemon, client, and renderer rather
than downloading a published desktop release.

### MIXER_HOME

`MIXER_HOME` is the directory that holds runtime state (agents, worktrees, workspace config, sockets, daemon log). Resolution rules:

- The **server itself** (e.g. when launched by the desktop app or `npm run start`) defaults to `~/.mixer` (see `packages/server/src/server/mixer-home.ts`).
- **Repo dev scripts** default to `$ROOT/.dev/mixer-home`, where `$ROOT` is the current checkout or worktree root. This keeps all dev state scoped to the checkout instead of the packaged desktop app.
- **`npm run cli -- ...`** runs through the same dev-home wrapper as the dev scripts, so the in-repo CLI automatically targets the current checkout's `.dev/mixer-home` and configured dev daemon endpoint.
- **Mixer-created worktrees** seed `$MIXER_WORKTREE_PATH/.dev/mixer-home` from `$MIXER_SOURCE_CHECKOUT_PATH/.dev/mixer-home` by copying durable JSON metadata. Runtime files like pid files, sockets, and logs are not copied.

Override knobs:

```bash
MIXER_HOME=~/.mixer-blue npm run dev          # explicit home
MIXER_DEV_SEED_HOME=/path/to/home npm run dev # seed from a different source home
MIXER_DEV_RESET_HOME=1 npm run dev            # clear and reseed the derived worktree home
```

### Daemon endpoints

- Stable daemon launched by the desktop app: `localhost:6767`.
- Root checkout dev daemon: `localhost:6768`.
- Root checkout Expo: `http://localhost:8081`.
- Root checkout desktop dev Expo: first free port from `8082` through `8089`.
- `npm run dev` (Windows): `localhost:6767` for the daemon.

In Mixer-managed worktree services, use the injected service environment rather than hardcoded root checkout ports.

### Expo Router

Route ownership and startup restore rules live in
[expo-router.md](expo-router.md). Read it before changing `packages/app/src/app`,
startup routing, remembered workspace restore, or active workspace selection.

**Gotcha — `EXPO_PUBLIC_*` is inlined into the JS bundle at Metro bundle time, not read at runtime.** Set it in the same shell that starts Metro. If the app still connects to the old daemon, Metro served a cached bundle; re-bundle clean with `cd packages/app && EXPO_PUBLIC_LOCAL_DAEMON=… npx expo start -c` and reload the app.

### Desktop renderer profiling

`npm run dev:desktop` starts Electron with Chromium remote debugging enabled so
renderer CPU profiles can be captured through CDP. By default it passes
`--remote-debugging-port=0`, so Chromium atomically asks the OS for an available
port and prints the selected DevTools endpoint. Set
`MIXER_ELECTRON_REMOTE_DEBUGGING_PORT` when a QA workflow requires a validated,
fixed port.

Desktop dev also scopes Electron `userData` to the current dev root. This prevents
desktop-only environment inherited by terminals opened inside Mixer from coupling
a new worktree instance to the parent desktop instance's profile or single-instance
lock.

The desktop workspace script `exec`s the dev runner so the terminal owns the runner
PID. Terminal shutdown reaches the runner as `SIGHUP`; the runner stops Metro and
asks Electron to quit through its normal app lifecycle. Do not add an npm wrapper or
detach Electron: either change leaves an orphan holding the worktree's single-instance
lock and broken output pipes.

With desktop dev running, verify the real BrowserWindow, titlebar clearance, fullscreen
transition, and 751-pixel settings split with:

```bash
npm run verify:electron-cdp --workspace=@mixer/desktop
```

The verifier reads the same `EXPO_PORT` and
`MIXER_ELECTRON_REMOTE_DEBUGGING_PORT` environment names as desktop dev. Set an
explicit remote-debugging port for verifier runs, and set both when testing an
isolated instance on non-default ports.

When running a dedicated Electron QA instance against a non-default Expo port, set
`EXPO_DEV_URL` explicitly. Desktop main defaults to `http://localhost:8081`, so
`MIXER_PORT=57928` alone starts Metro on 57928 but Electron still loads 8081.

### React render profiling

The app has a gated React render profiler in
`packages/app/src/utils/render-profiler.tsx`. Wrap the component boundary you want
to measure with `RenderProfile`, then open the app with `?renderProfile=1`. When
the query param is absent, `RenderProfile` returns children directly and records
nothing.

Captured samples are exposed on `globalThis.__MIXER_RENDER_PROFILE__`. Call
`globalThis.__MIXER_RESET_RENDER_PROFILE__?.()` after warm-up and before the
interaction you want to measure. If a memo comparator or subscription boundary
needs explanation, call `recordRenderProfileReasons(id, reasons)` while profiling;
reason counts are exposed on `globalThis.__MIXER_RENDER_PROFILE_REASONS__`.

Use this workflow for any render investigation:

1. Add stable `RenderProfile` boundaries around the suspected root and expensive
   children. Keep IDs specific enough to compare before and after.
2. Reproduce against real app state, not toy fixtures, whenever practical.
3. Record an idle baseline first. If idle is noisy, fix or account for that
   before optimizing the interaction.
4. Warm up the route, reset profiler samples, run the exact interaction, then
   compare `actualDuration`, render counts, and per-commit samples.
5. When a memo boundary still renders, record reasons before changing code. Do
   not guess from object identity alone.
6. Keep changes that move the measured profile. Remove probes or memo wrappers
   that do not move the number.

What this caught during the workspace tab investigation:

- A large apparent workspace cost was real interaction work, not daemon noise;
  the idle baseline stayed near zero.
- The expensive stream rerender was mostly prop identity churn from pane context
  callbacks and capability objects, not new stream data.
- Stabilizing provider actions at the pane boundary helped because every mounted
  panel consumes that context.
- Comparing value-shaped capability flags beat preserving object identity through
  unrelated stores.
- Some plausible fixes did not pay off: memoizing the tab row and composer draft
  object barely moved the profile, so they were removed.

Existing scenario script: workspace agent/terminal tab switching. Start Expo on
web, keep a daemon available, then run:

```bash
MIXER_PROFILE_SERVER_ID=<server-id> \
MIXER_PROFILE_WORKSPACE_ID=<workspace-path> \
MIXER_PROFILE_AGENT_ID=<agent-id> \
  npm run profile:workspace-tabs --workspace=@mixer/app
```

This script opens the app with `?renderProfile=1`, creates a temporary terminal
tab, switches between a real agent and that terminal, prints aggregated React
Profiler timings, then removes the temporary terminal. It is an example of the
workflow above, not the only way to use the profiler. Useful knobs:

```bash
MIXER_PROFILE_APP_URL=http://localhost:19010 # Expo web URL
MIXER_PROFILE_SWITCH_COUNT=1                # number of agent/terminal switch pairs
MIXER_PROFILE_SWITCH_WAIT_MS=250            # delay after each click
MIXER_PROFILE_IDLE_WAIT_MS=3000             # idle baseline before switching
MIXER_PROFILE_DUMP_COMMITS=1                # include per-commit profiler samples
```

For warm workspace switching, point the benchmark at an app backed by seeded
daemon state:

```bash
MIXER_PROFILE_APP_URL=http://localhost:19010 \
  npm run profile:workspace-switching --workspace=@mixer/app
```

The benchmark first warms `Cmd+1` through `Cmd+7`, then records a rapid seven-workspace
burst. It separately warms the three-entry workspace deck LRU and records `Cmd+1` through
`Cmd+3` without waits between keys. Both scenarios report keydown-to-activation latency and
React commits on the same browser clock. Set `MIXER_PROFILE_WORKSPACE_DIGITS`,
`MIXER_PROFILE_WORKSPACE_LRU_SIZE`, or `MIXER_PROFILE_WARM_QUIET_MS` to change the shape. Set
`MIXER_PROFILE_DUMP_COMMITS=1` to include the nested component breakdown for every commit.
Set `MIXER_PROFILE_RETAINED_REPEATS=5` to repeat the retained-LRU burst for a less noisy sample.
Set `MIXER_PROFILE_CPU_PATH=/tmp/workspace-switch.cpuprofile` to run a separate retained-LRU
capture after the latency scenarios and write a raw CDP CPU profile without contaminating their
timings.
Set `MIXER_PROFILE_TRACE_PATH=/tmp/workspace-switch.trace.json` to run another separate retained-LRU
capture and write a Chromium Performance trace with User Timing marks and screenshots. Open the
trace in the Chrome DevTools Performance panel. Set `MIXER_PROFILE_TRACE_INVALIDATIONS=1` only for a
focused invalidation capture; React Native's generated stacks make that mode highly intrusive.
Set `MIXER_PROFILE_TRACE_FOCUS=1` to include focus targets, durations, and JavaScript call stacks in
the scenario report. This mode wraps `HTMLElement.focus`, so use it only for diagnosis.

For the desktop Explorer sidebar toggle, run the app against the root checkout's daemon and use:

```bash
npm run profile:explorer-toggle --workspace=@mixer/app
```

The harness verifies port `6768`, opens the Mixer workspace, creates and warms the Explorer pane,
records an idle control, then measures settled and 50 ms burst Cmd+B toggles. It reports
input-to-DOM and input-to-paint latency, React commits, mounts, unmounts, and DOM mutations. Set
`MIXER_PROFILE_TRACE_PATH=/tmp/explorer-toggle.trace.json` or
`MIXER_PROFILE_CPU_PATH=/tmp/explorer-toggle.cpuprofile` for separate Chromium captures. Override
the app URL, daemon port, workspace, or server with the corresponding `MIXER_PROFILE_*` variables.

For sustained composer typing, run the paired composer-versus-textarea benchmark against a seeded
daemon:

```bash
MIXER_PROFILE_APP_URL=http://localhost:19010 \
  npm run profile:composer-typing --workspace=@mixer/app
```

The benchmark opens the first workspace, preserves its existing draft, and dispatches 300 printable
keys at a fixed 16 ms cadence without waiting for each key to paint. It measures renderer
`keydown` to the next paint opportunity, verifies that every character survived, alternates the
composer and plain-textarea control across three runs, then restores the original draft. The report
includes percentiles, frame coalescing, input processing, React work, long tasks, slow samples, and
Playwright dispatch lateness. Set `MIXER_PROFILE_TYPING_KEYS`, `MIXER_PROFILE_TYPING_CADENCE_MS`,
`MIXER_PROFILE_TYPING_REPEATS`, or `MIXER_PROFILE_WORKSPACE_DIGIT` to change the scenario. Optional
`MIXER_PROFILE_CPU_PATH` and `MIXER_PROFILE_TRACE_PATH` captures run separately after the latency
measurements so profiling overhead does not contaminate them.

For diff layout, two benchmarks share one corpus
(`packages/app/src/git/diff-document/benchmark-corpus.ts`: a real source file, a changelog with
600-character lines, generated code with ligature punctuation, and JSON). The node bench runs the
shared document model with the web and native measurers replaced by counters, so it reports how
many strings each backend would have to shape, which is the cost that survives the move to canvas
or Skia:

```bash
cd packages/app && npx vitest bench --project unit src/git/diff-document/model.bench.ts
```

The browser benchmark opens the same corpus as a working diff, toggles line wrap from the toolbar,
and reports pointer-down to painted latency, the longest main-thread task, and the `DiffDocument`
React commit time for cold and warm toggles, then scroll frame times in both modes:

```bash
cd packages/app && MIXER_DIFF_PERF_E2E=1 npx playwright test --project=browser \
  e2e/browser/diff-performance.spec.ts -g "toggling line wrap"
```

Set `MIXER_PROFILE_TYPING_SCENARIO=height-growth` to alternate `Shift+Enter` and printable input.
That report includes input and composer height changes plus React work grouped into composer,
stream, and ancestor/root scopes. Ancestor/root timings include descendant work because the Profiler
boundaries are nested. A printable key after an empty newline should not change either height.

### Preview Windows and Linux window controls on macOS

Desktop development can replace native macOS traffic lights with Mixer's custom controls:

```bash
MIXER_DESKTOP_WINDOW_CONTROLS=windows npm run dev:desktop
MIXER_DESKTOP_WINDOW_CONTROLS=linux npm run dev:desktop
```

The override is rejected in packaged builds. Restart the desktop process when changing it.

### Desktop macOS compositor watchdog

macOS display sleep can leave Chromium's GPU-process display link — the vsync
source that drives frame production — stuck on a stale display. The compositor
then stops producing frames and the window looks frozen: unresponsive to clicks
and keys even though the renderer and every process stay alive. It self-recovers
after a few minutes, which is too long for a foreground app.

`setupDarwinCompositorWatchdog`
(`packages/desktop/src/window/compositor-watchdog/index.ts`) guards against
this. It polls the renderer for frame production every couple of seconds and,
after a sustained stall while the window is visible and unlocked, restarts the
GPU process so Chromium rebuilds the display link. The probe is skipped while
the screen is locked or the window is hidden or minimized, since a window
legitimately stops producing frames then.

The watchdog deliberately leaves background throttling **enabled**. Calling
`webContents.setBackgroundThrottling(false)` would keep the compositor producing
frames non-stop, pinning ProMotion displays at 120Hz forever and draining the
battery while the app is idle — so do not re-add it. The probe's visibility
guards already prevent throttling from causing a false stall.

### Desktop Linux hidden-window fallback

On Wayland (seen on ChromeOS Linux) a window created with `show: false` can sit
forever without a single compositor frame: the renderer loads and runs, but
`ready-to-show` never fires, so the window is never shown and the app looks like
it did not start while every process is alive. `showWindowWhenReady`
(`packages/desktop/src/window/show-when-ready.ts`) shows the main window when
the document finishes loading if the event has not arrived. The fallback is
Linux-only; macOS and Windows keep waiting for `ready-to-show`.

Run the startup regression on Linux with an isolated display:

```bash
xvfb-run -a npm run test:e2e:window-startup --workspace=@mixer/desktop
```

### Daemon logs

Check `$MIXER_HOME/daemon.log` for daemon logs. The default level is `info`; set
`MIXER_LOG_LEVEL=trace` before launching the daemon when you need full provider,
session, and agent-manager traces for stuck-state debugging.

The supervisor rotates `daemon.log`. Persisted `log.file.rotate` settings in
`$MIXER_HOME/config.json` win first. Without persisted config, the optional
`MIXER_LOG_ROTATE_SIZE` and `MIXER_LOG_ROTATE_COUNT` env vars override the
defaults. The default rotation is `10m` x `3` files everywhere.

### Git process pressure

If Git refreshes consume too much CPU, disk, or antivirus capacity, especially on Windows, reduce
the daemon-global Git process limits in `$MIXER_HOME/config.json`:

```json
{
  "daemon": {
    "git": {
      "maxProcessesPerSecond": 5,
      "maxProcessConcurrency": 4
    }
  }
}
```

Reload the daemon with `mixer reload`. Environment-variable overrides still require a restart because
the launch environment remains authoritative. Lower values reduce machine pressure but make Git-backed workspace state and
Git RPCs wait longer. See [Git process limits](data-model.md#git-process-limits) for defaults,
semantics, and environment-variable overrides.

### Agent Tool Catalog Measurement

Measure the MCP `tools/list` payload that Mixer injects into agents with:

```bash
npm run measure:agent-tools --workspace=@mixer/server
```

The command reports compact JSON bytes, estimated tokens, field totals, largest
tools, and the browser-tools delta. It defaults to the agent-scoped catalog; use
`-- --scope=top-level` for the unaffiliated `/mcp/agents` shape and `-- --json`
for machine-readable output.

## Worktree starting refs

A new worktree starts from the current branch's upstream, or the local branch when it has no
upstream. This keeps unpushed local commits out of new workspaces by default. The picker collapses
identical refs; divergent local or non-origin refs remain explicit, qualified choices.

The daemon sends the exact upstream ref because the remote and branch names cannot be inferred.
Worktrees retain that ref for comparisons and updates from base while exposing its branch name to
the UI. Merging into base requires a mutable local target: `origin/main` maps to local `main`, while
another remote fails closed until the worktree records an explicit local target. Older daemons omit
the optional field and retain the previous local-first behavior; older worktree metadata without the
exact ref also resolves through its stored branch name.

Worktrees inherit committed Git state only; uncommitted source-checkout changes are not copied.

## mixer.json service scripts

`worktree.setup` and `worktree.teardown` accept either a multiline shell script or an array
of commands. Both run sequentially.

Lifecycle commands run in the worktree through a stable script shell: `bash`
resolved from `PATH` on macOS/Linux, and PowerShell with `-NoProfile` on
Windows. They inherit the daemon environment plus Mixer's lifecycle variables;
login and interactive shell startup files are not loaded, and Bash's `BASH_ENV`
hook is unset. ACP single-string terminal commands use the same non-login Bash
behavior on macOS/Linux, but preserve their existing `cmd.exe /c` string semantics
on Windows. Service scripts are separate:
they launch in a terminal and receive the service environment described below.

Because the shell differs per platform, a lifecycle command that must run
everywhere cannot use POSIX-only syntax — `VAR=1 cmd` env prefixes, `$VAR`
expansion, `cp`/`rm`, or a `./scripts/*.sh` entrypoint all fail under PowerShell,
and `bash` is not guaranteed to exist on Windows. Put that logic in a Node script
that reads what it needs from `process.env` and invoke it as
`node ./scripts/<name>.mjs`. This repo's own setup does exactly that in
`scripts/seed-worktree-dev-state.mjs`.

```json
{
  "worktree": {
    "setup": "npm ci\ncp \"$MIXER_SOURCE_CHECKOUT_PATH/.env\" .env\nnpm run db:migrate",
    "teardown": "npm run db:drop || true"
  }
}
```

Every `scripts` entry with `"type": "service"` receives these environment variables:

| Variable                    | Value                                                                                                                     |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `MIXER_SERVICE_<NAME>_URL`  | Proxied URL for a declared peer service. Prefer this for peer discovery; it survives peer restarts.                       |
| `MIXER_SERVICE_<NAME>_PORT` | Raw ephemeral port for a declared peer service. Use only as a bypass escape hatch; it can go stale if that peer restarts. |
| `MIXER_URL`                 | Self alias for `MIXER_SERVICE_<SELF>_URL`.                                                                                |
| `MIXER_PORT`                | Self alias for `MIXER_SERVICE_<SELF>_PORT`.                                                                               |
| `HOST`                      | Bind host for the service process.                                                                                        |

Service proxy hostnames use the double-dash shape: `web--feature-auth--project.localhost` or, on the default branch, `web--project.localhost`. Optional public aliases use the same leftmost label under the configured public base host.

`<NAME>` is normalized from the script name by uppercasing it, replacing each run of non-`A-Z0-9` characters with `_`, and trimming leading or trailing `_`. For example, `app-server` and `app.server` both normalize to `APP_SERVER`; that collision fails at spawn time with an actionable error.

`PORT` is not injected by default. If a framework requires `PORT`, set it in the command:

```json
{
  "scripts": {
    "web": {
      "type": "service",
      "command": "PORT=$MIXER_PORT npm run dev:web"
    }
  }
}
```

Service ports use OS ephemeral allocation by default. Set `worktrees.servicePorts` in
`$MIXER_HOME/config.json`, or replace it for one project with `worktree.servicePorts` in
`mixer.json`. The block accepts an inclusive `range` such as `"3000-4000"` or a `portScript`
executable. Since `portScript` is executed directly without a shell, it must point to a real executable (e.g., a binary or a script with a proper shebang like `#!/bin/sh`) rather than an inline shell command or shell pipeline. For inline shell commands or pipelines, wrap them in a small script. `portScript` runs in the workspace directory with four arguments: service name,
workspace ID, branch name, and worktree path. A missing branch is passed as an empty string. The same
values are available as `MIXER_SCRIPTNAME`, `MIXER_WORKSPACE_ID`, `MIXER_BRANCH_NAME`, and
`MIXER_WORKTREE_PATH`. The script must print one valid TCP port. Mixer trusts the external allocator,
so the port may already be bound. `portScript` takes precedence when both values are present.

## Bundled daemon web UI

> The user-facing guide for this feature (enabling it, reverse proxy, TLS, tunnels, security) lives at [public-docs/web-ui.md](../public-docs/web-ui.md). This section is the contributor/build reference: how the artifact is produced, bundled, and excluded from desktop packaging.

The daemon can optionally serve the browser web client from the same HTTP server. This is disabled by default.

Enable it in persistent configuration:

```bash
mixer daemon config set features.webUi.enabled true
mixer daemon start
```

Or set the environment variable:

```bash
MIXER_WEB_UI_ENABLED=true mixer daemon run
```

Or persist it in `config.json`:

```json
{
  "features": {
    "webUi": {
      "enabled": true
    }
  }
}
```

When enabled, opening the daemon HTTP origin (for example `http://localhost:6767/`) serves the web app. The same HTTP server continues to serve `/api/*`, `/mcp/*`, `/public/*`, the WebSocket upgrade, and service-proxy routes. Static files load without daemon bearer auth; API and WebSocket calls still enforce auth.

The served app auto-bootstraps a connection to the same origin, so opening `http://localhost:6767/` directly usually skips the Add Host step.

Build the artifact for packaging or measurement with:

```bash
npm run build:daemon-web-ui
```

This exports the normal browser web app (not the Electron-flavored desktop renderer) and copies it into `packages/server/dist/server/web-ui`, precompressing `.html`, `.js`, `.css`, and JSON assets as `.br` and `.gz`.

Measured bundle size for a standard Expo web export:

- raw: 10.77 MiB
- gzip: 2.55 MiB
- brotli: 1.93 MiB

The desktop-managed daemon disables the bundled web UI by default (`MIXER_WEB_UI_ENABLED=false`) because the desktop app already ships the renderer as `app-dist`. Shipping the same assets again inside `@mixer/server` would duplicate the ~10.8 MiB install. Desktop packaging also excludes `node_modules/@mixer/server/dist/server/web-ui/**` from the packaged app.

## Built workspace packages

Package imports resolve through package exports to compiled `dist/` output, not sibling `src/` files. This is true in local dev and in published packages: the app, daemon, CLI, and SDK consumers should all exercise the same runtime paths.

`npm run dev:server` builds the server-side workspace packages once, then keeps `@mixer/protocol` and `@mixer/client` fresh with TypeScript watch builds while the daemon runs. If you change protocol schemas or client code outside that watch workflow, rebuild the producer before trusting runtime behavior.

Use the named root build targets instead of remembering workspace dependency chains:

```bash
npm run build:client       # protocol -> client
npm run build:server-deps  # highlight -> relay -> protocol -> client
npm run build:server       # server-deps -> server -> cli
npm run build:app-deps     # highlight -> protocol -> client -> expo-two-way-audio
```

Use `npm run build:server` whenever you have changed any daemon/server-facing package and need clean cross-package types or runtime behavior.

The app Metro config disables Watchman and uses Metro's node crawler for exports. Keep that invariant unless you have verified production app exports on machines with and without Watchman installed; distro Watchman builds can differ in capabilities and change Metro's crawl behavior.

For tighter loops, you can rebuild a single workspace:

- Changed `packages/protocol/src/*` or `packages/client/src/*`: `npm run build:client`.
- Changed `packages/server/src/*`, `packages/cli/src/*`, `packages/relay/src/*`, or `packages/highlight/src/*`: `npm run build:server`.
- Changed app build dependencies: `npm run build:app-deps`.

## Dependency patches

`patches/*.patch` are applied by `scripts/postinstall-patches.mjs` on every install. A patch only
runs when its package is actually present, so add the package to that script's `patchedPackages`
list when you introduce a new patch — otherwise the file sits in `patches/` and never applies.
patch-package cannot apply a patch that changed after an earlier version was applied, so the
script removes that package and fails the install; the next `npm install` reinstalls it clean
with the current patch. Regenerate a patch with `npx patch-package <package>` after editing `node_modules/<package>`, and
patch every build the consumers use: Metro resolves the `react-native` field of a package
(`src/*.ts` for `react-native-svg`), while Node and Vitest resolve `main`/`module`
(`lib/commonjs`, `lib/module`). Patching only `lib/` leaves the app bundle unfixed.

## Dependency overrides and workspace tooling

Root `package.json` `overrides` pin one Expo SDK across the tree (`expo`, `expo-router`,
`react-native`, …). npm does not apply those overrides to packages it places under a
workspace's own `node_modules`. When `expo-module-scripts` was declared in
`packages/expo-two-way-audio`, npm nested it there and its `jest-expo` peer `expo@*` resolved to
a second, newer Expo SDK and React Native: 200+ duplicate packages nothing imported (#7730).
Declare tooling that peer-depends on `expo` or `react-native` in the root `devDependencies`,
where the overrides apply; workspace scripts still find the binary through the root
`node_modules/.bin`.

## Dependency signature audit

The `quality` CI job runs `npm audit signatures`. It verifies every lockfile package's registry
signature and, for packages published with provenance, fetches
`/-/npm/v1/attestations/<name>@<version>` from the registry. Cloudflare caches that document
for a year. An edge that cached it in the seconds before the registry attached the publish
attestation keeps serving a document with only the provenance bundle, and npm fails with:

```
npm error code EMISSINGSIGNATUREKEY
npm error <name>@<version> has attestations but no corresponding public key(s) can be found
```

The same package's registry signature verified a moment earlier with the same keys, so the
key list is intact. The failure names one package, repeats only for that package, and depends
on the Azure region the runner landed in, because each region maps to one Cloudflare colo. A
rerun passes only by landing elsewhere.

To confirm, fetch the URL from several runners and compare `content-length`, the `cf-ray` colo
suffix, and the number of `attestations` entries (#7730 has the probe). To fix, remove or
replace that version in the lockfile and report the URL to npm so they purge it.

## ACP provider catalog versions

The in-app ACP provider catalog pins package-runner entries (`npx`, `npm exec`,
and `uvx`) to exact package versions. Run the drift checker regularly — and
before releases — so catalog installs do not sit on stale agent versions:

```bash
npm run acp:version-drift        # report stale/non-exact package pins
npm run acp:version-drift:check  # same, exits non-zero on drift
npm run acp:version-drift:update # rewrite catalog pins to latest exact versions
```

The checker updates only package-runner catalog entries. Providers that use a
preinstalled binary such as `opencode acp`, `cursor-agent acp`, or `goose acp`
are reported as skipped because their versions are owned by the user's local
install.

## CLI reference

Use `npm run cli` to run the in-repo CLI from source (`npx tsx packages/cli/src/index.ts`). The script wraps the CLI with `scripts/dev-home.sh`, so it automatically uses this checkout's `.dev/mixer-home` and dev daemon endpoint unless you pass an explicit override. The globally installed `mixer` binary on macOS is a symlink into the installed Mixer desktop app, not this checkout — use it to drive the desktop's built-in daemon, but use `npm run cli` when you want to talk to the CLI you are editing.

Canonical automation uses `mixer project create/ls/rename/delete`, `mixer workspace create/ls/rename/archive`, `mixer heartbeat create/update/delete`, and the full `mixer schedule` group. MCP heartbeat automation is intentionally smaller: create and delete only. Detach remains an explicit user lifecycle action rather than an agent tool. `mixer run --new-workspace local|worktree` composes workspace creation with agent creation. The old `mixer worktree` and `mixer run --worktree` forms are hidden compatibility aliases.

```bash
npm run cli -- ls -a -g              # List all agents globally
npm run cli -- ls -a -g --json       # Same, as JSON
npm run cli -- inspect <id>          # Show detailed agent info
npm run cli -- logs <id>             # View agent timeline
npm run cli -- agent open <id>       # Focus an existing agent in Mixer Desktop
npm run cli -- daemon status         # Check daemon status
npm run cli -- clone owner/repo --dir ~/workspace # Clone GitHub repo and register project
```

Use the global `--host` option to point the CLI at a different daemon:

```bash
npm run cli -- --host localhost:7777 ls -a
npm run cli -- --host ssh://user@host ls -a
```

Set `MIXER_HOST` to use the same target across invocations. An explicit
selector overrides both environment selectors. With both `MIXER_HOME` and `MIXER_HOST` set, pass an explicit selector. See [CLI target selection](../public-docs/cli.md#select-one-daemon).

In an SSH URI, the URL port is the SSH server port. The remote daemon defaults to `127.0.0.1:6767`; use `?daemonPort=7777` to override it. The transport runs non-interactively through the local OpenSSH client and never installs, starts, or configures the remote daemon. User-facing setup and troubleshooting live in [public-docs/connectivity.md](../public-docs/connectivity.md#ssh).

Desktop integrations can focus an existing agent without creating one or
sending a message. Use `mixer://h/<server-id>/agent/<agent-id>`, or run
`mixer agent open <agent-id>`. The CLI reads the local daemon's server ID by
default; pass `--server <server-id>` when targeting another server.

## Agent state

Agent data lives at:

```
$MIXER_HOME/agents/{cwd-with-dashes}/{agent-id}.json
```

Find an agent by ID:

```bash
find $MIXER_HOME/agents -name "{agent-id}.json"
```

Find by content:

```bash
rg -l "some title text" $MIXER_HOME/agents/
```

## Provider session files

Get the session ID from the agent JSON (`persistence.sessionId`), then:

**Claude:**

```
~/.claude/projects/{cwd-with-dashes}/{session-id}.jsonl
```

**Codex:**

```
~/.codex/sessions/{YYYY}/{MM}/{DD}/rollout-{timestamp}-{session-id}.jsonl
```

## Testing with Playwright MCP

Point Playwright MCP at the running Expo web target. For root checkout dev, `npm run dev:app` reserves `http://localhost:8081`. For Mixer-managed worktree app services, use the service URL or port shown by Mixer for that worktree.

Do NOT use browser history (back/forward). Always navigate by clicking UI elements or using `browser_navigate` with the full URL — the app uses client-side routing and browser history breaks state.

## App web deploys

`packages/app` exports a single-page Expo web app and deploys the `dist/`
directory to Cloudflare Pages with `npm run deploy:web --workspace=@mixer/app`.

PWA install metadata lives in `packages/app/public/manifest.json` and is linked
from `packages/app/public/index.html`. Keep the install icons in `public/` so
Cloudflare serves them from stable root URLs after `expo export`. Keep transparent
icons marked `any`; the separate opaque `maskable` icon needs safe padding because
installers can crop it. Desktop icon transparency does not request an OS background.

Do not add service-worker caching casually. Mixer is a live control surface for
agents, and an aggressive service worker can strand installed users on stale web
code. If offline behavior becomes a product requirement, add it deliberately
with an update strategy and test the installed-app upgrade path.

## Expo troubleshooting

```bash
npx expo-doctor
```

Diagnoses version mismatches and native module issues.

## Typecheck

Always run typecheck after changes:

```bash
npm run typecheck
```
