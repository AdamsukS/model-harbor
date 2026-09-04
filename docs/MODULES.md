# Modules and maintenance

## Runtime shape

```text
local client / future Agent gateway
              |
              v
   OpenAI-compatible HTTP :8000
              |
              v
       MLX-LM scheduler
   prompt concurrency = 1
   decode concurrency = 1
              |
              v
 local Qwen3.5-9B 4-bit + prompt/KV cache
```

Five clients can submit requests together; the conservative single prompt/decode
slots serialize expensive work and protect a 16 GiB machine. This is scheduling,
not strict admission control. A later gateway should own identities, quotas,
cancellation, an explicitly bounded queue, summaries, retrieval, and memory.

## Python modules

| Module | Responsibility |
|---|---|
| `llm_service.config` | Strictly parses `QWEN_*` settings, resolves paths, rejects non-loopback binding, and validates cache sizes/concurrency. |
| `llm_service.prepare` | Verifies Apple Silicon, downloads the pinned model snapshot into `models/`, validates required files, and records revision/size metadata. |
| `llm_service.process` | Builds backend commands, forces offline runtime model resolution, starts/stops only PID-verified managed processes, waits for readiness, and performs a real generation health check. |
| `llm_service.client` | Minimal OpenAI-compatible JSON/SSE client. It pins `default_model`, preserves HTTP errors, supports thinking and tools, and parses `[DONE]`. |
| `llm_service.smoke` | Exercises models, normal chat, streaming, multi-turn context, structured tool calls, and 5 concurrent client requests. |
| `llm_service.benchmark` | Generates deterministic long prompts, measures cold/hot/control prefix behavior, records cached tokens and TTFT, gates profile order, and enforces the swap watchdog. |
| `llm_service.cli` | Thin command-line entry point used by lifecycle scripts. |

## Configuration

`config/default.env` is loaded first. Process environment variables whose names
start with `QWEN_` override it. The parser does not execute shell expressions.
The important defaults are:

```dotenv
QWEN_HOST=127.0.0.1
QWEN_PORT=8000
QWEN_PROMPT_CACHE_SIZE=1
QWEN_PROMPT_CACHE_BYTES=1200MB
QWEN_PROMPT_CONCURRENCY=1
QWEN_DECODE_CONCURRENCY=1
QWEN_PREFILL_STEP_SIZE=2048
QWEN_MAX_TOKENS=2048
QWEN_ENABLE_THINKING=true
```

The one-entry, 1200MB cache setting is intentional. A trial with five cache
entries and a 2GB nominal cap retained several large cache objects and crossed
the 1 GiB swap-growth safety threshold. One 32K prefix is about 1.12GB in the
observed MLX log and gives useful reuse without retaining multiple long sessions.
The maximum generated tokens is not the input context limit.

To test a temporary setting without editing the file:

```bash
QWEN_ENABLE_THINKING=false scripts/start-mlx.sh
```

Environment overrides apply when the server process is started. Stop it before
starting again with different values.

## Files and process state

- `models/Qwen3.5-9B-4bit/` contains the ignored, local 5.57 GiB snapshot.
- `.venv/` is the ignored pinned MLX Python environment.
- `.venv-sglang/` is the ignored optional SGLang experiment environment.
- `runtime/model-revision.json` records the resolved model commit and byte size.
- `runtime/mlx.pid` stores PID, backend, and full command for safe shutdown.
- `runtime/mlx.log` is append-only backend output.
- `runtime/results/*.json` contains detailed machine-readable benchmark runs.
- `results/*.md` contains committed summaries and compatibility evidence.

`scripts/stop.sh` checks the live command line against both the expected backend
marker and local model path. It refuses to signal a reused or unrelated PID.

## KV/prompt-cache experiments

Profiles are 32K, 64K, and 128K tokens. Each profile measures:

1. a cold deterministic shared prefix;
2. the same prefix with a different final question;
3. an unrelated control prefix.

The second request demonstrates cache reuse; the third helps distinguish reuse
from generally warmed model execution. JSON results include prompt tokens,
cached tokens, time-to-first-token, total latency, generation throughput, RSS,
versions, model revision, cache settings, and swap before/after.

Safety gates require successful completion in ascending order: 32K, then 64K,
then 128K. A polling watchdog terminates the managed benchmark backend when swap
has grown by 1 GiB from the baseline. If that happens, inspect the JSON/log,
restart with `scripts/start-mlx.sh`, and do not proceed to the next profile.

The successful 32K baseline with one 1200MB entry measured:

| Scenario | Prompt tokens | Cached tokens | TTFT |
|---|---:|---:|---:|
| cold | 32,728 | 0 | 197.879 s |
| shared prefix hot | 32,727 | 32,714 | 0.843 s |
| unrelated control | 32,721 | 0 | 202.759 s |

This proves high-value prefix reuse. It does not prove that 128K will fit
comfortably on 16 GiB. For future Agent work, keep stable system/tool prefixes
cacheable, bound recent raw history, summarize older turns, retrieve only
relevant memory, and trim deterministically to the chosen token budget.

## Backend boundary and SGLang

`llm_service.process` contains the backend seam. MLX-LM is the supported default.
The isolated SGLang setup is pinned and reproducible, but its current Apple Metal
runtime cannot start Qwen3.5-9B because the model's hybrid-Mamba setup asserts a
CUDA/MUSA/NPU/ROCm/XPU-only extra-buffer path. See
`results/sglang-compatibility.md`. Do not switch production startup to SGLang
until that upstream path supports Metal and the full smoke/cache suite passes.

## Verification after changes

```bash
.venv/bin/pytest -q
scripts/health.sh
scripts/smoke.sh
```

Configuration, protocol clients, lifecycle guards, benchmark logic, and document
contracts all have automated tests. Long-context benchmarks are deliberately not
part of the fast unit-test suite.
