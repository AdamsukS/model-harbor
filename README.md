# Local Qwen3.5-9B service

This project runs `mlx-community/Qwen3.5-9B-4bit` locally on Apple Silicon and
exposes an OpenAI-compatible HTTP API. The current baseline is deliberately
small and inspectable: MLX-LM serves the model, up to 5 simultaneous client
requests have been verified, and prompt/KV-cache experiments are reproducible.
Agent orchestration, durable memory, summarization, and context trimming are
future layers rather than part of this first service.

## Current status

- API: `http://127.0.0.1:8000/v1`
- model request alias: `default_model`
- model revision: `8b2b98c00a6b4d291155e4890773ca8f769aee53`
- local model size: about 5.57 GiB
- context target: 128K; 32K is verified, while 64K and 128K are gated experiments
- default cache: one retained prefix, capped at `1200MB`
- network exposure: loopback only; no authentication layer
- optional SGLang: installed and probed, but currently blocked for this model on
  Apple Metal by SGLang's hybrid-Mamba platform assertion

## Start here

Requirements: Apple Silicon macOS, about 8 GiB free disk space, and
[`uv`](https://docs.astral.sh/uv/). From this repository:

```bash
scripts/prepare.sh
scripts/start-mlx.sh
scripts/health.sh
scripts/smoke.sh
```

`prepare.sh` is idempotent: it creates the pinned Python environment and reuses
already downloaded model files. `start-mlx.sh` waits until the port is ready and
writes a managed PID record under the ignored `runtime/` directory.

To stop only the managed MLX process:

```bash
scripts/stop.sh
```

Logs are at `runtime/mlx.log`. A minimal request is:

```bash
curl http://127.0.0.1:8000/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "default_model",
    "messages": [{"role": "user", "content": "你好，只回复 OK"}],
    "max_tokens": 16,
    "chat_template_kwargs": {"enable_thinking": false}
  }'
```

Always use `default_model` against this direct MLX endpoint. Passing a Hugging
Face repository ID tells MLX-LM to dynamically resolve another model; runtime
offline mode intentionally prevents that.

## Capacity and cache experiments

The default prompt and decode concurrency are both `1`. Requests arriving at the
same time wait inside the backend instead of making five simultaneous decode
streams compete for 16 GiB unified memory. `scripts/smoke.sh` has verified 5
simultaneous clients complete successfully. This is an operating target, not a
hard admission-control limit; add a gateway later if strict per-user quotas or
an explicit bounded queue are required.

Run cache experiments only in order:

```bash
scripts/bench-cache.sh 32k
scripts/bench-cache.sh 64k
scripts/bench-cache.sh 128k
```

The 64K run requires a successful 32K result, and 128K requires a successful
64K result. Every request has a watchdog that terminates the benchmark backend
if system swap grows by 1 GiB from the warmed baseline. The verified 32K run
reused 32,714 cached tokens and reduced time-to-first-token from 197.879 s to
0.843 s. See `results/cache-baseline.md` for the full measurements.

On this 16 GiB machine, 128K is an experimental goal rather than a guaranteed
stable production setting. The later Agent layer should combine a recent-message
window with retrieval, summarization, and deterministic trimming before prompts
reach the model.

## Documentation

- [API contract](docs/API.md)
- [Modules and maintenance](docs/MODULES.md)
- [SGLang compatibility result](results/sglang-compatibility.md)
- [KV-cache baseline](results/cache-baseline.md)

