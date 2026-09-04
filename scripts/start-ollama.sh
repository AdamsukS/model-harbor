#!/usr/bin/env bash

set -euo pipefail
# shellcheck source=common.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)/common.sh"

if curl -fsS --max-time 2 "${OLLAMA_BASE_URL}/api/tags" >/dev/null 2>&1; then
  printf 'Ollama is already reachable at %s.\n' "$OLLAMA_BASE_URL"
  exit 0
fi
OLLAMA_EXEC="${OLLAMA_BIN:-$(command -v ollama || true)}"
if [[ -z "$OLLAMA_EXEC" ]]; then
  printf 'Ollama is not installed. Run scripts/prepare.sh after installing it.\n' >&2
  exit 1
fi
OLLAMA_FLASH_ATTENTION=1 \
OLLAMA_KV_CACHE_TYPE=q4_0 \
OLLAMA_NUM_PARALLEL=1 \
OLLAMA_MAX_QUEUE=5 \
OLLAMA_MAX_LOADED_MODELS=1 \
nohup "$OLLAMA_EXEC" serve >"$LOG_DIR/ollama.log" 2>&1 &
printf '%s\n' "$!" > "$PID_DIR/ollama.pid"
wait_http "${OLLAMA_BASE_URL}/api/tags" 60
printf 'Ollama started.\n'
