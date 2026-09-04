# API contract

The supported baseline is the OpenAI-compatible API served directly by MLX-LM
at `http://127.0.0.1:8000/v1`. It is bound to loopback and has no authentication,
TLS, user database, rate limiter, or application-level queue endpoint. It is
appropriate for local clients on the same Mac.

## Model name rule

Use `"model": "default_model"` for every chat request. This alias keeps the
request on the model loaded at server startup. Do not send the Hugging Face model
ID to the direct MLX-LM backend: MLX-LM interprets a different value as a dynamic
model-load request, while this service intentionally runs with network model
resolution disabled.

## `GET /v1/models`

Lists the loaded model record.

```bash
curl http://127.0.0.1:8000/v1/models
```

The response has an OpenAI-style `data` array. Consumers should only depend on
the array being non-empty; its backend-generated `id` may be a local path.

## `POST /v1/chat/completions`

### Regular chat

```bash
curl http://127.0.0.1:8000/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "default_model",
    "messages": [
      {"role": "system", "content": "你是一个简洁的本地助手。"},
      {"role": "user", "content": "只回复 OK"}
    ],
    "max_tokens": 32,
    "temperature": 0,
    "stream": false,
    "chat_template_kwargs": {"enable_thinking": false}
  }'
```

Read assistant text from `choices[0].message.content`. Multi-turn requests use
the standard `system`, `user`, `assistant`, and `tool` message roles.

### Streaming SSE

Set `"stream": true` and optionally request usage data:

```json
{
  "model": "default_model",
  "messages": [{"role": "user", "content": "解释 KV cache"}],
  "stream": true,
  "stream_options": {"include_usage": true},
  "chat_template_kwargs": {"enable_thinking": false}
}
```

Each Server-Sent Events line begins with `data:` and contains a JSON chunk.
Text deltas appear under `choices[0].delta.content`; the stream ends with
`data: [DONE]`. When usage is requested, the final JSON event includes prompt
and completion token counts. Cached-token counts, when available, are under
`usage.prompt_tokens_details.cached_tokens`.

### Thinking mode

Qwen thinking is controlled per request:

```json
"chat_template_kwargs": {"enable_thinking": true}
```

With thinking enabled, intermediate reasoning can be returned in the
`"reasoning"` field (or streaming `delta.reasoning`) and consumes the output-token
budget. For deterministic tool calls, health checks, and short replies, disable
thinking. Do not assume `content` is populated if a very small `max_tokens`
budget is exhausted by reasoning.

### Function tools

Send OpenAI-style `"tools"` definitions:

```json
{
  "model": "default_model",
  "messages": [
    {"role": "user", "content": "调用工具查询北京天气，不要自行回答。"}
  ],
  "tools": [
    {
      "type": "function",
      "function": {
        "name": "get_weather",
        "description": "查询指定城市天气",
        "parameters": {
          "type": "object",
          "properties": {"city": {"type": "string"}},
          "required": ["city"]
        }
      }
    }
  ],
  "max_tokens": 128,
  "chat_template_kwargs": {"enable_thinking": false}
}
```

Structured calls are returned in the `"tool_calls"` member at
`choices[0].message.tool_calls`. The caller is
responsible for validating arguments, executing the tool, appending the tool
result message, and submitting the next completion. This service never executes
tools itself.

## Concurrency and errors

The service has passed a smoke test with 5 simultaneous requests. Prompt and
decode concurrency are each `1`, so requests wait for scarce inference capacity.
There is currently no hard five-client admission controller and therefore no
guaranteed `429 Too Many Requests` response. Transport errors, malformed JSON,
invalid parameters, and output-budget issues are backend-native HTTP errors;
clients should retain the HTTP status and response body, use timeouts, and retry
only idempotent requests with backoff.

For strict user isolation, request cancellation, priorities, bounded queue depth,
or predictable 429 behavior, put a small Agent/API gateway in front of this
endpoint in a later phase.

## Compatibility boundary

The verified surface is chat completions, streaming, multi-turn messages,
thinking fields, usage data, and structured function calls. Embeddings, audio,
image input, fine-tuning, Assistants/Responses APIs, authentication, and durable
conversation state are not implemented here.
