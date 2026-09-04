# API reference

ModelHarbor listens on `http://127.0.0.1:8787` by default. Phase one is local-only and does not
provide TLS or authentication. Chat and memory operations require explicit user and Session scope.

Errors use:

```json
{"error":{"code":"ERROR_CODE","message":"Human-readable explanation."}}
```

## `GET /healthz`

Process liveness. It does not contact dependencies.

```json
{"status":"ok"}
```

## `GET /readyz`

Checks the compiled Hypha contract, Ollama availability, configured model, and Plasmod health.
Returns HTTP `200` when ready and `503` otherwise.

```json
{
  "status": "ready",
  "dependencies": {
    "ollama": "ready",
    "plasmod": "ready",
    "hyphaContract": "ready"
  }
}
```

## `GET /v1/models`

Returns the active provider-neutral model record:

```json
{
  "object": "list",
  "data": [
    {
      "id": "qwen3.5:9b-128k",
      "object": "model",
      "owned_by": "local",
      "context_window": 131072,
      "alias": "local-default"
    }
  ]
}
```

## `POST /v1/chat/completions`

Required headers:

- `Content-Type: application/json`
- `X-User-ID: <local user identifier>`
- `X-Session-ID: <conversation identifier>`

Request:

```json
{
  "model": "local-default",
  "stream": false,
  "messages": [
    {"role": "system", "content": "Answer concisely."},
    {"role": "user", "content": "What preferences do you remember?"}
  ]
}
```

Supported roles are `system`, `user`, and `assistant`. `stream: true` returns HTTP `400` with
`STREAMING_UNSUPPORTED` in phase one.

Before generation, ModelHarbor queries Plasmod using the supplied user and Session scope. After a
successful Ollama response, it persists the completed interaction as a strict Plasmod Dynamic Event
v0.4. If that write fails, the request returns `503`; the service does not report a durable success.

Response:

```json
{
  "id": "chatcmpl-...",
  "object": "chat.completion",
  "created": 1788494400,
  "model": "qwen3.5:9b-128k",
  "choices": [
    {
      "index": 0,
      "message": {"role": "assistant", "content": "..."},
      "finish_reason": "stop"
    }
  ],
  "usage": {
    "prompt_tokens": 100,
    "completion_tokens": 20,
    "total_tokens": 120
  },
  "benchmark": {
    "queueWaitMs": 0.2,
    "memoryQueryMs": 4.1,
    "inferenceMs": 1280.5,
    "memoryWriteMs": 3.7,
    "totalMs": 1288.5,
    "memoryHits": 2,
    "promptCharacters": 942,
    "contextBudgetCharacters": 360000,
    "contextTruncated": false,
    "persisted": true
  }
}
```

`persisted` describes the companion benchmark Artifact. The completed interaction Memory remains
the success boundary for the Chat request; a metrics-only write failure does not discard a valid
model response.

## `POST /v1/memory/query`

Uses the same scope headers as Chat.

```json
{"query":"preferred response style"}
```

The response contains extracted text plus Plasmod's structured evidence envelope:

```json
{"memories":["The user prefers concise answers."],"evidence":{}}
```

## Agent Bench APIs

The bundled UI uses these same-origin endpoints. They are stable backend boundaries for future
gateways; clients should not call Plasmod directly.

### `GET /v1/bench/sessions`

Requires `X-User-ID`. Returns sessions derived from canonical Plasmod Memory records in that user
workspace.

### `GET /v1/bench/history`

Requires both scope headers. Returns ordered conversation turns and any linked per-turn benchmark
Artifact.

### `GET /v1/bench/memory`

Requires both scope headers. Returns canonical Plasmod Memory records for the selected Session.

### `GET /v1/bench/runtime`

Returns the configured model and context window, KV-cache manager/type, live admission snapshot,
dependency health, and aggregate Plasmod metrics. It does not expose internal dependency URLs.

## Admission and status codes

| Status | Meaning |
|---:|---|
| `200` | Completed and, for Chat, persisted to Plasmod |
| `400` | Invalid JSON, scope, messages, query, or unsupported streaming |
| `404` | Unknown route |
| `413` | Request body exceeds 2 MiB |
| `429` | Five-request queue or five-user admission boundary reached |
| `503` | Ollama, model, or Plasmod unavailable |

One inference runs at a time. Requests are admitted FIFO, with five total admitted requests and no
more than five distinct admitted users.
