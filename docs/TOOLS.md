# Agent tools

Tools are optional. Enable them under **Tools & Memory controls** in the Bench, or through the Chat
API. Execution uses Hypha's published `@codesoul-co/hypha-tools` 1.0.1 registry and governed runner,
not a mock MCP gateway. The loop implements [Ollama's tool calling protocol](https://docs.ollama.com/capabilities/tool-calling).

| Tool | Provider | Availability |
|---|---|---|
| `current_time` | Node Intl / system clock | Public and local modes |
| `web_search` | Ollama hosted web-search API | Public mode, API key and explicit approved query required |
| `calendar_list` | Apple Calendar via macOS automation | Local mode, owner token and OS consent required |
| `mail_list` | Apple Mail inbox headers | Local mode, owner token and OS consent required |

No tool sends mail, creates/deletes events, executes arbitrary shell code, or changes message read
status. Mail currently returns only IDs, subject, sender, received time and read status, not bodies
or attachments. Calendar scripting does not reliably expand recurring occurrences; do not use it
as a complete free/busy authority. Results are capped at 50 events or 20 mail headers.

## Apple setup

1. Configure accounts in the native Calendar and Mail apps.
2. Start ModelHarbor. It creates `runtime/local-tools.token` with owner-only file permissions.
3. Use `MODEL_HARBOR_LOCAL_TOOLS_USER` (default `local-user-1`) as the Bench user.
4. Paste the token from that local file into the password field under private tools. The browser
   keeps it in component memory only, not localStorage or URLs. Never commit or send this token.
5. Run `pnpm run tools:check-apple` and handle macOS Automation permission prompts. The check prints
   only status and counts. Permission denial is reported as unavailable, never an empty success.

The overall gateway is still loopback-only and does not authenticate ordinary user headers. This
owner token protects native account reads; it is not a substitute for a gateway identity system.
Do not expose the service to a network without authentication and tenant authorization. Chat
answers and tool traces can contain private information and, unless `memory_write: false`, are
stored locally by Plasmod.

## Public web search

Set `OLLAMA_WEB_SEARCH_API_KEY` in ignored `.env`, then restart ModelHarbor. Obtain the key through
the [official Ollama web-search setup](https://docs.ollama.com/capabilities/web-search).
Inference remains local; only the user-approved search query is sent to `https://ollama.com/api/web_search`.
The key is server-side only. With no key, `/v1/tools` reports `missing_api_key` and the search tool
is not advertised to the model.

Supply `search_query` explicitly. The runner rejects any model-generated query that differs from
it. Local/private mode never exposes the web-search tool. This prevents recalled mail/calendar
content from being silently appended to an external query by the model.

## Bounds and traces

Each request uses at most four model steps and six tool calls. Native reads time out, JSON inputs
are validated before the handler, and tool observations are bounded. Context-budget or step-limit
exhaustion fails the request rather than fabricating an answer. The Bench shows Hypha tool events
under each answer; these are persisted with the benchmark Artifact when writes are enabled.
