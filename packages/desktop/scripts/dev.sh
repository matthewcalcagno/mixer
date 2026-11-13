#!/usr/bin/env bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DESKTOP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ROOT_DIR="$(cd "$DESKTOP_DIR/../.." && pwd)"

# Resolve Node before spawning npm, Metro, or the dev runner.
NODE_VERSION="$(awk '$1 == "nodejs" { print $2; exit }' "$ROOT_DIR/.tool-versions")"
if [ "$(node -p 'process.versions.node')" != "$NODE_VERSION" ] && command -v fnm >/dev/null 2>&1; then
  exec fnm exec --using="$NODE_VERSION" bash "$SCRIPT_DIR/dev.sh" "$@"
fi

source "$ROOT_DIR/scripts/dev-home.sh"

export PATH="$ROOT_DIR/node_modules/.bin:$PATH"
export MIXER_LISTEN="${MIXER_LISTEN:-127.0.0.1:6768}"
configure_dev_mixer_home

DEV_ROOT="${MIXER_DEV_ROOT:-$(default_dev_mixer_root)}"
export MIXER_DEV_ROOT="$DEV_ROOT"
export MIXER_DEV_RUNTIME_FALLBACK_ROOT="$DEV_ROOT"
DEV_RUNTIME="$(node "$SCRIPT_DIR/dev-runtime.mjs")"
export MIXER_ELECTRON_FLAGS="$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).electronFlags)' "$DEV_RUNTIME")"
export MIXER_ELECTRON_USER_DATA_DIR="$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).userDataDir)' "$DEV_RUNTIME")"
unset MIXER_DEV_RUNTIME_FALLBACK_ROOT
mkdir -p "$MIXER_ELECTRON_USER_DATA_DIR"

if [ -z "${EXPO_PORT:-}" ]; then
  EXPO_PORT=$(NO_COLOR=1 FORCE_COLOR=0 "$ROOT_DIR/node_modules/.bin/get-port" 8082 8083 8084 8085 8086 8087 8088 8089)
fi
export EXPO_PORT
export EXPO_DEV_URL="http://localhost:${EXPO_PORT}"

DAEMON_ENDPOINT="$(resolve_dev_daemon_endpoint)"
export MIXER_DAEMON_ENDPOINT="$DAEMON_ENDPOINT"

export MIXER_CORS_ORIGINS="${MIXER_CORS_ORIGINS:-*}"

# Electron runs the built daemon, including its copied built-in plugin sources.
npm --prefix "$ROOT_DIR" run build:server
npm --prefix "$DESKTOP_DIR" run build:main

echo "══════════════════════════════════════════════════════"
echo "  Mixer Desktop Dev"
echo "══════════════════════════════════════════════════════"
echo "  Metro:      ${EXPO_DEV_URL}"
echo "  Daemon:     ${MIXER_LISTEN}"
echo "  Home:       ${MIXER_HOME}"
echo "  userData:   ${MIXER_ELECTRON_USER_DATA_DIR}"
echo "══════════════════════════════════════════════════════"

exec node "$SCRIPT_DIR/dev-runner.mjs"
