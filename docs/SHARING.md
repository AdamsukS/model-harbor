# Share local inference through a small public server

[中文快速说明](#中文快速说明)

For collaborators using an existing service, see the [inference API reference](INFERENCE_API.md).
For operators, see [provider-independent deployment and migration](DEPLOYMENT.md).
This design needs public DNS, HTTPS and SSH, not an account or SDK from any particular cloud provider.

This optional gateway exposes a local Ollama model through **OpenAI-compatible Chat Completions**.
It supports `GET /v1/models`, text `POST /v1/chat/completions`, SSE streaming, and function-call
messages. It does not execute tools or expose the Agent UI, memory, model-management endpoints,
Responses, embeddings, or image inputs. Compatibility is with this API subset, not every OpenAI feature.

```text
Collaborator (HTTPS + personal key)
  -> public Caddy (TLS, forwarding only)
  -> restricted reverse SSH tunnel
  -> local inference gateway (authentication, admission, metrics)
  -> local Ollama
```

No new runtime dependencies are required. The gateway reuses ModelHarbor's admission queue.
Requests, keys, and request logs stay under the owner's control. Caddy terminates HTTPS and thus
can see forwarded content; the server-to-device hop is encrypted with SSH. Do not enable body or
Authorization logging on the public reverse proxy.

## 1. Prepare the local backend and private configuration

Install the repository's Node.js 22 / pnpm requirements, install Ollama, and load a model.
The regular `pnpm run runtime:prepare` then `pnpm start` workflow prepares and starts the configured runtime; alternatively manage Ollama
independently and use any model already listed by its `/v1/models` endpoint.

```bash
pnpm install --frozen-lockfile
pnpm exec tsc -p tsconfig.json
pnpm sharing init
```

`init` is idempotent: it creates **five independent keys** only if there is no existing registry.
It never prints their values. The command prints the paths to individual `collaborator-N.key`
files; give each collaborator only their own file, through your normal private channel.

Private state defaults to:

- macOS: `~/Library/Application Support/ModelHarbor/inference/`
- Linux: `~/.local/share/modelharbor/inference/`
- Override with `INFERENCE_STATE_DIR` (an absolute directory outside your checkout is recommended).

Edit `sharing.local.json` in that directory. Start from [the example](../config/sharing.example.json):

| Setting | Meaning |
| --- | --- |
| `model` | An installed Ollama model name; clients may also use `local-default`. |
| `upstream` | Ollama HTTP origin, default `http://127.0.0.1:11434`. No embedded credentials. |
| `port` | Loopback-only local gateway port, default 8788. |
| `maxTokens` | Per-request output ceiling, default 4096. |
| `domain` | Your full API domain, e.g. `api.example.com`. |
| `sshHost`, `sshPort` | Public server hostname/IP and SSH port. |
| `sshUser` | A dedicated tunnel-only account; do not use root or an existing human account. |
| `remoteBind`, `remotePort` | Server-side tunnel listener; default `127.0.0.1:18788`. |
| `sshInterface` | Usually empty. On macOS, optionally bind SSH to a known interface to bypass a problematic TUN route. |

Use the loopback listener when Caddy runs on the host. For Caddy inside Docker, use that Docker
network's **private bridge gateway address** as `remoteBind`. Do not bind the tunnel to a public
address or `0.0.0.0`. Every request still passes through the local API-key check.

## 2. Render and configure the public server

```bash
pnpm sharing render
```

This creates a dedicated SSH key and renders `generated/server-setup.sh`, `generated/sshd.conf`,
`generated/Caddyfile`, and local `ssh.conf` into the private state directory. **Render performs
no SSH connections, DNS changes, remote writes, or service restarts.** Files contain your deployment
values and must remain private. The generated server script contains the SSH **public** key only.

On your Ubuntu/Debian server:

1. Point the API subdomain's DNS A record at the public server and ensure HTTPS/ACME ports are reachable.
2. Transfer only `generated/server-setup.sh` to the server, review it, and run it as root. It creates
   a dedicated account and validates SSH configuration before reloading. The account has no sessions,
   password authentication, local forwarding, agent forwarding, or unrestricted remote listeners.
3. Install Caddy if it is not already installed. Add the generated site block to its configuration.
   When a site already exists, append the new site rather than replacing the existing Caddyfile.
4. Validate and reload Caddy. Do not restart unrelated containers or change the root user's SSH policy.
5. Verify the server host-key fingerprint through a trusted channel and add the verified host to
   your normal SSH known_hosts using a regular SSH connection. The tunnel uses strict host-key checking.

For a native Caddy installation, validation/reload typically use:

```bash
sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
sudo systemctl reload caddy
```

For Docker, run `caddy validate` and `caddy reload` inside the existing Caddy container. The generated
upstream address must be reachable from that container. Keep the Docker network's gateway stable.

## 3. Start the local gateway and tunnel

On macOS:

```bash
pnpm sharing install-macos
```

This installs or updates two user LaunchAgents: `com.codesoul.modelharbor.inference` and
`com.codesoul.modelharbor.tunnel`. They start after login, restart after failure, and keep the
runtime copies outside Downloads so launchd does not need access to a protected project directory.
Updating these services interrupts their active requests; choose a quiet moment. Run `render`
and server setup first when installing on a new server.

On Linux, or for a foreground diagnostic run, use two terminals:

```bash
# Set the same state directory in both terminals; use your actual private directory.
export INFERENCE_STATE_DIR="$HOME/.local/share/modelharbor/inference"
pnpm start:inference
```

```bash
export INFERENCE_STATE_DIR="$HOME/.local/share/modelharbor/inference"
ssh -F "$INFERENCE_STATE_DIR/ssh.conf" -NT modelharbor-api-tunnel
```

The bundled automatic installer targets macOS. Linux users can wrap these foreground commands
in their existing service manager. Keep Ollama running using its normal service manager; the
sharing installer intentionally does not take over or restart an existing inference process.
A Mac must remain powered, awake, connected, and logged in. FileVault unlock and login are not automated.

## Client usage

Only distribute the URL, model name, and that person's key. No user/session headers are needed.

Run `pnpm sharing handoff` to generate a private `client-guide.local.md` containing this instance's
API URL, model and limits, with no API key or SSH/server inventory. Share that guide privately and
deliver each key separately. The [source template](templates/CLIENT_HANDOFF.md) contains placeholders only.

```python
import os
from openai import OpenAI

client = OpenAI(
    base_url=os.environ["OPENAI_BASE_URL"],  # https://api.example.com/v1
    api_key=os.environ["OPENAI_API_KEY"],
    timeout=660,
)
response = client.chat.completions.create(
    model="local-default",
    messages=[{"role": "user", "content": "Hello"}],
    temperature=0.2,
    top_p=0.9,
    max_tokens=256,
)
print(response.choices[0].message.content)
print(response.usage)
print(response.model_extra.get("inference"))
```

For streaming:

```python
for chunk in client.chat.completions.create(
    model="local-default",
    messages=[{"role": "user", "content": "Hello"}],
    max_tokens=256,
    stream=True,
    stream_options={"include_usage": True},
):
    if chunk.choices:
        print(chunk.choices[0].delta.content or "", end="", flush=True)
    if chunk.usage:
        print("\nUsage:", chunk.usage)
    if chunk.model_extra.get("inference"):
        metadata = chunk.model_extra["inference"]
```

The optional example [sharing-client.py](../scripts/sharing-client.py) runs both modes and prints
returned token counts and inference metadata. Install `openai` in a separate client environment;
it is not a gateway dependency. SDKs normally preserve unknown JSON fields, but custom clients
with strict schemas may need to allow the added `inference` property.

## Response metadata and measurement limits

`choices`, `model`, `usage`, and SSE `data: [DONE]` retain the Chat Completions structure. The gateway
adds **`inference`**, an extension owned by ModelHarbor, not an official OpenAI field:

```json
{
  "usage": {"prompt_tokens": 17, "completion_tokens": 2, "total_tokens": 19},
  "inference": {
    "request_id": "example-request-id",
    "model": "your-model",
    "parameters": {"max_tokens": 256, "temperature": 0.2, "top_p": 0.9, "reasoning_effort": "none"},
    "parameter_source": "forwarded_request",
    "backend_default_parameters": ["seed", "frequency_penalty", "presence_penalty"],
    "timing_ms": {"queue": 0, "upstream": 500, "total": 502},
    "usage_source": "backend"
  }
}
```

The numbers above illustrate the schema. Actual `usage` comes directly from the backend, never a
character-count estimate. Missing counts are not fabricated. `parameters` reports the bounded
values sent to Ollama; unprovided sampling settings are listed under `backend_default_parameters`
without pretending to know the backend's effective defaults. Tool schemas, stop strings, prompts,
keys, private deployment addresses, and user identifiers are not echoed into metadata.

`timing_ms.queue` is time waiting in this gateway; `upstream` includes backend queueing, model
loading, generation, and response transfer; `total` starts at the local gateway. These are not
GPU-only timings or client-observed Internet round-trip timings. Context/KV configuration,
cache-hit counts, GPU memory, and generation-only throughput are not reported by this backend's
Chat Completions response and are not invented here.

For SSE, metadata appears on the first chunk, finish chunks, and the usage chunk. Times on early
chunks are snapshots; the final usage chunk has the latest completed-request measurement.
Streaming usage is enabled by default, and callers can explicitly set `include_usage: false`.
The final usage chunk has `choices: []`; always guard before indexing `choices[0]`. Interrupted
streams may never deliver final usage, and a truncated backend stream is not converted into a
successful `[DONE]` response.

## Limits and private operations

- Five admitted requests, one per authenticated user, one backend generation at a time. Existing
  local workloads share the same Ollama, so overall device capacity is not increased.
- 30 requests per minute per key identity; 429 responses include Retry-After.
- 2 MiB request body, ten-minute request deadline including queueing.
- Output default: min(1024, maxTokens); accepts `max_completion_tokens` as an alias for `max_tokens`.
- One choice (`n=1`); text and function-call messages only. Image fetching is blocked at ingress.
- Thinking defaults to `reasoning_effort: "none"`; callers can select a supported effort.

```bash
pnpm sharing status                 # Users/status only, never key values
pnpm sharing key-revoke collaborator-2
pnpm sharing key-add collaborator-2 # New random key, after revocation
```

Revocation takes effect on subsequent requests without restarting; already admitted requests
are allowed to finish. Run administrative key commands serially. The key registry contains only
SHA-256 hashes, user names, and enabled flags. Individual `.key` delivery files and registry are
mode 600, under a mode-700 directory. Old delivery files should not be redistributed after revocation.

Logs are local `logs/YYYY-MM-DD.jsonl` files containing request ID, authenticated user label,
status, timing, scalar inference parameters, and backend usage when available, including complete
streams. They do not contain prompts, answers, Authorization, or client-supplied URLs. Protect and
rotate these private logs according to your needs. Aggregate billing and a management dashboard
are intentionally outside this small deployment.

Stop the macOS sharing services:

```bash
launchctl bootout "gui/$(id -u)/com.codesoul.modelharbor.tunnel"
launchctl bootout "gui/$(id -u)/com.codesoul.modelharbor.inference"
```

Use `pnpm sharing install-macos` to update/re-enable them after a build. Keep private state out of
Git even if the repository is private. `.gitignore` covers the usual credentials and local config
names; it cannot protect arbitrary renamed files, so review staged files before publishing.

## Validation

```bash
pnpm exec tsc -p tsconfig.json
pnpm exec vitest run tests/inference-gateway.test.ts tests/sharing-cli.test.ts tests/admission-queue.test.ts
```

Tests cover authentication/revocation, endpoint isolation, model and output limits, identity
binding, redacted logs, FIFO admission, cancellation, split UTF-8 SSE, final usage, and private
configuration rendering. Live deployment checks must additionally confirm DNS/TLS, a valid-key
completion and stream, rejected invalid keys, and tunnel reconnection. Do not publish live keys,
server inventories, logs, or private test inputs with the test report.

References: [Ollama compatibility](https://docs.ollama.com/api/openai-compatibility),
[OpenAI Chat Completions](https://developers.openai.com/api/reference/resources/chat),
[Caddy reverse proxy](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy).

## 中文快速说明

这套方案公开的是可复用的代码和模板，个人域名、服务器地址、私钥、API Key、日志及实际部署文件只放本地。

1. `pnpm install --frozen-lockfile`，然后 `pnpm exec tsc -p tsconfig.json`。
2. 保持 Ollama 运行并准备好模型；执行 `pnpm sharing init` 生成私有配置和 5 个独立 Key。
3. 编辑命令输出的 `sharing.local.json`，填模型、域名和服务器信息。
4. `pnpm sharing render` 生成配置；在公网服务器执行生成的 `server-setup.sh`，合并 Caddy 配置并设置 DNS。
5. 确认 SSH 主机指纹；macOS 执行 `pnpm sharing install-macos`，随后测试公网调用。
6. 每位协作者只需 Base URL、模型名和自己的 Key。返回保留标准 `usage`，并用 `inference` 提供参数及耗时。

当前兼容文本 Chat Completions，并不等同于完整 OpenAI API。API Key 和密码不要粘贴到仓库、Issue 或 PR。
