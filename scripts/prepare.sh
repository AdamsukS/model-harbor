#!/usr/bin/env bash

set -euo pipefail
# shellcheck source=common.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)/common.sh"

NODE_EXEC="$(find_node)" || {
  printf 'Node.js 22 or newer is required.\n' >&2
  exit 1
}
mkdir -p "$RUNTIME_SOURCE_DIR"

clone_source() {
  local name="$1"
  local repository="$2"
  local revision="$3"
  local directory="$4"
  local destination="$RUNTIME_SOURCE_DIR/$directory"
  local cloned=0
  if [[ -d "$destination/.git" ]]; then
    if [[ -n "$(git -C "$destination" status --porcelain)" ]]; then
      printf 'Refusing to update dirty %s checkout: %s\n' "$name" "$destination" >&2
      return 1
    fi
  elif [[ -e "$destination" ]]; then
    printf 'Refusing to replace non-Git runtime path: %s\n' "$destination" >&2
    return 1
  else
    git clone --no-checkout "$repository" "$destination"
    cloned=1
  fi
  if [[ "$cloned" == "1" || "$(git -C "$destination" rev-parse HEAD 2>/dev/null || true)" != "$revision" ]]; then
    git -C "$destination" fetch --quiet origin "$revision"
    git -C "$destination" checkout --quiet --detach "$revision"
  fi
}

while IFS=$'\t' read -r name repository revision directory; do
  clone_source "$name" "$repository" "$revision" "$directory"
done < <(
  "$NODE_EXEC" -e '
    const manifest = require(process.argv[1]);
    for (const name of ["hypha", "plasmod"]) {
      const source = manifest[name];
      process.stdout.write([name, source.repository, source.revision, source.directory].join("\t") + "\n");
    }
  ' "$SOURCE_MANIFEST"
)

if [[ "${MODEL_HARBOR_SKIP_INSTALLS:-0}" != "1" ]]; then
  PNPM_EXEC="$(find_pnpm)" || {
    printf 'pnpm is required for ModelHarbor.\n' >&2
    exit 1
  }
  PATH="$(dirname "$NODE_EXEC"):$PATH" "$PNPM_EXEC" install --frozen-lockfile

  if ! command -v npm >/dev/null 2>&1; then
    printf 'npm is required to install the Hypha workspace using its official workflow.\n' >&2
    exit 1
  fi
  (cd "$RUNTIME_SOURCE_DIR/hypha" && npm ci)
  (cd "$RUNTIME_SOURCE_DIR/plasmod" && /opt/homebrew/bin/go mod download)
  (cd "$RUNTIME_SOURCE_DIR/plasmod" && /opt/homebrew/bin/go build -o "$BIN_DIR/plasmod" ./src/cmd/server)
fi

if [[ "${MODEL_HARBOR_SKIP_MODEL:-0}" != "1" ]]; then
  OLLAMA_EXEC="${OLLAMA_BIN:-$(command -v ollama || true)}"
  if [[ -z "$OLLAMA_EXEC" ]]; then
    printf 'Ollama is required. Install it with: brew install ollama\n' >&2
    exit 1
  fi
  "$OLLAMA_EXEC" pull "${OLLAMA_SOURCE_MODEL}"
  "$OLLAMA_EXEC" create "${OLLAMA_MODEL}" -f "$PROJECT_ROOT/config/ollama/Modelfile"
fi

printf 'Runtime sources and dependencies are prepared.\n'
