# Modules and maintenance

## Product/runtime boundary

ModelHarbor owns the API and product composition. Hypha owns generic Agent contracts and Harness
capabilities. Plasmod owns durable cognitive objects, evidence, and retrieval. Ollama owns model
loading, Metal execution, and its native KV cache.

The two source forks are pinned in `config/runtime-sources.json` and checked out beneath ignored
`.runtime/`. They are not copied, patched, or committed as part of ModelHarbor.

## TypeScript modules

| Module | Responsibility |
|---|---|
| `src/config.ts` | Strict environment parsing, local defaults, five-user bound, and immutable runtime-source validation. |
| `src/agent-contract.ts` | Loads and compiles `agent/domain-pack.yaml` through `@codesoul-co/hypha-domain`. |
| `src/admission-queue.ts` | FIFO admission, single inference concurrency, request bound, and distinct-user accounting. |
| `src/context.ts` | Marks recalled data as untrusted, preserves recent turns, and enforces a deterministic character budget. |
| `src/plasmod-client.ts` | Scoped `/v1/query`, Dynamic Event v0.4 ingest, health, and memory-text extraction. |
| `src/ollama-client.ts` | Provider-neutral inference interface and Ollama `/api/chat` protocol adapter. |
| `src/dependency-error.ts` | Timeouts, JSON/status normalization, and dependency error classification. |
| `src/service.ts` | HTTP validation, readiness, memory/inference orchestration, OpenAI-compatible response, and shutdown. |
| `src/main.ts` | Production composition and signal handling. |

## Agent definition

`agent/domain-pack.yaml` declares:

- `task.local-chat` and its input schema;
- `workflow.local-chat` with completed and failed terminal states;
- `memory.plasmod` with required provenance and scoped retrieval;
- `context.local-chat` with a 128K token budget;
- `reasoning.local-chat` for bounded structured ReAct evolution;
- a local multi-user deployment profile.

Phase one compiles and consumes this contract but does not claim to execute every full Hypha
Production Harness worker. The contract is designed to move into the complete Hypha server later.

## Memory lifecycle

For each successful Chat request:

1. derive tenant, workspace/user, Agent, and Session scope;
2. query only Memory objects from Plasmod;
3. insert extracted evidence into a tagged untrusted system block;
4. generate through the inference interface;
5. ingest a strict, stable-ID Plasmod event containing user and assistant text.

Plasmod's canonical object and WAL storage are authoritative. Prompt projections and Ollama KV
state are disposable acceleration layers.

## Inference and KV extension point

`InferenceClient` has `health()` and `chat()` operations. The service does not depend directly on
Ollama response types outside `src/ollama-client.ts`. A future llama.cpp adapter can implement the
same interface and expose additional diagnostics separately.

The current startup settings are conservative for 16 GiB unified memory:

```text
OLLAMA_NUM_PARALLEL=1
OLLAMA_MAX_QUEUE=5
OLLAMA_MAX_LOADED_MODELS=1
OLLAMA_FLASH_ATTENTION=1
OLLAMA_KV_CACHE_TYPE=q4_0
```

Changing the configured context or KV type requires restarting the Ollama process that
ModelHarbor manages.

## Tests

```bash
pnpm test
pnpm run typecheck
pnpm run build
```

Tests use real local HTTP servers for Ollama/Plasmod protocol boundaries and real temporary Git
repositories for lifecycle behavior. They do not require a loaded model. The live smoke test is a
separate operation because it can take minutes and consumes model memory.
