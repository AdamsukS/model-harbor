"""Configuration loading and validation for the local inference service."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Mapping
import os
import re


LOOPBACK_HOSTS = frozenset({"127.0.0.1", "localhost", "::1"})
SIZE_PATTERN = re.compile(r"^[1-9][0-9]*(?:KB|MB|GB)$", re.IGNORECASE)


def read_env_file(path: Path) -> dict[str, str]:
    """Read a strict KEY=VALUE file without executing shell code."""
    if not path.exists():
        return {}
    values: dict[str, str] = {}
    for line_number, raw_line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if "=" not in line:
            raise ValueError(f"invalid environment line {line_number} in {path}")
        key, value = line.split("=", 1)
        key = key.strip()
        if not key.startswith("QWEN_"):
            raise ValueError(f"unsupported configuration key {key!r} in {path}")
        values[key] = value.strip().strip('"').strip("'")
    return values


def _positive_int(values: Mapping[str, str], key: str, default: int) -> int:
    try:
        value = int(values.get(key, str(default)))
    except ValueError as exc:
        raise ValueError(f"{key} must be an integer") from exc
    if value <= 0:
        raise ValueError(f"{key} must be positive")
    return value


def _resolve_under_root(root: Path, raw: str) -> Path:
    path = Path(raw).expanduser()
    return path.resolve() if path.is_absolute() else (root / path).resolve()


@dataclass(frozen=True, slots=True)
class ServiceConfig:
    """Validated service settings with all paths resolved."""

    root: Path
    host: str
    port: int
    model_id: str
    model_dir: Path
    runtime_dir: Path
    prompt_cache_bytes: str
    prompt_cache_size: int
    prompt_concurrency: int
    decode_concurrency: int
    prefill_step_size: int
    max_tokens: int
    enable_thinking: bool

    @classmethod
    def load(
        cls,
        root: Path,
        environ: Mapping[str, str] | None = None,
    ) -> "ServiceConfig":
        root = root.resolve()
        values = read_env_file(root / "config/default.env")
        source = os.environ if environ is None else environ
        values.update({key: value for key, value in source.items() if key.startswith("QWEN_")})

        host = values.get("QWEN_HOST", "127.0.0.1")
        if host not in LOOPBACK_HOSTS:
            raise ValueError("QWEN_HOST must be a loopback address")

        port = _positive_int(values, "QWEN_PORT", 8000)
        if port > 65535:
            raise ValueError("QWEN_PORT must be at most 65535")

        cache_bytes = values.get("QWEN_PROMPT_CACHE_BYTES", "2GB")
        if not SIZE_PATTERN.fullmatch(cache_bytes):
            raise ValueError("QWEN_PROMPT_CACHE_BYTES must look like 2GB or 512MB")

        thinking = values.get("QWEN_ENABLE_THINKING", "true").lower()
        if thinking not in {"true", "false"}:
            raise ValueError("QWEN_ENABLE_THINKING must be true or false")

        return cls(
            root=root,
            host=host,
            port=port,
            model_id=values.get("QWEN_MODEL_ID", "mlx-community/Qwen3.5-9B-4bit"),
            model_dir=_resolve_under_root(
                root, values.get("QWEN_MODEL_DIR", "models/Qwen3.5-9B-4bit")
            ),
            runtime_dir=_resolve_under_root(root, values.get("QWEN_RUNTIME_DIR", "runtime")),
            prompt_cache_bytes=cache_bytes.upper(),
            prompt_cache_size=_positive_int(values, "QWEN_PROMPT_CACHE_SIZE", 5),
            prompt_concurrency=_positive_int(values, "QWEN_PROMPT_CONCURRENCY", 1),
            decode_concurrency=_positive_int(values, "QWEN_DECODE_CONCURRENCY", 1),
            prefill_step_size=_positive_int(values, "QWEN_PREFILL_STEP_SIZE", 2048),
            max_tokens=_positive_int(values, "QWEN_MAX_TOKENS", 2048),
            enable_thinking=thinking == "true",
        )
