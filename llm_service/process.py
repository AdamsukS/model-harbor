"""Safe process lifecycle and health checks for local inference backends."""

from __future__ import annotations

import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import time
from collections.abc import Callable
from typing import Any, Literal
from urllib.request import Request, urlopen

from llm_service.config import ServiceConfig


BackendName = Literal["mlx", "sglang"]


def mlx_command(config: ServiceConfig) -> list[str]:
    """Build the exact MLX-LM server command for this project."""
    return [
        str(config.root / ".venv/bin/mlx_lm.server"),
        "--model",
        str(config.model_dir),
        "--host",
        config.host,
        "--port",
        str(config.port),
        "--decode-concurrency",
        str(config.decode_concurrency),
        "--prompt-concurrency",
        str(config.prompt_concurrency),
        "--prefill-step-size",
        str(config.prefill_step_size),
        "--prompt-cache-size",
        str(config.prompt_cache_size),
        "--prompt-cache-bytes",
        config.prompt_cache_bytes,
        "--max-tokens",
        str(config.max_tokens),
        "--chat-template-args",
        json.dumps({"enable_thinking": config.enable_thinking}, separators=(",", ":")),
    ]


def mlx_environment(
    config: ServiceConfig,
    base: dict[str, str] | os._Environ[str] | None = None,
) -> dict[str, str]:
    """Prevent runtime network model resolution and expose local imports."""
    environment = dict(os.environ if base is None else base)
    environment.update(
        {
            "HF_HUB_OFFLINE": "1",
            "TRANSFORMERS_OFFLINE": "1",
            "PYTHONPATH": str(config.root),
        }
    )
    return environment


def _pid_path(config: ServiceConfig, backend: str) -> Path:
    return config.runtime_dir / f"{backend}.pid"


def write_pid(
    config: ServiceConfig,
    pid: int,
    *,
    backend: str,
    command: list[str],
) -> Path:
    """Atomically persist enough process identity to stop it safely later."""
    config.runtime_dir.mkdir(parents=True, exist_ok=True)
    path = _pid_path(config, backend)
    temporary = path.with_suffix(".pid.tmp")
    temporary.write_text(
        json.dumps({"backend": backend, "command": command, "pid": pid}, indent=2)
        + "\n",
        encoding="utf-8",
    )
    temporary.replace(path)
    return path


def process_command(pid: int) -> str | None:
    """Return a process command line, or None when the PID no longer exists."""
    result = subprocess.run(
        ["ps", "-p", str(pid), "-o", "command="],
        check=False,
        capture_output=True,
        text=True,
    )
    command = result.stdout.strip()
    return command if result.returncode == 0 and command else None


def wait_for_port(
    host: str,
    port: int,
    *,
    timeout: float = 30,
    interval: float = 0.2,
    connector: Callable[[tuple[str, int], float], Any] = socket.create_connection,
) -> None:
    """Wait until the backend listener accepts a TCP connection."""
    deadline = time.monotonic() + timeout
    last_error: OSError | None = None
    while time.monotonic() < deadline:
        try:
            connection = connector((host, port), min(interval + 0.1, 1))
            connection.close()
            return
        except OSError as exc:
            last_error = exc
            time.sleep(interval)
    raise TimeoutError(f"{host}:{port} was not ready within {timeout:g}s") from last_error


def start_backend(backend: BackendName, config: ServiceConfig) -> int:
    """Start a managed backend in the background and return its PID."""
    if backend != "mlx":
        raise RuntimeError(f"backend {backend!r} is not prepared")
    if not (config.model_dir / "config.json").is_file():
        raise RuntimeError("local model is missing; run scripts/prepare.sh first")

    command = mlx_command(config)
    if not Path(command[0]).is_file():
        raise RuntimeError("MLX-LM is missing; run scripts/prepare.sh first")

    pid_path = _pid_path(config, backend)
    if pid_path.exists():
        record = json.loads(pid_path.read_text(encoding="utf-8"))
        if process_command(int(record["pid"])) is not None:
            raise RuntimeError(f"{backend} backend is already running")
        pid_path.unlink()

    config.runtime_dir.mkdir(parents=True, exist_ok=True)
    log_path = config.runtime_dir / f"{backend}.log"
    with log_path.open("ab", buffering=0) as log_file:
        child = subprocess.Popen(
            command,
            cwd=config.root,
            env=mlx_environment(config),
            stdout=log_file,
            stderr=subprocess.STDOUT,
            start_new_session=True,
        )
    time.sleep(1)
    if child.poll() is not None:
        tail = log_path.read_text(encoding="utf-8", errors="replace")[-4000:]
        raise RuntimeError(f"{backend} backend exited during startup:\n{tail}")
    try:
        wait_for_port(config.host, config.port)
    except TimeoutError:
        child.terminate()
        child.wait(timeout=15)
        raise
    write_pid(config, child.pid, backend=backend, command=command)
    return child.pid


def stop_backend(backend: str, config: ServiceConfig) -> None:
    """Stop only the process whose live identity matches the managed backend."""
    path = _pid_path(config, backend)
    if not path.exists():
        return
    record = json.loads(path.read_text(encoding="utf-8"))
    pid = int(record["pid"])
    actual = process_command(pid)
    if actual is None:
        path.unlink()
        return

    expected_marker = "mlx_lm.server" if backend == "mlx" else "sglang.launch_server"
    if expected_marker not in actual or str(config.model_dir) not in actual:
        raise RuntimeError(
            f"refusing to stop PID {pid}: command does not match managed {backend} backend"
        )

    os.kill(pid, signal.SIGTERM)
    deadline = time.monotonic() + 15
    while time.monotonic() < deadline:
        if process_command(pid) is None:
            path.unlink(missing_ok=True)
            return
        time.sleep(0.2)
    raise RuntimeError(f"{backend} backend PID {pid} did not stop within 15 seconds")


def _read_json(request: Request, timeout: float = 10) -> dict[str, object]:
    with urlopen(request, timeout=timeout) as response:
        return json.loads(response.read())


def healthcheck(
    config: ServiceConfig,
    run_completion: bool = True,
) -> dict[str, object]:
    """Require both HTTP readiness and a real minimal generation."""
    base = f"http://{config.host}:{config.port}"
    models = _read_json(Request(f"{base}/v1/models"))
    data = models.get("data")
    if not isinstance(data, list) or not data:
        raise RuntimeError("model endpoint returned no models")

    report: dict[str, object] = {"status": "ok", "models": data}
    if run_completion:
        body = json.dumps(
            {
                "messages": [{"role": "user", "content": "只回复 OK"}],
                "max_tokens": 8,
                "temperature": 0,
                "stream": False,
                "chat_template_kwargs": {"enable_thinking": False},
            }
        ).encode()
        completion = _read_json(
            Request(
                f"{base}/v1/chat/completions",
                data=body,
                headers={"Content-Type": "application/json"},
                method="POST",
            ),
            timeout=300,
        )
        try:
            content = completion["choices"][0]["message"]["content"]  # type: ignore[index]
        except (KeyError, IndexError, TypeError) as exc:
            raise RuntimeError("completion endpoint returned an invalid response") from exc
        report["completion"] = content
    return report
