#!/usr/bin/env bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export PATH="$SCRIPT_DIR/../node_modules/.bin:$PATH"

source "$SCRIPT_DIR/dev-home.sh"

export MIXER_LISTEN="${MIXER_LISTEN:-127.0.0.1:6768}"
configure_dev_mixer_home

if [ -z "${MIXER_LOCAL_MODELS_DIR}" ]; then
  export MIXER_LOCAL_MODELS_DIR="$HOME/.mixer/models/local-speech"
  mkdir -p "$MIXER_LOCAL_MODELS_DIR"
fi

echo "══════════════════════════════════════════════════════"
echo "  Mixer Dev Daemon"
echo "══════════════════════════════════════════════════════"
echo "  Home:    ${MIXER_HOME}"
echo "  Models:  ${MIXER_LOCAL_MODELS_DIR}"
echo "  Listen:  ${MIXER_LISTEN}"
echo "══════════════════════════════════════════════════════"

export MIXER_CORS_ORIGINS="${MIXER_CORS_ORIGINS:-*}"
export MIXER_NODE_INSPECT="${MIXER_NODE_INSPECT:---inspect=0}"

if [ "${MIXER_SKIP_DEV_SERVER_BUILD:-0}" = "1" ]; then
  exec npm run dev:server:watch
fi

exec sh -c 'npm run build:server-deps && npm run dev:server:watch'
