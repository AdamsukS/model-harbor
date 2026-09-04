from pathlib import Path

import pytest

from llm_service.config import ServiceConfig


def test_defaults_are_local_and_memory_bounded(tmp_path: Path) -> None:
    cfg = ServiceConfig.load(tmp_path, {})

    assert cfg.host == "127.0.0.1"
    assert cfg.port == 8000
    assert cfg.model_id == "mlx-community/Qwen3.5-9B-4bit"
    assert cfg.model_dir == tmp_path / "models/Qwen3.5-9B-4bit"
    assert cfg.runtime_dir == tmp_path / "runtime"
    assert cfg.prompt_cache_bytes == "1200MB"
    assert cfg.prompt_cache_size == 1
    assert cfg.prompt_concurrency == 1
    assert cfg.decode_concurrency == 1


def test_environment_overrides_file_values(tmp_path: Path) -> None:
    config_dir = tmp_path / "config"
    config_dir.mkdir()
    (config_dir / "default.env").write_text(
        "QWEN_PORT=8100\nQWEN_PROMPT_CACHE_SIZE=3\n",
        encoding="utf-8",
    )

    cfg = ServiceConfig.load(
        tmp_path,
        {"QWEN_PORT": "8200", "QWEN_DECODE_CONCURRENCY": "2"},
    )

    assert cfg.port == 8200
    assert cfg.prompt_cache_size == 3
    assert cfg.decode_concurrency == 2


def test_external_bind_is_rejected(tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="loopback"):
        ServiceConfig.load(tmp_path, {"QWEN_HOST": "0.0.0.0"})


@pytest.mark.parametrize(
    ("key", "value"),
    [
        ("QWEN_PORT", "0"),
        ("QWEN_PROMPT_CACHE_SIZE", "0"),
        ("QWEN_PROMPT_CONCURRENCY", "0"),
        ("QWEN_DECODE_CONCURRENCY", "0"),
    ],
)
def test_invalid_numeric_values_are_rejected(
    tmp_path: Path, key: str, value: str
) -> None:
    with pytest.raises(ValueError):
        ServiceConfig.load(tmp_path, {key: value})
