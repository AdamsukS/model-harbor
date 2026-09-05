# ModelHarbor

[简体中文](README.zh-CN.md)

**Using an existing service?** Start with the [shared inference API guide](docs/INFERENCE_API.md).
**Deploying your own?** See [deployment and migration](docs/DEPLOYMENT.md), or the
[English sharing guide](docs/SHARING.md). [All documentation](docs/README.md).

ModelHarbor runs local models and Agents on personal hardware and lets small teams share
inference through an OpenAI-compatible API. Collaborators use an HTTPS Base URL and their own
API key with the official OpenAI Python SDK; a lightweight public server forwards traffic over
SSH while inference, authentication, request scheduling, and usage logs run locally.

The current `next` architecture uses:

- [Hypha](https://github.com/AdamsukS/Hypha) for Agent/DomainPack contracts, governed tool execution, and MCP connections;
- [Plasmod](https://github.com/AdamsukS/Plasmod) for scoped, durable Agent memory;
- [Ollama](https://ollama.com/) for native Apple Silicon inference without Python;
- a TypeScript gateway for bounded admission, context assembly, and an OpenAI-compatible API.

The repository name and public API are model-neutral. Qwen3.5-9B is only the first local model
profile.

## Choose your starting point

| Goal | Start here |
|---|---|
| Call an existing model service | [API guide](docs/INFERENCE_API.md) and [Python SDK example](scripts/sharing-client.py) |
| Share your own local inference | [Deployment and migration](docs/DEPLOYMENT.md), with configurable DNS, SSH, and HTTPS settings |
| Run an Agent with tools and durable memory | Follow the local quick start below and the [Agent API reference](docs/API.md) |

Shared inference supports text Chat Completions, ordinary and streaming responses, individual
revocable keys, bounded queues, backend-reported token usage, and inference parameter/timing
metadata. It implements a subset of the OpenAI API; public Agent and Memory endpoints are not
included. Deployment templates are cloud-provider independent. The verified setup uses Ollama,
macOS service management, and an Ubuntu/Debian SSH server; see the deployment guide for platform limits.

## Status

- Default branch: `next` (TypeScript + Go + native inference, no Python runtime)
- Previous baseline: `main` (MLX-LM/Python)
- Local Agent API: `http://127.0.0.1:8787/v1`
- Optional shared inference: loopback gateway on 8788, with a separately configured HTTPS Base URL and personal keys
- Agent Bench: `http://127.0.0.1:8787`
- Inference model: `qwen3.5:9b-q4_K_M`, exposed locally as `qwen3.5:9b-128k`
- Requested context: 128K tokens
- Scheduling: one generation at a time, five total admitted requests, five admitted users maximum
- Memory: Plasmod disk storage; session recall by default, opt-in same-user cross-session recall, or recall off
- Tools: system time, free keyless Exa MCP search, and owner-protected Apple Calendar/Mail reads
- Network scope: Agent and backend stay on loopback; optional authenticated inference sharing uses HTTPS + SSH

The existing `models/Qwen3.5-9B-4bit` MLX snapshot is preserved and ignored by Git. Ollama cannot
consume that directory directly, so the Ollama/GGUF profile is downloaded separately.

## Architecture

Shared model API:

```text
OpenAI SDK / HTTP client
  -> Public server: Caddy HTTPS reverse proxy
  -> Restricted SSH reverse tunnel
  -> Local inference gateway :8788 (API keys / queue / usage metadata)
  -> Ollama :11434
```

Local Agent runtime:

```text
Client
  -> ModelHarbor :8787
       -> FIFO admission (1 active / 5 admitted users)
       -> Hypha DomainPack contract
       -> Plasmod recall :8080
       -> bounded context assembly
       -> Ollama inference :11434
            <-> Hypha governed tools (Exa MCP / native read-only tools)
       -> Plasmod interaction ingest :8080
```

Hypha and Plasmod are not vendored or added as submodules. `scripts/prepare.sh` checks out pinned
revisions of the user's forks under the ignored `.runtime/` directory. ModelHarbor consumes the
published Hypha npm packages through the framework's documented product boundary.

## Requirements

- macOS on Apple Silicon
- Node.js 22 LTS, including npm (the full Hypha checkout currently pins a native SQLite addon that
  is not compatible with Node 26)
- pnpm 11
- Go 1.25 or newer
- Ollama
- about 8 GiB additional disk space for the Ollama model and build caches

Homebrew can install the missing system tools:

```bash
brew install node@22 pnpm go ollama
```

## Call a shared model with the OpenAI SDK

Install the client with `pip install openai`. Set `OPENAI_BASE_URL` to the service URL ending
in `/v1` and `OPENAI_API_KEY` to your personal key in your local environment. Obtain both privately
from the service operator; do not commit them.

```python
import os
from openai import OpenAI

client = OpenAI(
    base_url=os.environ["OPENAI_BASE_URL"],
    api_key=os.environ["OPENAI_API_KEY"],
    timeout=1860,
)
response = client.chat.completions.create(
    model="local-default",
    messages=[{"role": "user", "content": "Reply with OK only."}],
    max_tokens=32,
)
print(response.choices[0].message.content)
print(response.usage)
print((response.model_extra or {}).get("inference"))
```

The [complete example](scripts/sharing-client.py) also demonstrates streaming with
`stream_options={"include_usage": True}`. Inference metadata identifies forwarded request
parameters; unspecified backend defaults are not guessed. Python is only needed for this client,
not the ModelHarbor server.

## Quick start (local Agent)

```bash
pnpm install
pnpm run runtime:prepare
pnpm start
pnpm run health
pnpm run smoke
```

Open `http://127.0.0.1:8787` for the same-origin Agent Bench. It provides Chat, durable Session
history, canonical Plasmod Memory inspection, and runtime/KV/queue measurements. The browser keeps
only UI preferences; Plasmod remains the persistence authority.

Preparation is idempotent. It refuses to change a dirty Hypha or Plasmod checkout. Runtime state,
logs, PID files, Plasmod data, and source checkouts stay outside Git.

Stop only the processes launched by ModelHarbor:

```bash
pnpm stop
```

This preserves models, memory data, fork checkouts, and the older MLX environments.

## Request example (local Agent)

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

## Tools and Memory controls

In the Bench, expand **Tools & Memory controls**:

1. Choose current-session recall, same-user cross-session recall, or recall off. Recall off still
   writes completed turns and still includes visible chat history; it is not a clean experimental baseline.
2. Select **Public: time / web**, enter an **Approved public search query**, then ask the Agent to
   search. The Exa MCP free plan needs no key but is rate-limited; only the exact approved query is sent.
3. For **Private: Apple Calendar / Mail**, use the configured owner and local token, and grant macOS
   Automation permission. These tools only read event details and inbox headers; they do not send
   mail or create events. Calendar recurrence expansion is incomplete.

Tool traces and scoped recall evidence are available with each answer. The server defaults to tools
off. Exa is the configured search provider, not an always-on background search service.
See [tool setup and safety](docs/TOOLS.md), [MCP profile](config/mcp.json), and [API controls](docs/API.md).

### Verification snapshot — 2026-09-04

| Check | Result |
|---|---|
| Automated tests / TypeScript / production build | 59 tests passing; checks and build passing |
| Time and Exa MCP search | Live local-model tool calls verified; search returned source URLs |
| Apple Calendar / Mail | Adapters implemented; native checks timed out or reported unavailable/permission denied; account access not verified |
| Memory required-fact tasks | Recall off: 0/8; same-user cross-session recall on: 8/8 |
| Isolation negative controls after local mitigation | Other-user: 4/4; new-session default: 4/4 |

The Memory experiment used real local inference and Plasmod, but **fictional workflow fixtures**
(four tasks, two repetitions per mode), not private-account tasks or an official benchmark.
The initial new-session isolation result was 0/4; local scope validation raised it to 4/4 without
changing task prompts. Both runs are retained locally. This small sample does not establish
general long-term memory quality or production security. See the [protocol and limitations](docs/MEMORY-EVALUATION.md).

Re-run the checks against a running service:

```bash
pnpm test
pnpm run typecheck
pnpm run build
pnpm run tools:check-web
pnpm run tools:check-apple
pnpm run eval:memory
```

The web probe disables memory writes; the Memory experiment creates isolated test-user records.
Complete experimental traces are saved under ignored `runtime/evals/`, not published to Git.

## Security and current limits

This repository is public. Real deployment URLs, server addresses, API keys, SSH private keys,
and request logs belong in private local state, outside Git. Public templates use placeholders;
deployment settings are configurable and do not require a particular cloud vendor.

An optional [inference-sharing gateway](docs/SHARING.md) now provides a separate, authenticated
OpenAI-compatible text Chat Completions endpoint, including streaming, token usage and inference
metadata. `pnpm sharing init` creates private configuration and individual keys; reusable Caddy,
restricted SSH, and macOS service templates keep deployment details outside Git. This gateway
does not expose the Agent/Memory APIs described below.

The Agent/Memory service remains a local prototype. User/session headers identify
scope but do not authenticate callers; the native-tools token protects account-tool execution only.
Add gateway authentication and tenant authorization before exposing these Agent endpoints to a network.
Search queries leave the device; inference, conversation history, and Memory stay local in the
default deployment. Web results and recalled memories are untrusted evidence, not instructions.

Agent chat is non-streaming; the separate inference-sharing endpoint supports streaming. General dynamic MCP tool import, the complete Hypha production Harness,
automatic memory summarization, write-capable mail/calendar actions, and direct llama.cpp KV
experiments are not implemented. The currently supported tools are bounded to four model steps
and six calls per request.

## 128K and KV cache

The Ollama model profile requests `131072` tokens and starts with Flash Attention, one loaded model,
one parallel generation, and a quantized `q4_0` KV cache. Thinking is disabled by default to keep
interactive queue latency bounded and can be enabled with `OLLAMA_THINKING=true`. ModelHarbor also
limits the assembled prompt to 360,000 characters, retaining the newest turns first and truncating
recalled memory.

On a 16 GiB Mac, 128K is an experimental capacity target rather than a guarantee for every prompt.
Model weights, KV cache, runtime buffers, Plasmod, and Node share unified memory. The next inference
backend can be direct llama.cpp behind the existing `InferenceClient` boundary for finer slot,
prefix, and KV-cache experiments.

## Documentation

- [Documentation index](docs/README.md)
- [Shared inference API](docs/INFERENCE_API.md)
- [Provider-independent deployment and migration](docs/DEPLOYMENT.md)
- [Inference sharing configuration and operations](docs/SHARING.md)
- [Local Agent API reference](docs/API.md)
- [Modules and maintenance](docs/MODULES.md)
- [Operations guide](docs/OPERATIONS.md)
- [Tools and local authorization](docs/TOOLS.md)
- [Memory evaluation protocol](docs/MEMORY-EVALUATION.md)
