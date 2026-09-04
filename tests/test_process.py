import json
from pathlib import Path

import pytest

from llm_service.config import ServiceConfig
import llm_service.process as process
from llm_service.process import (
    healthcheck,
    mlx_command,
    mlx_environment,
    start_backend,
    stop_backend,
    write_pid,
)


@pytest.fixture
def config(tmp_path: Path) -> ServiceConfig:
    return ServiceConfig.load(tmp_path, {})


def pair(command: list[str], option: str) -> str:
    return command[command.index(option) + 1]


def test_mlx_command_exposes_cache_controls(config: ServiceConfig) -> None:
    command = mlx_command(config)

    assert command[:2] == [str(config.root / ".venv/bin/mlx_lm.server"), "--model"]
    assert pair(command, "--model") == str(config.model_dir)
    assert pair(command, "--host") == "127.0.0.1"
    assert pair(command, "--port") == "8000"
    assert pair(command, "--decode-concurrency") == "1"
    assert pair(command, "--prompt-concurrency") == "1"
    assert pair(command, "--prompt-cache-size") == "5"
    assert pair(command, "--prompt-cache-bytes") == "2GB"
    assert pair(command, "--chat-template-args") == '{"enable_thinking":true}'


def test_pid_record_is_atomic_json(config: ServiceConfig) -> None:
    path = write_pid(config, 4242, backend="mlx", command=["mlx_lm.server"])

    assert json.loads(path.read_text(encoding="utf-8")) == {
        "backend": "mlx",
        "command": ["mlx_lm.server"],
        "pid": 4242,
    }
    assert not path.with_suffix(".pid.tmp").exists()


def test_stop_refuses_unrelated_pid(
    config: ServiceConfig, monkeypatch: pytest.MonkeyPatch
) -> None:
    write_pid(config, 4242, backend="mlx", command=["mlx_lm.server"])
    monkeypatch.setattr(process, "process_command", lambda pid: "/usr/bin/python unrelated.py")

    with pytest.raises(RuntimeError, match="refusing"):
        stop_backend("mlx", config)


def test_stop_removes_stale_pid_without_signalling(
    config: ServiceConfig, monkeypatch: pytest.MonkeyPatch
) -> None:
    path = write_pid(config, 4242, backend="mlx", command=["mlx_lm.server"])
    monkeypatch.setattr(process, "process_command", lambda pid: None)
    signalled: list[int] = []
    monkeypatch.setattr(process.os, "kill", lambda pid, signal: signalled.append(pid))

    stop_backend("mlx", config)

    assert signalled == []
    assert not path.exists()


def test_start_requires_local_model(config: ServiceConfig) -> None:
    with pytest.raises(RuntimeError, match="prepare.sh"):
        start_backend("mlx", config)


def test_healthcheck_requires_models_and_completion(
    config: ServiceConfig, monkeypatch: pytest.MonkeyPatch
) -> None:
    responses = [
        {"data": [{"id": config.model_id}]},
        {"choices": [{"message": {"content": "OK"}}]},
    ]

    class FakeResponse:
        def __init__(self, payload: dict[str, object]) -> None:
            self.payload = payload

        def __enter__(self) -> "FakeResponse":
            return self

        def __exit__(self, *args: object) -> None:
            return None

        def read(self) -> bytes:
            return json.dumps(self.payload).encode()

    requests: list[object] = []

    def fake_urlopen(request: object, timeout: float) -> FakeResponse:
        assert timeout > 0
        requests.append(request)
        return FakeResponse(responses.pop(0))

    monkeypatch.setattr(process, "urlopen", fake_urlopen)

    report = healthcheck(config)

    assert report["status"] == "ok"
    assert report["completion"] == "OK"
    completion_body = json.loads(requests[1].data)
    assert "model" not in completion_body
    assert completion_body["chat_template_kwargs"] == {"enable_thinking": False}


def test_mlx_environment_forces_offline_model_loading(config: ServiceConfig) -> None:
    environment = mlx_environment(config, {"PATH": "/bin"})

    assert environment["HF_HUB_OFFLINE"] == "1"
    assert environment["TRANSFORMERS_OFFLINE"] == "1"
    assert environment["PYTHONPATH"] == str(config.root)
    assert environment["PATH"] == "/bin"
