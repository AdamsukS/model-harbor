#!/usr/bin/env bash

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
DEFAULT_ENV_FILE="$PROJECT_ROOT/config/default.env"
USER_ENV_FILE="$PROJECT_ROOT/.env"

set -a
if [[ -f "$DEFAULT_ENV_FILE" ]]; then
  # shellcheck disable=SC1090
  source "$DEFAULT_ENV_FILE"
fi
if [[ -f "$USER_ENV_FILE" ]]; then
  # shellcheck disable=SC1090
  source "$USER_ENV_FILE"
fi
set +a

RUNTIME_SOURCE_DIR="${MODEL_HARBOR_RUNTIME_DIR:-$PROJECT_ROOT/.runtime}"
STATE_DIR="${MODEL_HARBOR_STATE_DIR:-$PROJECT_ROOT/runtime}"
LOG_DIR="$STATE_DIR/logs"
PID_DIR="$STATE_DIR/pids"
BIN_DIR="$STATE_DIR/bin"
SOURCE_MANIFEST="${MODEL_HARBOR_SOURCE_MANIFEST:-$PROJECT_ROOT/config/runtime-sources.json}"

mkdir -p "$LOG_DIR" "$PID_DIR" "$BIN_DIR"

find_node() {
  if [[ -n "${NODE_BIN:-}" && -x "$NODE_BIN" ]]; then
    printf '%s\n' "$NODE_BIN"
    return
  fi
  if command -v node >/dev/null 2>&1; then
    command -v node
    return
  fi
  local bundled="/Users/codesoul/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node"
  if [[ -x "$bundled" ]]; then
    printf '%s\n' "$bundled"
    return
  fi
  return 1
}

find_pnpm() {
  if [[ -n "${PNPM_BIN:-}" && -x "$PNPM_BIN" ]]; then
    printf '%s\n' "$PNPM_BIN"
    return
  fi
  if command -v pnpm >/dev/null 2>&1; then
    command -v pnpm
    return
  fi
  local bundled="/Users/codesoul/.cache/codex-runtimes/codex-primary-runtime/dependencies/bin/fallback/pnpm"
  if [[ -x "$bundled" ]]; then
    printf '%s\n' "$bundled"
    return
  fi
  return 1
}

wait_http() {
  local url="$1"
  local attempts="${2:-60}"
  local index=0
  while (( index < attempts )); do
    if curl -fsS --max-time 2 "$url" >/dev/null 2>&1; then
      return 0
    fi
    index=$((index + 1))
    sleep 1
  done
  printf 'Timed out waiting for %s\n' "$url" >&2
  return 1
}

managed_pid_running() {
  local name="$1"
  local pattern="$2"
  local file="$PID_DIR/$name.pid"
  [[ -f "$file" ]] || return 1
  local pid
  pid="$(tr -d '[:space:]' < "$file")"
  [[ "$pid" =~ ^[0-9]+$ ]] || return 1
  kill -0 "$pid" 2>/dev/null || return 1
  ps -p "$pid" -o command= | grep -F -- "$pattern" >/dev/null 2>&1
}

stop_managed() {
  local name="$1"
  local pattern="$2"
  local file="$PID_DIR/$name.pid"
  [[ -f "$file" ]] || return 0
  local pid
  pid="$(tr -d '[:space:]' < "$file")"
  if [[ ! "$pid" =~ ^[0-9]+$ ]] || ! kill -0 "$pid" 2>/dev/null; then
    rm -f "$file"
    return 0
  fi
  if ! ps -p "$pid" -o command= | grep -F -- "$pattern" >/dev/null 2>&1; then
    printf 'Refusing to stop PID %s for %s: command owner does not match.\n' "$pid" "$name" >&2
    return 0
  fi
  kill -TERM "$pid"
  local attempts=0
  while kill -0 "$pid" 2>/dev/null && (( attempts < 20 )); do
    attempts=$((attempts + 1))
    sleep 0.25
  done
  rm -f "$file"
}
