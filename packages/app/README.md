# Mixer desktop renderer

This package is the Electron app's web renderer. It uses Expo Router, React Native
Web, and Unistyles. It does not contain iOS or Android application targets.

From the repository root:

```bash
npm run dev:desktop
```

For renderer-only development, start `npm run dev:server` and `npm run dev:app`
in separate terminals. Browser previews and Playwright tests exercise the renderer;
Electron bridge features require the desktop app.

Build a local desktop package with:

```bash
npm run build:desktop:local
```

Keep responsive layouts for narrow desktop windows. Do not reintroduce native
modules, device-scanning routes, mobile push delivery, or app-store build tooling.
See [development](../../docs/development.md) and [QA](../../docs/qa.md).

## Dictation debugging

Set `EXPO_PUBLIC_ENABLE_AUDIO_DEBUG=1` before starting the renderer to show the audio
debug card. Pair it with the server-side `STT_DEBUG_AUDIO_DIR` flag to include the
saved raw audio path in dictation diagnostics.
