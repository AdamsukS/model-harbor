#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PYTHONPATH="$ROOT_DIR" exec "$ROOT_DIR/.venv/bin/python" -m llm_service.cli health "$@"
