# ModelHarbor

[简体中文](README.zh-CN.md)

ModelHarbor is a local-first inference service and experimentation toolkit for
running, benchmarking, and evolving multiple large-language-model backends on
personal hardware.

The first supported runtime is Qwen3.5-9B on Apple Silicon through MLX-LM. The
project-level interfaces are intentionally backend-neutral so more local models
and inference engines can be added later. Agent orchestration, durable memory,
summarization, retrieval, and context trimming are planned as a separate layer.

## Current status

- API: `http://127.0.0.1:8000/v1`
- current model: `mlx-community/Qwen3.5-9B-4bit`
- API model alias: `default_model`
- model revision: `8b2b98c00a6b4d291155e4890773ca8f769aee53`
- local model size: about 5.57 GiB
- backend: MLX-LM + MLX + Apple Metal
- concurrency target: 5 simultaneous clients have completed successfully
- context target: 128K; 32K is verified, while 64K and 128K are staged experiments
- default cache: one retained prompt cache capped at `1200MB`
- network scope: loopback only, with no authentication layer
- SGLang: installed and tested, but currently blocked by its Qwen3.5 hybrid
  Mamba support on Apple Metal

## Quick start

Requirements: Apple Silicon macOS, about 8 GiB of free disk space, and
[`uv`](https://docs.astral.sh/uv/). From this repository, run:

```bash
scripts/prepare.sh
scripts/start-mlx.sh
scripts/health.sh
scripts/smoke.sh
```

`prepare.sh` is idempotent: it creates the pinned Python environment and reuses
model files that are already downloaded. `start-mlx.sh` waits for the port to
become ready and writes a managed PID record under the ignored `runtime/`
directory.

Stop the service with:

```bash
scripts/stop.sh
```

Logs are stored in `runtime/mlx.log`. A minimal request is:

```bash
curl http://127.0.0.1:8000/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "default_model",
    "messages": [{"role": "user", "content": "Reply with OK only."}],
    "max_tokens": 16,
    "chat_template_kwargs": {"enable_thinking": false}
  }'
```

Always use `default_model` against the current MLX endpoint. Passing a Hugging
Face repository ID tells MLX-LM to dynamically resolve another model, while
this project intentionally disables network model resolution at runtime.

## Cache experiments

Prompt and decode concurrency both default to `1`. Requests arriving together
wait inside the backend instead of making five decode streams compete for 16 GiB
of unified memory. `scripts/smoke.sh` has verified 5 concurrent clients complete
successfully. This is an operating target rather than hard admission control;
a future Agent Gateway should implement identities, quotas, and an explicitly
bounded queue.

Run cache experiments in order:

```bash
scripts/bench-cache.sh 32k
scripts/bench-cache.sh 64k
scripts/bench-cache.sh 128k
```

The 64K profile requires a successful 32K result, and 128K requires a successful
64K result. Every request has a swap watchdog that terminates the benchmark
backend if swap grows by 1 GiB from the warmed baseline. The verified 32K run
reused 32,714 cached tokens and reduced time to first token from `197.879s` to
`0.843s`.

On this 16 GiB machine, 128K is an experimental goal rather than a stable
production guarantee. The future Agent layer should combine a recent-message
window with memory retrieval, summarization, and deterministic trimming.

## Documentation

- [API contract](docs/API.md)
- [Modules and maintenance](docs/MODULES.md)
- [KV-cache baseline](results/cache-baseline.md)
- [SGLang compatibility result](results/sglang-compatibility.md)
