"""Host validation and reproducible Hugging Face model preparation."""

from __future__ import annotations

import json
import platform
from pathlib import Path
import shutil
from typing import Any

from huggingface_hub import HfApi, snapshot_download

from llm_service.config import ServiceConfig


MINIMUM_FREE_BYTES = 12 * 1024**3


def check_host(root: Path, free_bytes: int | None = None) -> None:
    """Fail early unless the host is a suitable Apple Silicon Mac."""
    if platform.system() != "Darwin" or platform.machine() != "arm64":
        raise RuntimeError("this setup requires an Apple Silicon macOS host")
    available = shutil.disk_usage(root).free if free_bytes is None else free_bytes
    if available < MINIMUM_FREE_BYTES:
        raise RuntimeError(
            "at least 12 GiB of free disk is required before downloading the model"
        )


def _snapshot_bytes(model_dir: Path) -> int:
    return sum(path.stat().st_size for path in model_dir.rglob("*") if path.is_file())


def _write_json_atomic(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    temporary.replace(path)


def download_model(model_id: str, model_dir: Path) -> dict[str, str | int]:
    """Download or resume a model snapshot and record its immutable revision."""
    info = HfApi().model_info(model_id, revision="main")
    revision = str(info.sha)
    snapshot_download(
        repo_id=model_id,
        revision=revision,
        local_dir=str(model_dir),
    )

    if not (model_dir / "config.json").is_file():
        raise RuntimeError("downloaded model is missing config.json")
    if not any(model_dir.glob("*.safetensors")):
        raise RuntimeError("downloaded model is missing safetensor weights")

    manifest: dict[str, str | int] = {
        "model_id": model_id,
        "revision": revision,
        "bytes": _snapshot_bytes(model_dir),
        "path": str(model_dir.resolve()),
    }
    runtime_dir = model_dir.parent.parent / "runtime"
    _write_json_atomic(runtime_dir / "model-revision.json", manifest)
    return manifest


def main() -> int:
    root = Path(__file__).resolve().parents[1]
    config = ServiceConfig.load(root)
    check_host(root)
    manifest = download_model(config.model_id, config.model_dir)
    gib = int(manifest["bytes"]) / 1024**3
    print(f"Prepared {manifest['model_id']} at {manifest['path']}")
    print(f"Revision: {manifest['revision']}")
    print(f"Size: {gib:.2f} GiB")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

