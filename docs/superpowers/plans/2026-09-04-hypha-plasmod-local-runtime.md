# Hypha + Plasmod Local Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a runnable non-Python local Agent service using Hypha contracts, Plasmod memory, and Ollama inference.

**Architecture:** ModelHarbor is a TypeScript product application. It consumes published Hypha packages, talks to Plasmod and Ollama over HTTP, and prepares pinned fork checkouts under the ignored `.runtime/` directory.

**Tech Stack:** Node.js 22+, TypeScript, Vitest, Hypha 1.0.1 npm packages, Go 1.25+, Plasmod HTTP API, Ollama.

**Spec:** `docs/superpowers/specs/2026-09-04-hypha-plasmod-local-runtime-design.md`

## Global Constraints

- The active `next` branch contains no Python application, test, setup, or runtime path.
- Preserve `models/`, `.venv/`, `.venv-sglang/`, and the `main` branch.
- Bind public application and dependency endpoints to localhost by default.
- Admit at most five users and run one inference request at a time.
- Default requested context is 131072 tokens.
- README is English; `README.zh-CN.md` is the Chinese translation.
- Hypha and Plasmod source trees remain ignored under `.runtime/`.
- Do not add a contribution guide.

---

### Task 1: Replace the Python project shell with a TypeScript project

**Files:**
- Delete: `llm_service/`, `tests/*.py`, `pyproject.toml`, `requirements-dev.txt`, `requirements-mlx.txt`, `uv.lock`
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`
- Modify: `.gitignore`

**Interfaces:**
- Produces scripts `build`, `test`, `typecheck`, `start`, and `dev`.
- Produces an ignored `.runtime/`, `runtime/`, `data/`, `.env`, and `node_modules/` layout.

- [x] **Step 1: Update ignore rules and create the TypeScript manifests.**

  Pin `@codesoul-co/hypha-core`, `@codesoul-co/hypha-domain`, and
  `@codesoul-co/hypha-memory` to `1.0.1`. Use `tsx`, TypeScript, Vitest, and Node types as
  development dependencies.

- [x] **Step 2: Install dependencies with pnpm and generate `pnpm-lock.yaml`.**

  Run: `pnpm install`

- [x] **Step 3: Remove tracked Python application files and old Python-only scripts/config.**

  Keep model bytes and ignored virtual environments intact.

- [x] **Step 4: Run the empty TypeScript test/build baseline.**

  Run: `pnpm test && pnpm run typecheck`

### Task 2: Validate configuration and pinned runtime sources

**Files:**
- Create: `config/runtime-sources.json`
- Create: `config/default.env`
- Create: `src/config.ts`
- Test: `tests/config.test.ts`

**Interfaces:**
- Produces `loadConfig(env?: NodeJS.ProcessEnv): RuntimeConfig`.
- Produces `loadRuntimeSources(path): RuntimeSources`.

- [x] **Step 1: Write failing tests for defaults and invalid limits.**

  Assert the literal defaults `127.0.0.1:8787`, Ollama `11434`, Plasmod `8080`,
  `qwen3.5:9b-128k`, `131072`, one worker, queue size five, and maximum users five. Assert
  zero, negative, malformed URL, and `MAX_USERS > 5` inputs throw.

- [x] **Step 2: Run the test and observe missing-module failure.**

  Run: `pnpm vitest run tests/config.test.ts`

- [x] **Step 3: Implement strict configuration parsing and immutable source-lock parsing.**

  Define explicit `RuntimeConfig` and `RuntimeSources` interfaces. Do not read configuration at
  import time.

- [x] **Step 4: Run the focused test and full typecheck.**

  Run: `pnpm vitest run tests/config.test.ts && pnpm run typecheck`

### Task 3: Implement the bounded FIFO admission queue

**Files:**
- Create: `src/admission-queue.ts`
- Test: `tests/admission-queue.test.ts`

**Interfaces:**
- Produces `AdmissionQueue.run<T>(userId: string, operation: () => Promise<T>): Promise<T>`.
- Exposes `snapshot()` with active request, queued requests, and admitted users.

- [x] **Step 1: Write failing behavior tests.**

  Use deferred real promises to prove FIFO order, single concurrency, reuse of one user's slot,
  release after completion, rejection of a sixth distinct user, and rejection when five requests
  are already admitted.

- [x] **Step 2: Run the tests and confirm the class is missing.**

  Run: `pnpm vitest run tests/admission-queue.test.ts`

- [x] **Step 3: Implement the minimal queue.**

  Reject with typed `AdmissionError` codes `USER_LIMIT` and `QUEUE_FULL`. Always release counters
  in `finally`.

- [x] **Step 4: Run the focused tests.**

  Run: `pnpm vitest run tests/admission-queue.test.ts`

### Task 4: Implement Plasmod memory transport

**Files:**
- Create: `src/plasmod-client.ts`
- Test: `tests/plasmod-client.test.ts`

**Interfaces:**
- Produces `health(signal?)`, `query(input, signal?)`, and `ingestInteraction(input, signal?)`.
- `query` always sends tenant, workspace/user, Agent, and Session scope.

- [x] **Step 1: Write failing tests against a local test HTTP server.**

  Assert `POST /v1/query` sends `object_types: ["memory"]`, `response_mode:
  "structured_evidence"`, and the complete scope. Assert ingest sends Dynamic Event v0.4 with
  strict workspace visibility, `materialization.targets` containing `memory` and
  `object_version`, and both user and assistant text.

- [x] **Step 2: Run the tests and observe missing-client failure.**

  Run: `pnpm vitest run tests/plasmod-client.test.ts`

- [x] **Step 3: Implement JSON transport, timeouts, response validation, and text extraction.**

  Use built-in `fetch`; surface non-2xx status and malformed JSON as `DependencyError` without
  retrying ambiguous writes.

- [x] **Step 4: Run the focused tests.**

  Run: `pnpm vitest run tests/plasmod-client.test.ts`

### Task 5: Implement Ollama inference and context budgeting

**Files:**
- Create: `src/context.ts`
- Create: `src/ollama-client.ts`
- Test: `tests/context.test.ts`
- Test: `tests/ollama-client.test.ts`

**Interfaces:**
- Produces `assembleMessages(messages, memories, budget): ChatMessage[]`.
- Produces `OllamaClient.chat(request, signal?): Promise<OllamaChatResult>`.

- [x] **Step 1: Write failing context tests.**

  Prove the system block labels recalled memory as untrusted context, retains newest chat turns,
  drops oldest turns first, truncates overlong memory, and never exceeds the configured character
  approximation.

- [x] **Step 2: Write failing Ollama protocol tests against a local HTTP server.**

  Assert model, messages, `stream: false`, and `options.num_ctx: 131072` are sent to `/api/chat`.
  Assert empty assistant content and non-2xx responses fail explicitly.

- [x] **Step 3: Run both tests and observe missing-module failures.**

  Run: `pnpm vitest run tests/context.test.ts tests/ollama-client.test.ts`

- [x] **Step 4: Implement the minimal assembler and client.**

  Keep backend details behind the `InferenceClient` interface so llama.cpp can be added later.

- [x] **Step 5: Run focused tests and typecheck.**

  Run: `pnpm vitest run tests/context.test.ts tests/ollama-client.test.ts && pnpm run typecheck`

### Task 6: Compile the Hypha Agent contract

**Files:**
- Create: `agent/domain-pack.yaml`
- Create: `src/agent-contract.ts`
- Test: `tests/agent-contract.test.ts`

**Interfaces:**
- Produces `loadAgentContract(projectRoot): Promise<AgentContract>` with Agent, workflow, memory,
  and reasoning identifiers.

- [x] **Step 1: Write a failing contract test.**

  Assert a real Hypha compiler loads the file and returns `agent.model-harbor.local`,
  `workflow.local-chat`, `memory.plasmod`, and `reasoning.local-chat`.

- [x] **Step 2: Run the test and confirm the DomainPack is absent.**

  Run: `pnpm vitest run tests/agent-contract.test.ts`

- [x] **Step 3: Add the bounded local-chat DomainPack and compile adapter.**

  Declare a two-terminal-state workflow, no executable tools, a hybrid provider reference
  `memory.provider.plasmod`, and a 128K context profile with provenance required.

- [x] **Step 4: Run the contract test and typecheck.**

  Run: `pnpm vitest run tests/agent-contract.test.ts && pnpm run typecheck`

### Task 7: Expose the ModelHarbor HTTP service

**Files:**
- Create: `src/service.ts`
- Create: `src/main.ts`
- Test: `tests/service.test.ts`

**Interfaces:**
- Produces `createService(dependencies): ModelHarborService` with `listen()` and `close()`.
- Routes: `/healthz`, `/readyz`, `/v1/models`, `/v1/chat/completions`,
  `/v1/memory/query`.

- [x] **Step 1: Write failing HTTP tests with real local dependency servers.**

  Assert scope headers are required, readiness checks both dependencies, a chat retrieves memory
  before Ollama, a successful response is ingested afterward, queue rejection maps to `429`, and
  dependency failure maps to `503`.

- [x] **Step 2: Run the test and observe missing-service failure.**

  Run: `pnpm vitest run tests/service.test.ts`

- [x] **Step 3: Implement routing, validation, orchestration, and shutdown.**

  Support non-streaming OpenAI-compatible requests only. Return a standard completion envelope
  with `id`, `object`, `created`, `model`, `choices`, and conservative token usage estimates.

- [x] **Step 4: Run focused and full tests.**

  Run: `pnpm vitest run tests/service.test.ts && pnpm test && pnpm run typecheck`

### Task 8: Add reproducible lifecycle scripts

**Files:**
- Create: `scripts/common.sh`
- Create: `scripts/prepare.sh`
- Create: `scripts/start-ollama.sh`
- Create: `scripts/start-plasmod.sh`
- Create: `scripts/start.sh`
- Create: `scripts/health.sh`
- Create: `scripts/smoke.sh`
- Create: `scripts/stop.sh`
- Test: `tests/scripts.test.ts`

**Interfaces:**
- `prepare.sh` is idempotent and never overwrites a dirty fork checkout.
- Lifecycle PID files live below `runtime/pids/`.

- [x] **Step 1: Write failing script behavior tests in temporary directories.**

  Execute the scripts with command-path overrides to prove pinned clone/checkout arguments,
  idempotent directory handling, refusal to replace a dirty checkout, PID ownership checks, and
  non-destructive stop behavior.

- [x] **Step 2: Run script tests and confirm the entrypoints are absent.**

  Run: `pnpm vitest run tests/scripts.test.ts`

- [x] **Step 3: Implement lifecycle scripts.**

  Use explicit project paths, bounded readiness polling, log files under `runtime/logs/`, and
  graceful signals. Never delete `models/`, `data/`, `.runtime/`, or virtual environments.

- [x] **Step 4: Run script tests and ShellCheck when available.**

  Run: `pnpm vitest run tests/scripts.test.ts && (command -v shellcheck >/dev/null && shellcheck scripts/*.sh || true)`

### Task 9: Rewrite operations and API documentation

**Files:**
- Rewrite: `README.md`
- Rewrite: `README.zh-CN.md`
- Rewrite: `docs/API.md`
- Rewrite: `docs/MODULES.md`
- Create: `docs/OPERATIONS.md`

**Interfaces:**
- Documents the exact setup, start, stop, health, smoke, request, and recovery commands.
- Describes Hypha, Plasmod, Ollama, queue, context, and repository boundaries without a
  contribution guide.

- [x] **Step 1: Rewrite English primary documentation and Chinese README.**

  State that `main` is the MLX/Python baseline, `next` is the default non-Python architecture,
  and the existing MLX weights are preserved but not consumed by Ollama.

- [x] **Step 2: Cross-check every documented command against package scripts and shell entrypoints.**

  Run each read-only/help command and correct any mismatch.

### Task 10: Prepare dependencies and execute the live smoke path

**Files:**
- Generated, ignored: `.runtime/hypha`, `.runtime/plasmod`, `runtime/`, `data/plasmod`
- Generated: Ollama model storage outside the repository

**Interfaces:**
- Produces live health evidence for Ollama, Plasmod, and ModelHarbor.

- [x] **Step 1: Run the preparation command.**

  Run: `pnpm run runtime:prepare`

- [x] **Step 2: Start all three services.**

  Run: `pnpm start`

- [x] **Step 3: Run health and smoke checks.**

  Run: `pnpm run health && pnpm run smoke`

- [x] **Step 4: Run final static verification.**

  Run: `pnpm test && pnpm run typecheck && pnpm run build && git diff --check`

- [x] **Step 5: Review tracked files for Python paths and secrets.**

  Run: `git ls-files | rg '\.(py|pyc)$|requirements|pyproject|uv\.lock'` and
  `git grep -nE '(ghp_|gho_|sk-[A-Za-z0-9])' -- . ':!pnpm-lock.yaml'`.
