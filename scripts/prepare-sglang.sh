#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOURCE_DIR="$ROOT_DIR/runtime/sglang-src"
REVISION="27b7a2dc3baf6b93736540e35c1847efdfb56436"

command -v uv >/dev/null 2>&1 || {
  echo "uv is required: https://docs.astral.sh/uv/" >&2
  exit 1
}

mkdir -p "$ROOT_DIR/runtime"
if [[ ! -d "$SOURCE_DIR/.git" ]]; then
  git clone --filter=blob:none https://github.com/sgl-project/sglang.git "$SOURCE_DIR"
fi
git -C "$SOURCE_DIR" fetch --depth 1 origin "$REVISION"
git -C "$SOURCE_DIR" checkout --detach "$REVISION"
cp "$SOURCE_DIR/python/pyproject_other.toml" "$SOURCE_DIR/python/pyproject.toml"

uv python install 3.12.13
if [[ ! -x "$ROOT_DIR/.venv-sglang/bin/python" ]]; then
  uv venv --python 3.12.13 "$ROOT_DIR/.venv-sglang"
fi
SGLANG_BUILD_RUST_EXTS=none uv pip install --python "$ROOT_DIR/.venv-sglang/bin/python" \
  --prerelease=allow -e "$SOURCE_DIR/python[srt_mps]"

"$ROOT_DIR/.venv-sglang/bin/python" -c \
  'import importlib.metadata as m; print("sglang={} mlx={} torch={}".format(m.version("sglang"), m.version("mlx"), m.version("torch")))'
