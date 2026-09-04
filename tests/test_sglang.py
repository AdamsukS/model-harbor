from pathlib import Path

from llm_service.config import ServiceConfig
from llm_service.process import sglang_command


def pair(command: list[str], option: str) -> str:
    return command[command.index(option) + 1]


def test_sglang_command_uses_mlx_and_disables_cuda_graph(tmp_path: Path) -> None:
    config = ServiceConfig.load(tmp_path, {})

    environment, command = sglang_command(config, {"PATH": "/bin"})

    assert environment["SGLANG_USE_MLX"] == "1"
    assert environment["HF_HUB_OFFLINE"] == "1"
    assert command[:3] == [
        str(config.root / ".venv-sglang/bin/python"),
        "-m",
        "sglang.launch_server",
    ]
    assert "--disable-cuda-graph" in command
    assert pair(command, "--model-path") == str(config.model_dir)
    assert pair(command, "--served-model-name") == "default_model"
    assert pair(command, "--host") == "127.0.0.1"
    assert pair(command, "--port") == "8001"


def test_sglang_preparation_is_pinned_and_isolated() -> None:
    script = Path("scripts/prepare-sglang.sh").read_text(encoding="utf-8")

    assert "27b7a2dc3baf6b93736540e35c1847efdfb56436" in script
    assert ".venv-sglang" in script
    assert "srt_mps" in script
    assert "SGLANG_BUILD_RUST_EXTS=none" in script
    assert "importlib.metadata" in script
    assert "mlx.__version__" not in script
    assert 'rm -rf "$ROOT_DIR/.venv"' not in script
