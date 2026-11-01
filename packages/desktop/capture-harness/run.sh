#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/../../.." && pwd)
ELECTRON="$REPO_ROOT/node_modules/.bin/electron"

if [ "${MIXER_CAPTURE_HARNESS_GROUP:-}" = "browser-profile" ] && [ -z "${MIXER_CAPTURE_HARNESS_PHASE:-}" ]; then
  MIXER_CAPTURE_HARNESS_PHASE=write "$ELECTRON" "$SCRIPT_DIR/main.js"
  # Give Chromium's profile helpers time to release the persistent session before reopening it.
  sleep 1
  MIXER_CAPTURE_HARNESS_PHASE=read "$ELECTRON" "$SCRIPT_DIR/main.js"
  exit
fi

exec "$ELECTRON" "$SCRIPT_DIR/main.js"
