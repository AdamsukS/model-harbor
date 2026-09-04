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
| `src/context.ts` | Marks recalled data as untrusted, preserves recent turns, enforces a deterministic character budget, and reports trimming diagnostics. |
| `src/plasmod-client.ts` | Scoped recall/listing, Dynamic Event v0.4 ingest, benchmark Artifact persistence, health, and metrics. |
| `src/ollama-client.ts` | Provider-neutral inference interface and Ollama `/api/chat` protocol adapter. |
| `src/dependency-error.ts` | Timeouts, JSON/status normalization, and dependency error classification. |
| `src/service.ts` | HTTP validation, readiness, memory/inference orchestration, Bench APIs/static assets, OpenAI-compatible response, and shutdown. |
| `src/main.ts` | Production composition and signal handling. |
| `src/inference-gateway.ts` | Separate authenticated text inference endpoint; bounded admission, OpenAI/SSE envelopes, backend usage and inference metadata. |
| `scripts/sharing.mjs`, `config/sharing.example.json` | Private deployment configuration, key lifecycle, Caddy/SSH/service rendering, and credential-free client handoff documents. No cloud-provider API dependencies. |
| `src/tool-runtime.ts` | Official Hypha ToolRegistry/GovernedToolRunner, native tool adapters, owner-token authorization, bounded Ollama tool loop. |
| `src/mcp-search.ts`, `config/mcp.json` | Reviewed Exa MCP search binding, Hypha connection management, egress/result bounds, and connection cleanup. |
| `scripts/check-web-search.ts` | Live model → Hypha → Exa MCP smoke check with local traces and memory writes disabled. |
| `scripts/apple-tools.js` | Static read-only macOS JavaScript for Automation; arguments are data, never executable source. |
| `scripts/eval-memory.ts` | Reproducible live-model recall-on/off and user-isolation probes; writes local evidence under runtime/evals. |

## Agent Bench

`web/` is a React/Vite single-page interface served by the same ModelHarbor process. It calls only
ModelHarbor endpoints; Plasmod's admin/data APIs are not exposed directly to browser code. The four
views are Chat, History, Memory, and Runtime. There is deliberately no frontend database or router.

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
5. ingest a strict, stable-ID Plasmod event containing user and assistant text;
6. persist the completed turn measurements as a scoped canonical Plasmod Artifact linked by the
   originating event ID.

Plasmod's canonical object and WAL storage are authoritative. Prompt projections and Ollama KV
state are disposable acceleration layers. Startup replays the retained WAL through Plasmod's
official admin endpoint so its in-process TF-IDF retrieval projection is rebuilt after a restart.

## Inference and KV extension point

The optional sharing gateway has a separate boundary: an owner-configured Ollama HTTP origin and
model name. Server address, DNS name, SSH listener, and local port are private configuration values.
Moving between cloud providers changes these values and the external network/DNS setup, not the API
contract. Replacing Ollama requires validating the forwarded parameter subset, token usage and SSE
behavior; changing `upstream` alone is not evidence of compatibility. Public Agent routes would
additionally need authenticated tenant/session authorization before being added to the allowlist.

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
