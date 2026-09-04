#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

command -v uv >/dev/null 2>&1 || {
  echo "uv is required: https://docs.astral.sh/uv/" >&2
  exit 1
}

uv python install 3.12.13
if [[ ! -x "$ROOT_DIR/.venv/bin/python" ]]; then
  uv venv --python 3.12.13 "$ROOT_DIR/.venv"
fi
uv pip install --python "$ROOT_DIR/.venv/bin/python" \
  -r "$ROOT_DIR/requirements-mlx.txt" \
  -r "$ROOT_DIR/requirements-dev.txt"

PYTHONPATH="$ROOT_DIR" "$ROOT_DIR/.venv/bin/python" -m llm_service.prepare
