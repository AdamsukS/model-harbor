# Agent tools

Tools are optional. Enable them under **Tools & Memory controls** in the Bench, or through the Chat
API. Execution uses Hypha's published `@codesoul-co/hypha-tools` 1.0.1 registry and governed runner,
not a mock MCP gateway. The loop implements [Ollama's tool calling protocol](https://docs.ollama.com/capabilities/tool-calling).

| Tool | Provider | Availability |
|---|---|---|
| `current_time` | Node Intl / system clock | Public and local modes |
| `web_search` | Exa remote MCP (default); optional Ollama API | Public mode, explicit approved query; Exa free plan needs no key |
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

The default is `MODEL_HARBOR_WEB_SEARCH_PROVIDER=exa`. No API key, account signup, Python process,
or paid subscription is needed for the [Exa MCP free plan](https://exa.ai/docs/reference/exa-mcp).
Free does not mean unlimited: the provider can rate-limit requests, and there is no production SLA
or guaranteed five-user capacity. Rate limits/errors surface in the tool trace; there is no paid
fallback, automatic signup, or automatic provider switching.

`config/mcp.json` is a **Hypha MCPServerProfile**, not a Codex/global MCP configuration. It connects
to `https://mcp.exa.ai/mcp?tools=web_search_exa` over Streamable HTTP using Hypha's published
`MCPConnectionManager`, `SDKMCPConnectionSessionFactory`, and `MCPToolAdapter`. Only the reviewed
search capability is mapped to the Agent's `web_search` tool; prompts, resources, page fetching,
and other remotely advertised tools are not imported. The official MCP SDK handles negotiation
and JSON/SSE responses; no custom protocol parser is used.

In the Bench, expand **Tools & Memory controls**, select **Public: time / web**, enter the approved
search query, then ask the Agent to search. `/v1/tools` reports `provider: exa_mcp` and
`status: configured_free_no_key`; this describes configuration, not live provider health.
Run `pnpm run tools:check-web` for an end-to-end model/MCP smoke check. The probe disables memory
recall and writes, sends a public documentation query, and saves its complete trace under ignored
`runtime/evals/web-search-*/trace.json`.

Inference remains local. The approved query, fixed result count and MCP client/protocol metadata
go to Exa; conversation history, user identity, recalled memories and credentials are not sent by
the adapter. Each search uses a bounded short-lived connection with TLS/host restrictions, no
redirects, and capped result size. Returned web text is untrusted evidence.

To retain the earlier provider, set `MODEL_HARBOR_WEB_SEARCH_PROVIDER=ollama` and
`OLLAMA_WEB_SEARCH_API_KEY` in ignored `.env`, then restart. See the
[official Ollama setup](https://docs.ollama.com/capabilities/web-search). In that mode only the
approved query is sent to Ollama's search API; a missing key leaves search unconfigured.
Set the provider to `off` to disable search entirely.

Supply `search_query` explicitly. The runner rejects any model-generated query that differs from
it. Local/private mode never exposes the web-search tool. This prevents recalled mail/calendar
content from being silently appended to an external query by the model.

### Free alternatives considered (2026-09-04)

- Exa hosted MCP: keyless free plan, selected for the current deployment; provider rate limits apply.
- [Tavily MCP](https://docs.tavily.com/documentation/mcp): requires an account/API key;
  its [free plan](https://www.tavily.com/pricing) lists 1,000 credits per month with no credit card.
  Credits are not necessarily searches. Not installed or activated.
- Third-party DuckDuckGo MCP scrapers: no search API subscription in some implementations, but
  scraping can be throttled or challenged. Not installed; no CAPTCHA bypass or reliability claim.

## Bounds and traces

Each request uses at most four model steps and six tool calls. Native reads time out, JSON inputs
are validated before the handler, and tool observations are bounded. Context-budget or step-limit
exhaustion fails the request rather than fabricating an answer. The Bench shows Hypha tool events
under each answer; these are persisted with the benchmark Artifact when writes are enabled.
