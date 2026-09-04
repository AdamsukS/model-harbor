#!/usr/bin/env bash

set -euo pipefail
# shellcheck source=common.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)/common.sh"

NODE_EXEC="$(find_node)" || {
  printf 'Node.js 22 or newer is required.\n' >&2
  exit 1
}
SESSION_ID="smoke-$(date +%s)"
BASE_URL="http://${MODEL_HARBOR_HOST}:${MODEL_HARBOR_PORT}"
CHAT_RESPONSE="$(curl -fsS -X POST "$BASE_URL/v1/chat/completions" \
  -H 'Content-Type: application/json' \
  -H 'X-User-ID: smoke-user' \
  -H "X-Session-ID: $SESSION_ID" \
  -d '{"model":"local-default","stream":false,"messages":[{"role":"user","content":"Reply with a short confirmation that the local service is running."}]}')"
printf '%s' "$CHAT_RESPONSE" | "$NODE_EXEC" -e '
  let text = "";
  process.stdin.on("data", chunk => text += chunk);
  process.stdin.on("end", () => {
    const value = JSON.parse(text);
    if (!value.choices?.[0]?.message?.content) process.exit(1);
    process.stdout.write(JSON.stringify(value, null, 2) + "\n");
  });
'
MEMORY_RESPONSE="$(curl -fsS -X POST "$BASE_URL/v1/memory/query" \
  -H 'Content-Type: application/json' \
  -H 'X-User-ID: smoke-user' \
  -H "X-Session-ID: $SESSION_ID" \
  -d '{"query":"local service running"}')"
printf '%s' "$MEMORY_RESPONSE" | "$NODE_EXEC" -e '
  let text = "";
  process.stdin.on("data", chunk => text += chunk);
  process.stdin.on("end", () => {
    const value = JSON.parse(text);
    if (!Array.isArray(value.memories) || value.memories.length === 0) process.exit(1);
    process.stdout.write(`memory records: ${value.memories.length}\n`);
  });
'
