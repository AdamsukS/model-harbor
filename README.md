# ModelHarbor

[简体中文](README.zh-CN.md)

ModelHarbor is a local-first, multi-model Agent runtime for personal hardware. The current
`next` architecture uses:

- [Hypha](https://github.com/AdamsukS/Hypha) for the versioned Agent and DomainPack contract;
- [Plasmod](https://github.com/AdamsukS/Plasmod) for scoped, durable Agent memory;
- [Ollama](https://ollama.com/) for native Apple Silicon inference without Python;
- a TypeScript gateway for bounded admission, context assembly, and an OpenAI-compatible API.

The repository name and public API are model-neutral. Qwen3.5-9B is only the first local model
profile.

## Status

- Default branch: `next` (TypeScript + Go + native inference, no Python runtime)
- Previous baseline: `main` (MLX-LM/Python)
- API: `http://127.0.0.1:8787/v1`
- Inference model: `qwen3.5:9b-q4_K_M`, exposed locally as `qwen3.5:9b-128k`
- Requested context: 128K tokens
- Scheduling: one generation at a time, five total admitted requests, five admitted users maximum
- Memory: Plasmod disk storage with scoped tenant/user/Session retrieval
- Network scope: loopback only

The existing `models/Qwen3.5-9B-4bit` MLX snapshot is preserved and ignored by Git. Ollama cannot
consume that directory directly, so the Ollama/GGUF profile is downloaded separately.

## Architecture

```text
Client
  -> ModelHarbor :8787
       -> FIFO admission (1 active / 5 admitted users)
       -> Hypha DomainPack contract
       -> Plasmod recall :8080
       -> bounded context assembly
       -> Ollama inference :11434
       -> Plasmod interaction ingest :8080
```

Hypha and Plasmod are not vendored or added as submodules. `scripts/prepare.sh` checks out pinned
revisions of the user's forks under the ignored `.runtime/` directory. ModelHarbor consumes the
published Hypha npm packages through the framework's documented product boundary.

## Requirements

- macOS on Apple Silicon
- Node.js 22 or newer, including npm
- pnpm 11
- Go 1.25 or newer
- Ollama
- about 8 GiB additional disk space for the Ollama model and build caches

Homebrew can install the missing system tools:

```bash
brew install node pnpm go ollama
```

## Quick start

```bash
pnpm install
pnpm run runtime:prepare
pnpm start
pnpm run health
pnpm run smoke
```

Preparation is idempotent. It refuses to change a dirty Hypha or Plasmod checkout. Runtime state,
logs, PID files, Plasmod data, and source checkouts stay outside Git.

Stop only the processes launched by ModelHarbor:

```bash
pnpm stop
```

This preserves models, memory data, fork checkouts, and the older MLX environments.

## Request example

Every scoped operation requires `X-User-ID` and `X-Session-ID`:

```bash
curl http://127.0.0.1:8787/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -H 'X-User-ID: local-user-1' \
  -H 'X-Session-ID: session-1' \
  -d '{
    "model": "local-default",
    "stream": false,
    "messages": [{"role": "user", "content": "Reply with OK only."}]
  }'
```

Phase one supports non-streaming chat. Tool execution, MCP, the complete Hypha production Harness,
automatic memory summarization, and direct llama.cpp KV experiments will be added incrementally.

## 128K and KV cache

The Ollama model profile requests `131072` tokens and starts with Flash Attention, one loaded model,
one parallel generation, and a quantized `q4_0` KV cache. ModelHarbor also limits the assembled
prompt to 360,000 characters, retaining the newest turns first and truncating recalled memory.

On a 16 GiB Mac, 128K is an experimental capacity target rather than a guarantee for every prompt.
Model weights, KV cache, runtime buffers, Plasmod, and Node share unified memory. The next inference
backend can be direct llama.cpp behind the existing `InferenceClient` boundary for finer slot,
prefix, and KV-cache experiments.

## Documentation

- [API reference](docs/API.md)
- [Modules and maintenance](docs/MODULES.md)
- [Operations guide](docs/OPERATIONS.md)
- [Architecture design](docs/superpowers/specs/2026-09-04-hypha-plasmod-local-runtime-design.md)
