# Qwen3.5-9B Local Serving Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Download Qwen3.5-9B 4-bit for offline use and provide a managed, OpenAI-compatible MLX/Metal service with reproducible cache experiments and an optional SGLang probe.

**Architecture:** A small standard-library Python control package owns configuration, safe process lifecycle, protocol probes, and benchmarks. Thin shell entry points invoke that package. MLX-LM 0.31.3 is the required inference backend; SGLang commit `27b7a2dc3baf6b93736540e35c1847efdfb56436` is isolated as an optional experiment so its failure cannot break the baseline.

**Tech Stack:** Python 3.12.13, MLX-LM 0.31.3, Hugging Face Hub 1.29.0, psutil 7.2.2, pytest 9.1.1, Bash, OpenAI-compatible HTTP/SSE.

**Spec:** `docs/superpowers/specs/2026-09-03-qwen35-local-serving-design.md`

## Global Constraints

- Target host is Apple M4 with 16GB unified memory and Metal 4.
- Model is `mlx-community/Qwen3.5-9B-4bit`, stored at `models/Qwen3.5-9B-4bit/` and excluded from Git.
- Runtime Python is exactly CPython 3.12.13 in project-local virtual environments.
- Default endpoint is `http://127.0.0.1:8000/v1` and must not bind externally.
- Default prefill and decode concurrency are both 1; five clients may wait on the backend queue.
- Default prompt cache holds one long-prefix entry and at most 1200 MB. This was reduced from the planned five entries/2 GiB after the 32K probe crossed the 1 GiB swap-growth safety limit; five clients still queue independently of retained cache entries.
- Text and tool calling are in scope; image input is out of scope.
- 32K, 64K, and 128K context/cache tests run in that order and stop escalating after memory instability.
- SGLang is optional and cannot block delivery of the MLX-LM baseline.

---

### Task 1: Project Contract and Typed Configuration

**Files:**
- Create: `.gitignore`
- Create: `pyproject.toml`
- Create: `requirements-mlx.txt`
- Create: `requirements-dev.txt`
- Create: `config/default.env`
- Create: `llm_service/__init__.py`
- Create: `llm_service/config.py`
- Test: `tests/test_config.py`

**Interfaces:**
- Produces: `ServiceConfig.load(root: Path, environ: Mapping[str, str] | None = None) -> ServiceConfig`
- Produces: immutable fields `host`, `port`, `model_id`, `model_dir`, `runtime_dir`, `prompt_cache_bytes`, `prompt_cache_size`, `prompt_concurrency`, `decode_concurrency`, and `max_tokens`
- Consumes: `config/default.env` plus process environment overrides prefixed with `QWEN_`

- [ ] **Step 1: Write failing configuration tests**

```python
def test_defaults_are_local_and_memory_bounded(tmp_path):
    cfg = ServiceConfig.load(tmp_path, {})
    assert cfg.host == "127.0.0.1"
    assert cfg.port == 8000
    assert cfg.prompt_cache_bytes == "1200MB"
    assert cfg.prompt_cache_size == 1
    assert cfg.prompt_concurrency == 1
    assert cfg.decode_concurrency == 1

def test_external_bind_is_rejected(tmp_path):
    with pytest.raises(ValueError, match="loopback"):
        ServiceConfig.load(tmp_path, {"QWEN_HOST": "0.0.0.0"})
```

- [ ] **Step 2: Run tests and confirm the missing module failure**

Run: `uv run --python 3.12.13 --with pytest==9.1.1 pytest tests/test_config.py -q`

Expected: FAIL because `llm_service.config` does not exist.

- [ ] **Step 3: Implement the immutable configuration object and defaults**

```python
@dataclass(frozen=True)
class ServiceConfig:
    root: Path
    host: str = "127.0.0.1"
    port: int = 8000
    model_id: str = "mlx-community/Qwen3.5-9B-4bit"
    prompt_cache_bytes: str = "1200MB"
    prompt_cache_size: int = 1
    prompt_concurrency: int = 1
    decode_concurrency: int = 1
    max_tokens: int = 2048

    @classmethod
    def load(cls, root: Path, environ: Mapping[str, str] | None = None) -> "ServiceConfig":
        values = read_env_file(root / "config/default.env")
        values.update(dict(environ if environ is not None else os.environ))
        cfg = cls(
            root=root.resolve(),
            host=values.get("QWEN_HOST", "127.0.0.1"),
            port=int(values.get("QWEN_PORT", "8000")),
            prompt_cache_bytes=values.get("QWEN_PROMPT_CACHE_BYTES", "1200MB"),
            prompt_cache_size=int(values.get("QWEN_PROMPT_CACHE_SIZE", "1")),
            prompt_concurrency=int(values.get("QWEN_PROMPT_CONCURRENCY", "1")),
            decode_concurrency=int(values.get("QWEN_DECODE_CONCURRENCY", "1")),
        )
        cfg.validate()
        return cfg
```

The implementation reads `config/default.env`, overlays `QWEN_*` values, resolves all paths under `root`, validates numeric ranges, and rejects hosts other than `127.0.0.1`, `localhost`, and `::1`.

- [ ] **Step 4: Add exact dependency and ignore contracts**

`requirements-mlx.txt` contains:

```text
huggingface-hub==1.29.0
mlx-lm==0.31.3
psutil==7.2.2
```

`requirements-dev.txt` contains `pytest==9.1.1`. `.gitignore` excludes `.venv*/`, `models/`, `runtime/`, `*.log`, caches, and raw benchmark JSON while retaining `results/*.md`.

- [ ] **Step 5: Verify and commit**

Run: `uv run --python 3.12.13 --with pytest==9.1.1 pytest tests/test_config.py -q`

Expected: PASS.

```bash
git add .gitignore pyproject.toml requirements-mlx.txt requirements-dev.txt config/default.env llm_service tests/test_config.py
git commit -m "feat: define local serving configuration"
```

### Task 2: Reproducible Environment and Model Download

**Files:**
- Create: `llm_service/prepare.py`
- Create: `scripts/prepare.sh`
- Test: `tests/test_prepare.py`
- Runtime output: `runtime/model-revision.json`

**Interfaces:**
- Produces: `check_host(root: Path, free_bytes: int | None = None) -> None`
- Produces: `download_model(model_id: str, model_dir: Path) -> dict[str, str | int]`
- Produces: idempotent `scripts/prepare.sh`
- Consumes: `ServiceConfig`

- [ ] **Step 1: Write failing host and manifest tests**

```python
def test_disk_check_requires_twelve_gib(tmp_path):
    with pytest.raises(RuntimeError, match="12 GiB"):
        check_host(tmp_path, free_bytes=11 * 1024**3)

def test_manifest_records_revision_and_size(tmp_path, monkeypatch):
    monkeypatch.setattr(prepare, "snapshot_download", fake_snapshot_download)
    result = download_model("mlx-community/Qwen3.5-9B-4bit", tmp_path / "model")
    assert result["model_id"] == "mlx-community/Qwen3.5-9B-4bit"
    assert result["revision"] == "0123456789abcdef"
    assert result["bytes"] == 4
```

- [ ] **Step 2: Run tests and confirm failure**

Run: `uv run --python 3.12.13 --with pytest==9.1.1 --with huggingface-hub==1.29.0 pytest tests/test_prepare.py -q`

Expected: FAIL because preparation functions do not exist.

- [ ] **Step 3: Implement safe checks and resumable download**

Use `platform.machine() == "arm64"`, `platform.system() == "Darwin"`, `shutil.disk_usage`, and `snapshot_download(repo_id=model_id, local_dir=str(model_dir), revision="main")`. Resolve the downloaded commit with `HfApi().model_info(model_id, revision="main").sha`, calculate actual file bytes, and atomically write `runtime/model-revision.json`.

- [ ] **Step 4: Implement the idempotent environment script**

```bash
#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
uv python install 3.12.13
uv venv --python 3.12.13 "$ROOT_DIR/.venv"
uv pip install --python "$ROOT_DIR/.venv/bin/python" -r "$ROOT_DIR/requirements-mlx.txt"
PYTHONPATH="$ROOT_DIR" "$ROOT_DIR/.venv/bin/python" -m llm_service.prepare
```

- [ ] **Step 5: Verify unit tests and shell syntax**

Run: `uv run --python 3.12.13 --with pytest==9.1.1 --with huggingface-hub==1.29.0 pytest tests/test_prepare.py -q && bash -n scripts/prepare.sh`

Expected: PASS.

- [ ] **Step 6: Download and verify the real model snapshot**

Run: `scripts/prepare.sh`

Expected: `models/Qwen3.5-9B-4bit/config.json` and safetensor shards exist, `runtime/model-revision.json` contains a 40-character revision and a byte count greater than 5 GiB, and a second execution reuses existing files.

- [ ] **Step 7: Commit the preparation workflow**

```bash
git add llm_service/prepare.py scripts/prepare.sh tests/test_prepare.py
git commit -m "feat: prepare MLX runtime and download model"
```

### Task 3: Managed MLX-LM Lifecycle

**Files:**
- Create: `llm_service/process.py`
- Create: `llm_service/cli.py`
- Create: `scripts/start-mlx.sh`
- Create: `scripts/stop.sh`
- Create: `scripts/health.sh`
- Test: `tests/test_process.py`
- Runtime output: `runtime/mlx.pid`, `runtime/mlx.log`

**Interfaces:**
- Produces: `mlx_command(cfg: ServiceConfig) -> list[str]`
- Produces: `start_backend(name: Literal["mlx", "sglang"], cfg: ServiceConfig) -> int`
- Produces: `stop_backend(name: str, cfg: ServiceConfig) -> None`
- Produces: `healthcheck(cfg: ServiceConfig, run_completion: bool = True) -> dict[str, object]`
- Consumes: `.venv/bin/mlx_lm.server` and local model directory

- [ ] **Step 1: Write failing command and PID-safety tests**

```python
def test_mlx_command_exposes_cache_controls(config):
    cmd = mlx_command(config)
    assert cmd[:2] == [str(config.root / ".venv/bin/mlx_lm.server"), "--model"]
    assert pair(cmd, "--decode-concurrency") == "1"
    assert pair(cmd, "--prompt-concurrency") == "1"
    assert pair(cmd, "--prompt-cache-size") == "1"
    assert pair(cmd, "--prompt-cache-bytes") == "1200MB"

def test_stop_refuses_unrelated_pid(config, monkeypatch):
    write_pid(config, 4242, backend="mlx")
    monkeypatch.setattr(process, "process_command", lambda pid: "/usr/bin/python unrelated.py")
    with pytest.raises(RuntimeError, match="refusing"):
        stop_backend("mlx", config)
```

- [ ] **Step 2: Run tests and confirm failure**

Run: `uv run --python 3.12.13 --with pytest==9.1.1 pytest tests/test_process.py -q`

Expected: FAIL because lifecycle functions do not exist.

- [ ] **Step 3: Implement command construction and safe lifecycle**

The MLX command must include the local model path, loopback host, port 8000, `--decode-concurrency 1`, `--prompt-concurrency 1`, `--prefill-step-size 2048`, `--prompt-cache-size 1`, `--prompt-cache-bytes 1200MB`, `--max-tokens 2048`, and `--chat-template-args '{"enable_thinking":true}'`.

Start uses `subprocess.Popen(cmd, stdout=log_file, stderr=subprocess.STDOUT, start_new_session=True)` and writes PID only after the process remains alive. Stop reads only the project PID file, checks the command contains both `mlx_lm.server` and the resolved model path, sends `SIGTERM`, waits up to 15 seconds, and never sends a signal when validation fails.

- [ ] **Step 4: Add thin shell entry points**

Each shell script resolves `ROOT_DIR`, sets `PYTHONPATH`, invokes `.venv/bin/python -m llm_service.cli`, and forwards arguments without evaluating them.

- [ ] **Step 5: Verify and commit**

Run: `uv run --python 3.12.13 --with pytest==9.1.1 pytest tests/test_process.py -q && bash -n scripts/start-mlx.sh scripts/stop.sh scripts/health.sh`

Expected: PASS.

```bash
git add llm_service/process.py llm_service/cli.py scripts/start-mlx.sh scripts/stop.sh scripts/health.sh tests/test_process.py
git commit -m "feat: manage MLX inference service"
```

### Task 4: OpenAI Protocol and Five-Client Smoke Tests

**Files:**
- Create: `llm_service/client.py`
- Create: `llm_service/smoke.py`
- Create: `scripts/smoke.sh`
- Test: `tests/test_client.py`

**Interfaces:**
- Produces: `chat(base_url: str, messages: list[dict], *, stream: bool = False, tools: list[dict] | None = None, max_tokens: int = 64) -> dict | Iterator[dict]`
- Produces: `run_smoke(base_url: str, concurrency: int = 5) -> SmokeReport`
- Consumes: OpenAI-compatible `/v1/models` and `/v1/chat/completions`

- [ ] **Step 1: Write failing JSON and SSE client tests using a local stub server**

```python
def test_non_streaming_chat_decodes_message(stub_server):
    response = chat(stub_server.url, [{"role": "user", "content": "你好"}])
    assert response["choices"][0]["message"]["content"] == "你好"

def test_streaming_chat_stops_at_done(stub_sse_server):
    chunks = list(chat(stub_sse_server.url, [{"role": "user", "content": "hi"}], stream=True))
    assert "".join(c["choices"][0]["delta"].get("content", "") for c in chunks) == "hello"
```

- [ ] **Step 2: Run tests and confirm failure**

Run: `uv run --python 3.12.13 --with pytest==9.1.1 pytest tests/test_client.py -q`

Expected: FAIL because the HTTP client does not exist.

- [ ] **Step 3: Implement protocol client with bounded timeouts**

Use `urllib.request` from the standard library. Connect timeout is 10 seconds; request timeout is 300 seconds. SSE parsing accepts `data: <JSON object>` records and terminates only at `data: [DONE]`. HTTP errors preserve status and response body in the raised exception.

- [ ] **Step 4: Implement real smoke scenarios**

The smoke command runs: model listing, one Chinese response, one streamed response, a two-turn conversation, a weather-tool request using an OpenAI function schema, and five concurrent eight-token responses. Each scenario has an explicit deadline and is recorded as pass/fail without hiding unsupported tool-call formatting.

- [ ] **Step 5: Verify and commit**

Run: `uv run --python 3.12.13 --with pytest==9.1.1 pytest tests/test_client.py -q && bash -n scripts/smoke.sh`

Expected: PASS.

```bash
git add llm_service/client.py llm_service/smoke.py scripts/smoke.sh tests/test_client.py
git commit -m "test: add OpenAI protocol smoke coverage"
```

### Task 5: KV and Prompt Cache Benchmark Harness

**Files:**
- Create: `llm_service/benchmark.py`
- Create: `scripts/bench-cache.sh`
- Create: `config/experiments/32k.env`
- Create: `config/experiments/64k.env`
- Create: `config/experiments/128k.env`
- Test: `tests/test_benchmark.py`
- Runtime output: `runtime/results/*.json`
- Report output: `results/cache-baseline.md`

**Interfaces:**
- Produces: `calibrate_prompt(target_tokens: int, measure: Callable[[str], int]) -> str`
- Produces: `run_cache_scenario(base_url: str, target_tokens: int, service_pid: int) -> list[Measurement]`
- Produces: measurements for `cold`, `shared_prefix_hot`, and `different_prefix`
- Consumes: server-reported token usage and `psutil.Process(service_pid).memory_info().rss`

- [ ] **Step 1: Write failing calibration and metrics tests**

```python
def test_calibration_converges_within_two_percent():
    prompt = calibrate_prompt(32_768, lambda text: len(text.split()))
    count = len(prompt.split())
    assert abs(count - 32_768) / 32_768 <= 0.02

def test_hot_measurement_reuses_same_prefix():
    calls = fake_chat_calls()
    records = run_cache_scenario(calls.url, 1024, calls.pid)
    assert [record.scenario for record in records] == ["cold", "shared_prefix_hot", "different_prefix"]
    assert calls.payloads[0]["messages"][0] == calls.payloads[1]["messages"][0]
```

- [ ] **Step 2: Run tests and confirm failure**

Run: `uv run --python 3.12.13 --with pytest==9.1.1 --with psutil==7.2.2 pytest tests/test_benchmark.py -q`

Expected: FAIL because benchmark functions do not exist.

- [ ] **Step 3: Implement token calibration and measurements**

Calibrate using the server's `usage.prompt_tokens`, adjusting repetitions until within 2% of the requested size. Record wall-clock time, time to first SSE token, completion tokens/second, process RSS before/peak/after, HTTP status, and backend/model metadata. Generate unique fixed prefixes from deterministic seeds so repeated runs are comparable.

- [ ] **Step 4: Implement staged escalation**

`scripts/bench-cache.sh 32k` runs the 32K profile. The 64K command is permitted only after `runtime/results/32k.json` records success; 128K similarly requires a successful 64K record. Abort the current profile when swap grows by 1 GiB, RSS exceeds the host recommended working set, the process exits, or a request exceeds 20 minutes.

- [ ] **Step 5: Verify synthetic benchmark tests and commit**

Run: `uv run --python 3.12.13 --with pytest==9.1.1 --with psutil==7.2.2 pytest tests/test_benchmark.py -q && bash -n scripts/bench-cache.sh`

Expected: PASS.

```bash
git add llm_service/benchmark.py scripts/bench-cache.sh config/experiments tests/test_benchmark.py results/cache-baseline.md
git commit -m "feat: add staged cache benchmark harness"
```

### Task 6: Optional SGLang Apple-Metal Probe

**Files:**
- Create: `scripts/prepare-sglang.sh`
- Create: `scripts/start-sglang.sh`
- Create: `results/sglang-compatibility.md`
- Modify: `llm_service/process.py`
- Modify: `llm_service/cli.py`
- Test: `tests/test_sglang.py`
- Runtime output: `.venv-sglang/`, `runtime/sglang-src/`, `runtime/sglang.pid`, `runtime/sglang.log`

**Interfaces:**
- Produces: `sglang_command(cfg: ServiceConfig) -> list[str]`
- Consumes: SGLang source commit `27b7a2dc3baf6b93736540e35c1847efdfb56436`
- Reuses: Task 4 protocol smoke tests and Task 5 benchmark format

- [ ] **Step 1: Write a failing exact-command test**

```python
def test_sglang_command_uses_mlx_and_disables_cuda_graph(config):
    env, cmd = sglang_command(config)
    assert env["SGLANG_USE_MLX"] == "1"
    assert "--disable-cuda-graph" in cmd
    assert pair(cmd, "--model-path") == str(config.model_dir)
    assert pair(cmd, "--host") == "127.0.0.1"
```

- [ ] **Step 2: Run the test and confirm failure**

Run: `uv run --python 3.12.13 --with pytest==9.1.1 pytest tests/test_sglang.py -q`

Expected: FAIL because the SGLang builder does not exist.

- [ ] **Step 3: Implement isolated preparation and launch**

Clone only the pinned SGLang commit into `runtime/sglang-src`, create `.venv-sglang` with Python 3.12.13, install its `all_mps` extra according to the Apple Metal documentation, and never modify `.venv` or the MLX-LM requirements. Launch with `SGLANG_USE_MLX=1`, the local model, `--disable-cuda-graph`, loopback host, and port 8001 so both backends can be compared.

- [ ] **Step 4: Run the protocol and short cache probes**

Run the same ordinary, streaming, multi-turn, tool, and five-client smoke suite against `http://127.0.0.1:8001/v1`. If startup or any required behavior fails, capture package versions, command, final 200 log lines, and failure classification in `results/sglang-compatibility.md`; stop there and keep MLX-LM as default.

- [ ] **Step 5: Verify and commit the optional integration**

Run: `uv run --python 3.12.13 --with pytest==9.1.1 pytest tests/test_sglang.py -q && bash -n scripts/prepare-sglang.sh scripts/start-sglang.sh`

Expected: PASS for local command construction regardless of whether the external SGLang runtime passes its real probe.

```bash
git add scripts/prepare-sglang.sh scripts/start-sglang.sh results/sglang-compatibility.md llm_service/process.py llm_service/cli.py tests/test_sglang.py
git commit -m "feat: add optional SGLang Metal probe"
```

### Task 7: Operator, API, and Module Documentation

**Files:**
- Create: `README.md`
- Create: `docs/API.md`
- Create: `docs/MODULES.md`
- Test: `tests/test_docs.py`

**Interfaces:**
- Documents: the exact commands and public interfaces produced by Tasks 1–6
- Consumes: verified real model name, endpoint, script names, configuration keys, and observed backend status

- [ ] **Step 1: Write failing documentation contract tests**

```python
@pytest.mark.parametrize("path, required", [
    ("README.md", ["scripts/prepare.sh", "scripts/start-mlx.sh", "scripts/health.sh"]),
    ("docs/API.md", ["/v1/models", "/v1/chat/completions", "stream", "tools", "429"]),
    ("docs/MODULES.md", ["llm_service.config", "llm_service.process", "prompt-cache-bytes", "SGLang"]),
])
def test_documentation_contract(path, required):
    text = Path(path).read_text()
    assert all(term in text for term in required)
```

- [ ] **Step 2: Run tests and confirm missing-document failures**

Run: `uv run --python 3.12.13 --with pytest==9.1.1 pytest tests/test_docs.py -q`

Expected: FAIL because the three user-facing documents do not exist.

- [ ] **Step 3: Write the operator README**

Document prerequisites, one-command preparation, model size and location, start/health/stop flow, curl and Python examples, offline behavior, logs, default cache limits, concurrency behavior, and troubleshooting based on observed errors.

- [ ] **Step 4: Write the API documentation**

Document request and response JSON, SSE chunks and `[DONE]`, supported parameters, tool schema and tool-call response, timeouts, backend-native error bodies, local-only security, Base URL `http://127.0.0.1:8000/v1`, and model alias `mlx-community/Qwen3.5-9B-4bit`.

- [ ] **Step 5: Write the module documentation**

Document every `llm_service` module and script, configuration precedence, PID/log ownership, prepare/start/request/stop data flow, Prompt Cache controls, experiment escalation gates, runtime artifacts, and the exact backend substitution seam.

- [ ] **Step 6: Verify all automated tests and real service**

Run:

```bash
uv run --python 3.12.13 --with pytest==9.1.1 --with huggingface-hub==1.29.0 --with psutil==7.2.2 pytest -q
scripts/start-mlx.sh
scripts/health.sh
scripts/smoke.sh
scripts/bench-cache.sh 32k
scripts/stop.sh
```

Expected: all tests pass; health and smoke report success; stop removes the PID file and leaves no managed server process.

- [ ] **Step 7: Commit documentation and final verified status**

```bash
git add README.md docs/API.md docs/MODULES.md tests/test_docs.py results
git commit -m "docs: add local serving maintenance guides"
```
