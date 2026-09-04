# Operations guide

## Paths

| Path | Contents | Git tracked |
|---|---|---|
| `.runtime/hypha` | Pinned `AdamsukS/Hypha` checkout | No |
| `.runtime/plasmod` | Pinned `AdamsukS/Plasmod` checkout | No |
| `runtime/bin` | Locally built Plasmod binary | No |
| `runtime/logs` | Ollama, Plasmod, and ModelHarbor logs | No |
| `runtime/pids` | PIDs owned by lifecycle scripts | No |
| `data/plasmod` | Plasmod disk store and WAL | No |
| `models` | Preserved legacy MLX snapshot | No |

## Prepare

```bash
pnpm install
pnpm run runtime:prepare
```

The preparation command:

1. clones or verifies both pinned fork checkouts;
2. refuses to switch a checkout with tracked or untracked local changes;
3. installs the Hypha workspace through `npm ci`;
4. downloads Plasmod Go modules and builds the Go server;
5. pulls the Ollama Qwen3.5-9B Q4_K_M model and creates the 128K profile.

The scripts prefer Homebrew's keg-only `/opt/homebrew/opt/node@22` toolchain when it exists so the
Hypha native SQLite dependency is not accidentally compiled with incompatible Node 26 headers.

If a fork revision changes, update `config/runtime-sources.json`, rerun tests, and then rerun
preparation. Do not manually reset a dirty checkout.

## Start and inspect

```bash
pnpm start
pnpm run health
```

Startup order is Ollama, Plasmod, and then ModelHarbor. Each step waits for an HTTP readiness
condition rather than sleeping for a fixed duration. After Plasmod starts, the lifecycle script
uses its official admin replay endpoint to rebuild the disposable retrieval projection from the
durable WAL. Set `PLASMOD_REPLAY_ON_START=0` only for targeted recovery experiments.

Inspect logs:

```bash
tail -f runtime/logs/ollama.log
tail -f runtime/logs/plasmod.log
tail -f runtime/logs/model-harbor.log
```

Inspect the active model and queue-facing service:

```bash
curl -fsS http://127.0.0.1:11434/api/tags
curl -fsS http://127.0.0.1:8080/healthz
curl -fsS http://127.0.0.1:8787/readyz
curl -fsS http://127.0.0.1:8787/v1/models
```

## Smoke test

```bash
pnpm run smoke
```

The smoke path creates a unique local Session, requests one real completion, persists it, then
queries the same Session's Plasmod memory. A failed command is evidence that the live path is not
ready; inspect all three logs before retrying.

## Stop

```bash
pnpm stop
```

Each PID is checked against its expected command before a signal is sent. A mismatched PID is left
running and reported. Stop does not remove data or model files.

## Configuration overrides

Copy local overrides to `.env`; it is ignored by Git. `config/default.env` remains the documented
baseline.

Common settings:

```dotenv
MODEL_HARBOR_PORT=8787
MODEL_HARBOR_MAX_USERS=5
MODEL_HARBOR_QUEUE_SIZE=5
MODEL_HARBOR_CONTEXT_TOKENS=131072
MODEL_HARBOR_CONTEXT_CHARACTERS=360000
OLLAMA_MODEL=qwen3.5:9b-128k
OLLAMA_THINKING=false
PLASMOD_TOP_K=5
PLASMOD_REPLAY_ON_START=1
```

The application rejects `MODEL_HARBOR_MAX_USERS` above five. Restart ModelHarbor after changing
application settings; restart Ollama after changing its process-level KV or parallelism settings.
Thinking is off by default to keep a five-user queue responsive; opt in per deployment through the
environment when an experiment needs explicit reasoning tokens.

## Common failures

### Docker daemon is not running

Docker is not required by the default Plasmod path. ModelHarbor builds and starts the documented Go
disk/TF-IDF server directly. Docker Compose remains available inside `.runtime/plasmod` for later
MinIO or split-port experiments.

### Ollama model is unavailable

Run `pnpm run runtime:prepare`, then inspect `runtime/logs/ollama.log`. The old MLX model directory
does not satisfy the Ollama model requirement.

### Readiness returns `503`

Read the dependency map returned by `/readyz`, then check the corresponding health endpoint and
log. Chat intentionally fails closed when Plasmod is unavailable.

### A source checkout is dirty

Commit or stash the work in that fork checkout. Preparation will not erase it, reset it, or switch
commits while dirty.

### 128K causes memory pressure

First reduce the per-request context in a local `.env`, keep one parallel generation, and inspect
macOS memory pressure. Do not increase concurrent model slots. The next optimization step is direct
llama.cpp KV measurement, not silently dropping memory isolation or Plasmod durability.
