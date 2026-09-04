# Hypha + Plasmod Local Runtime Design

## Purpose

Replace the active Python/MLX implementation on the `next` branch with a local-first,
non-Python service that uses Hypha for the Agent contract, Plasmod for durable memory, and
Ollama for inference. The existing `main` branch and downloaded MLX model remain untouched as
the previous baseline.

## Phase-one outcome

The first release on `next` provides one runnable chat service with:

- a TypeScript/Node.js application runtime;
- a Hypha DomainPack compiled during startup;
- an Ollama-backed Qwen3.5-9B inference profile with a 128K requested context window;
- Plasmod retrieval before generation and event ingestion after generation;
- one active inference at a time and a bounded FIFO admission queue;
- at most five distinct users with admitted or running requests;
- health, readiness, model, memory-query, and OpenAI-compatible chat endpoints;
- scripts that prepare and run the user's Hypha and Plasmod forks outside the tracked tree;
- English primary documentation and a separate Simplified Chinese README.

This phase does not implement the full Hypha production Harness, tools, MCP, long-horizon
workflows, automatic memory summarization, or direct llama.cpp KV experiments. Those features can
be added behind the interfaces established here.

## Repository boundary

ModelHarbor owns product code and configuration only. It does not vendor Hypha or Plasmod.

`config/runtime-sources.json` pins:

- `https://github.com/AdamsukS/Hypha.git` at commit
  `ac80a8f7d1fbc8136b3bd85d94c48cf6e18dedf5`;
- `https://github.com/AdamsukS/Plasmod.git` at commit
  `26ae0b58cae7798d106d65ca1a4bd8120828a011`.

The preparation script clones them to `.runtime/hypha` and `.runtime/plasmod`, checks out the
pinned revisions, and leaves those directories ignored by ModelHarbor Git. Hypha framework
changes belong in the Hypha fork; Plasmod database changes belong in the Plasmod fork.

The application consumes Hypha's public `@codesoul-co/hypha-*` npm packages, which is its
documented product integration boundary. The local Hypha checkout remains available for the full
server and framework experiments later.

## Runtime topology

```text
Client
  -> ModelHarbor HTTP API :8787
       -> bounded user/request admission queue (1 running, 5 admitted users)
       -> compile/load Hypha DomainPack
       -> Plasmod query :8080
       -> context assembler
       -> Ollama chat :11434
       -> Plasmod event ingest :8080

.runtime/hypha
  -> pinned framework checkout for later full Harness/server use

.runtime/plasmod
  -> Go server using disk storage, TF-IDF retrieval, and unified HTTP
```

Plasmod uses its documented minimal Go startup path by default:

```sh
PLASMOD_STORAGE=disk \
PLASMOD_DATA_DIR=<project>/data/plasmod \
PLASMOD_EMBEDDER=tfidf \
PLASMOD_GRPC_ENABLED=0 \
go run ./src/cmd/server
```

This avoids the idle cost of Docker Desktop, MinIO, and the native retrieval build on a 16 GiB
Mac while preserving canonical disk storage, WAL, lexical retrieval, and evidence traces. Docker
Compose remains an optional Plasmod operation mode, not the default.

## Inference

The initial inference engine is Ollama because Hypha already models it as a local backend and it
provides model lifecycle, Metal acceleration, queueing, and an HTTP API without a Python runtime.

The default model profile is built from `qwen3.5:9b-q4_K_M` with:

- requested context: `131072` tokens;
- inference concurrency: `1`;
- queue capacity: `5`;
- maximum loaded models: `1`;
- Flash Attention enabled;
- quantized KV cache enabled to reduce memory pressure.

The service reports the effective model/profile in `/v1/models`. A requested 128K window does not
guarantee that every 128K request fits in 16 GiB. Model weights, KV cache, runtime buffers, and the
other services share memory. The API therefore applies a deterministic context budget before
calling Ollama and returns an explicit capacity error instead of silently overflowing.

The inference port is provider-neutral. A later `LlamaCppClient` can implement the same interface
for direct slot and KV-cache experiments.

## Memory

Plasmod is the durable memory authority. For each chat request, ModelHarbor:

1. queries `/v1/query` within the current tenant, user workspace, Agent, and Session scope;
2. extracts bounded text from returned Memory objects;
3. inserts that evidence into a clearly delimited memory block in the prompt;
4. calls Ollama;
5. writes the completed user/assistant interaction through `/v1/ingest/events` with a stable event
   identifier and strict visibility.

If Plasmod is unavailable, readiness fails and chat requests return `503`. Phase one fails closed
because silently generating without the configured memory authority would hide a broken system.
The direct `/v1/memory/query` endpoint exposes scoped retrieval for diagnostics.

## Agent contract

`agent/domain-pack.yaml` declares the local assistant task, output contract, bounded workflow,
memory provider reference, reasoning profile, and local deployment profile. At startup the
application loads and compiles it using `@codesoul-co/hypha-domain`. An invalid DomainPack prevents
readiness.

Phase one uses the compiled Agent contract to define identity, model alias, memory scope, and
budgets. It does not claim that the complete Hypha production Harness is executing. A future phase
can move the same DomainPack and Plasmod adapter into the full Hypha server checkout.

## Admission and isolation

The server binds to `127.0.0.1` by default. Every chat and memory query requires non-empty
`X-User-ID` and `X-Session-ID` headers.

- At most five distinct users may have admitted or running operations.
- Only one Ollama generation runs at once.
- Requests are processed FIFO.
- A sixth distinct user or a full queue receives `429` with a machine-readable error.
- Plasmod workspace and session filters prevent cross-user/session recall.
- The user slot is released when that user's last admitted operation finishes.

Authentication and persistent user registration are outside phase one; the service is local-only.

## HTTP surface

- `GET /healthz`: process liveness.
- `GET /readyz`: DomainPack, Ollama, and Plasmod readiness.
- `GET /v1/models`: configured inference profile.
- `POST /v1/chat/completions`: non-streaming OpenAI-compatible chat request plus required scope
  headers.
- `POST /v1/memory/query`: scoped Plasmod diagnostic query.

Errors use `{ "error": { "code": string, "message": string } }` and suitable HTTP status codes.
Streaming is deferred until the non-streaming lifecycle and memory write are reliable.

## Configuration and secrets

`config/default.env` documents safe local defaults. `.env` is ignored and may override them.
Secrets are not committed. The runtime validates numeric limits, URLs, model names, and the five-user
upper bound before listening.

## Lifecycle

- `scripts/prepare.sh` validates prerequisites, clones pinned forks, installs Node dependencies,
  pulls/builds the Ollama model profile, and downloads Go modules.
- `scripts/start.sh` starts Ollama, Plasmod, then ModelHarbor and records PID files under `runtime/`.
- `scripts/health.sh` checks all three services.
- `scripts/smoke.sh` submits two messages in one Session and confirms that memory is queryable.
- `scripts/stop.sh` gracefully stops processes started by ModelHarbor. It does not delete models,
  Plasmod data, cloned forks, or the preserved MLX environment.

## Verification

Unit tests cover configuration, queue admission, context budgeting, Ollama protocol mapping,
Plasmod scope/payload mapping, and HTTP errors. Contract tests compile the DomainPack with the
published Hypha release. Integration smoke tests use real Ollama and Plasmod services and record the
observed result without fabricating readiness.

