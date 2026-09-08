#!/bin/sh
set -eu
: "${INFERENCE_STATE_DIR:?Set INFERENCE_STATE_DIR to the installed inference state directory}"
: "${LLAMA_SERVER_BIN:?Set LLAMA_SERVER_BIN to a llama-server build with subprocess support}"
exec "$LLAMA_SERVER_BIN" --models-preset "$INFERENCE_STATE_DIR/llama-models.ini" \
  --models-max 1 --host 127.0.0.1 --port 11435 --offline --no-webui
