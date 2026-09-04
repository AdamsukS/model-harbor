from pathlib import Path


def read(path: str) -> str:
    return Path(path).read_text(encoding="utf-8")


def test_readme_has_complete_operator_flow() -> None:
    text = read("README.md")

    for command in (
        "scripts/prepare.sh",
        "scripts/start-mlx.sh",
        "scripts/health.sh",
        "scripts/smoke.sh",
        "scripts/bench-cache.sh 32k",
        "scripts/stop.sh",
    ):
        assert command in text
    assert "http://127.0.0.1:8000/v1" in text
    assert "default_model" in text
    assert "5" in text


def test_default_readme_is_english_with_separate_chinese_version() -> None:
    english = read("README.md")
    chinese = read("README.zh-CN.md")

    assert english.startswith("# ModelHarbor\n")
    assert "[简体中文](README.zh-CN.md)" in english
    assert "Current status" in english
    assert "Quick start" in english
    assert "Cache experiments" in english
    assert "## 中文" not in english

    assert chinese.startswith("# ModelHarbor\n")
    assert "[English](README.md)" in chinese
    assert "当前状态" in chinese
    assert "快速开始" in chinese
    assert "缓存实验" in chinese


def test_project_metadata_uses_generic_brand() -> None:
    metadata = read("pyproject.toml")
    cli = read("llm_service/cli.py")
    package = read("llm_service/__init__.py")

    assert 'name = "model-harbor"' in metadata
    assert 'name = "qwen35-local-serving"' not in metadata
    assert "ModelHarbor" in cli
    assert "Local inference service control utilities" in package


def test_api_document_covers_supported_protocol() -> None:
    text = read("docs/API.md")

    for term in (
        "/v1/models",
        "/v1/chat/completions",
        '"stream": true',
        '"tools"',
        '"tool_calls"',
        '"enable_thinking"',
        '"reasoning"',
        "[DONE]",
        "429",
        "default_model",
    ):
        assert term in text


def test_module_document_covers_runtime_and_cache_boundaries() -> None:
    text = read("docs/MODULES.md")

    for term in (
        "llm_service.config",
        "llm_service.prepare",
        "llm_service.process",
        "llm_service.client",
        "llm_service.smoke",
        "llm_service.benchmark",
        "QWEN_PROMPT_CACHE_SIZE=1",
        "QWEN_PROMPT_CACHE_BYTES=1200MB",
        "32K",
        "64K",
        "128K",
        "1 GiB",
        "SGLang",
    ):
        assert term in text
