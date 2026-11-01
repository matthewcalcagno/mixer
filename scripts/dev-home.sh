#!/usr/bin/env bash

default_dev_mixer_root() {
  git rev-parse --show-toplevel 2>/dev/null || pwd
}

copy_json_tree() {
  local source_dir="$1"
  local target_dir="$2"

  if [ ! -d "$source_dir" ]; then
    return
  fi

  mkdir -p "$target_dir"
  if command -v rsync >/dev/null 2>&1; then
    rsync -a --include='*/' --include='*.json' --exclude='*' "$source_dir/" "$target_dir/"
    return
  fi

  while IFS= read -r -d '' source_file; do
    local relative_path="${source_file#"$source_dir"/}"
    local target_file="$target_dir/$relative_path"
    mkdir -p "$(dirname "$target_file")"
    cp "$source_file" "$target_file"
  done < <(find "$source_dir" -type f -name '*.json' -print0)
}

has_files() {
  [ -d "$1" ] && [ -n "$(find "$1" -mindepth 1 -maxdepth 1 -print -quit 2>/dev/null)" ]
}

seed_worktree_mixer_home() {
  local source_home="${MIXER_DEV_SEED_HOME:-$HOME/.mixer}"
  local target_home="$1"

  if [ ! -d "$source_home" ]; then
    echo "  Seed:    skipped (${source_home} missing)"
    return
  fi

  if [ "$source_home" = "$target_home" ]; then
    echo "  Seed:    skipped (source is target)"
    return
  fi

  if [ "${MIXER_DEV_RESET_HOME:-0}" = "1" ]; then
    rm -rf "$target_home"
  elif has_files "$target_home"; then
    echo "  Seed:    skipped (${target_home} already has data)"
    return
  fi

  mkdir -p "$target_home"
  echo "  Seed:    copying metadata from ${source_home}"
  copy_json_tree "$source_home/agents" "$target_home/agents"
  copy_json_tree "$source_home/projects" "$target_home/projects"
  if [ -f "$source_home/config.json" ]; then
    cp "$source_home/config.json" "$target_home/config.json"
  fi

  echo "  Seed:    copied metadata from ${source_home}"
}

configure_dev_daemon_config() {
  if [ -z "${MIXER_LISTEN:-}" ]; then
    return
  fi

  mkdir -p "$MIXER_HOME"
  node -e '
const fs = require("fs");
const [path, listen] = [process.argv[1], process.argv[2]];
let cfg = {};
try { cfg = JSON.parse(fs.readFileSync(path, "utf8")); } catch {}
cfg.version = cfg.version || 1;
cfg.daemon = cfg.daemon || {};
cfg.daemon.listen = listen;
cfg.daemon.cors = cfg.daemon.cors || {};
cfg.daemon.cors.allowedOrigins = ["*"];
fs.writeFileSync(path, JSON.stringify(cfg, null, 2));
' "$MIXER_HOME/config.json" "$MIXER_LISTEN"
}

resolve_dev_daemon_endpoint() {
  if [ -n "${MIXER_DEV_DAEMON_ENDPOINT:-}" ]; then
    echo "$MIXER_DEV_DAEMON_ENDPOINT"
    return
  fi

  case "${MIXER_LISTEN:-127.0.0.1:6768}" in
    0.0.0.0:*) echo "localhost:${MIXER_LISTEN#0.0.0.0:}" ;;
    127.0.0.1:*) echo "localhost:${MIXER_LISTEN#127.0.0.1:}" ;;
    *) echo "$MIXER_LISTEN" ;;
  esac
}

configure_dev_mixer_home() {
  if [ -n "${MIXER_HOME:-}" ]; then
    export MIXER_HOME
    if [ -n "${MIXER_DEV_SEED_HOME:-}" ]; then
      seed_worktree_mixer_home "$MIXER_HOME"
    fi
    mkdir -p "$MIXER_HOME"
    if [ "${MIXER_DEV_MANAGED_HOME:-0}" = "1" ] || [ -n "${MIXER_DEV_SEED_HOME:-}" ]; then
      configure_dev_daemon_config
    fi
    return
  fi

  export MIXER_HOME
  local dev_root
  dev_root="${MIXER_DEV_ROOT:-$(default_dev_mixer_root)}"
  MIXER_HOME="$dev_root/.dev/mixer-home"
  export MIXER_DEV_MANAGED_HOME=1

  if [ -n "${MIXER_DEV_SEED_HOME:-}" ]; then
    seed_worktree_mixer_home "$MIXER_HOME"
  fi

  mkdir -p "$MIXER_HOME"
  configure_dev_daemon_config
}

configure_dev_command_env() {
  if [ -z "${MIXER_LISTEN:-}" ]; then
    if [ -n "${MIXER_SERVICE_DAEMON_PORT:-}" ]; then
      export MIXER_LISTEN="0.0.0.0:${MIXER_SERVICE_DAEMON_PORT}"
    else
      export MIXER_LISTEN="127.0.0.1:6768"
    fi
  fi

  configure_dev_mixer_home
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  if [ "$#" -gt 0 ]; then
    configure_dev_command_env
    exec "$@"
  fi

  configure_dev_mixer_home
fi
