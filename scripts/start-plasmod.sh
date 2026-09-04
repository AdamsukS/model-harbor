#!/usr/bin/env bash

set -euo pipefail
# shellcheck source=common.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)/common.sh"

if curl -fsS --max-time 2 "${PLASMOD_BASE_URL}/healthz" >/dev/null 2>&1; then
  printf 'Plasmod is already reachable at %s.\n' "$PLASMOD_BASE_URL"
  exit 0
fi
if [[ ! -x "$BIN_DIR/plasmod" ]]; then
  printf 'Plasmod binary is missing. Run scripts/prepare.sh first.\n' >&2
  exit 1
fi
PLASMOD_LISTEN_MODE=unified \
PLASMOD_HTTP_ADDR=127.0.0.1:8080 \
PLASMOD_STORAGE=disk \
PLASMOD_DATA_DIR="$PROJECT_ROOT/data/plasmod" \
PLASMOD_EMBEDDER=tfidf \
PLASMOD_GRPC_ENABLED=0 \
nohup "$BIN_DIR/plasmod" >"$LOG_DIR/plasmod.log" 2>&1 &
printf '%s\n' "$!" > "$PID_DIR/plasmod.pid"
wait_http "${PLASMOD_BASE_URL}/healthz" 60
if [[ "${PLASMOD_REPLAY_ON_START:-1}" == "1" ]]; then
  curl -fsS -X POST "${PLASMOD_BASE_URL}/v1/admin/replay" \
    -H 'Content-Type: application/json' \
    -d '{"from_lsn":1,"apply":true,"confirm":"apply_replay"}' >/dev/null
fi
printf 'Plasmod started.\n'
