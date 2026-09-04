#!/usr/bin/env bash

set -euo pipefail
# shellcheck source=common.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)/common.sh"

"$PROJECT_ROOT/scripts/start-ollama.sh"
"$PROJECT_ROOT/scripts/start-plasmod.sh"

if curl -fsS --max-time 2 "http://${MODEL_HARBOR_HOST}:${MODEL_HARBOR_PORT}/healthz" >/dev/null 2>&1; then
  printf 'ModelHarbor is already running.\n'
  exit 0
fi
NODE_EXEC="$(find_node)" || {
  printf 'Node.js 22 or newer is required.\n' >&2
  exit 1
}
PNPM_EXEC="$(find_pnpm)" || {
  printf 'pnpm is required.\n' >&2
  exit 1
}
PATH="$(dirname "$NODE_EXEC"):$PATH" "$PNPM_EXEC" run build
nohup "$NODE_EXEC" "$PROJECT_ROOT/dist/src/main.js" >"$LOG_DIR/model-harbor.log" 2>&1 &
printf '%s\n' "$!" > "$PID_DIR/model-harbor.pid"
wait_http "http://${MODEL_HARBOR_HOST}:${MODEL_HARBOR_PORT}/readyz" 120
printf 'ModelHarbor started at http://%s:%s.\n' "$MODEL_HARBOR_HOST" "$MODEL_HARBOR_PORT"
