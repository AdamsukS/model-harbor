# 共享推理 API 使用指南

本文面向已经拿到服务地址和个人 Key 的协作者。你不需要 SSH、云服务器账号、模型文件或本地安装 Ollama。
自行部署请看[部署指南](DEPLOYMENT.md)；本地 Agent / Memory 的另一套接口请看 [API.md](API.md)。

## 接入信息

服务所有者提供以下内容：

| 内容 | 示例 / 说明 |
| --- | --- |
| Base URL | `https://api.example.com/v1`，以所有者实际提供的地址为准 |
| API Key | 个人独立 Key，通过私下渠道领取，不在公共文档中提供 |
| 模型 | 优先使用 `local-default`；也可以查询 `/models` 获取实际模型 ID |
| 限额及可用时间 | 由所有者提供；本地设备离线时服务不可用 |

设置环境变量，避免把 Key 写进源代码：

```bash
export OPENAI_BASE_URL='https://api.example.com/v1'
export OPENAI_MODEL='local-default'
# 请通过自己的终端或秘密管理工具设置 OPENAI_API_KEY。
```

所有请求使用 `Authorization: Bearer <你的 Key>`。不要将 Key 放在 URL 查询参数中。
不需要 `X-User-ID` 或 `X-Session-ID`；客户端传入的 `user` 也不能改变授权身份。

## 查询模型

```bash
curl "$OPENAI_BASE_URL/models" \
  -H "Authorization: Bearer $OPENAI_API_KEY"
```

成功返回 OpenAI 格式的模型列表：

```json
{"object":"list","data":[{"id":"configured-model","object":"model","created":0,"owned_by":"local"}]}
```

这是网关配置的模型目录，不是后端健康探测；确认推理可用需再执行一次生成请求。

## 普通调用

```bash
curl "$OPENAI_BASE_URL/chat/completions" \
  -H "Authorization: Bearer $OPENAI_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "local-default",
    "messages": [{"role":"user","content":"你好，请简短介绍一下你自己。"}],
    "temperature": 0.2,
    "top_p": 0.9,
    "max_tokens": 256,
    "stream": false
  }'
```

Python 客户端先在自己的环境安装 `openai`，然后：

```python
import os
from openai import OpenAI

client = OpenAI(
    base_url=os.environ["OPENAI_BASE_URL"],
    api_key=os.environ["OPENAI_API_KEY"],
    timeout=1860,
)
response = client.chat.completions.create(
    model=os.environ.get("OPENAI_MODEL", "local-default"),
    messages=[{"role": "user", "content": "你好"}],
    max_tokens=256,
    temperature=0.2,
)
print(response.choices[0].message.content)
print(response.usage)
print((response.model_extra or {}).get("inference"))
```

多轮聊天需要在每次请求中提交所需的 `messages` 历史。共享推理入口不为你持久保存会话，
也不会读取服务所有者的 Agent Memory。`tools` 描述的是供模型选择的函数；实际执行由调用方负责。

## 流式输出与 token 用量

```python
stream = client.chat.completions.create(
    model=os.environ.get("OPENAI_MODEL", "local-default"),
    messages=[{"role": "user", "content": "用三句话介绍 Python。"}],
    max_tokens=256,
    stream=True,
    stream_options={"include_usage": True},
)
for chunk in stream:
    if chunk.choices:
        print(chunk.choices[0].delta.content or "", end="", flush=True)
    if chunk.usage:
        print("\nToken 用量：", chunk.usage)
        print("推理信息：", (chunk.model_extra or {}).get("inference"))
```

原始协议为 SSE，以 `data: [DONE]` 结束。最后的用量块通常是 `choices: []`，请勿无条件读取
`choices[0]`。网关默认开启流式用量，也接受显式的 `include_usage: false`；中断的流可能没有最终统计。
完整可运行示例：[sharing-client.py](../scripts/sharing-client.py)。

长输出建议使用流式调用。默认服务端时限为 1800 秒（包含排队与生成），示例客户端设置为
1860 秒。调用方若使用 300 秒 timeout，会在五分钟时先断开并失去该次结果；服务端通常记录为 499。

## 请求参数

| 字段 | 约束与行为 |
| --- | --- |
| `model` | 必填；配置的模型 ID 或 `local-default` |
| `messages` | 非空数组；文本消息，也接受文本 content parts 和函数调用消息 |
| `stream` | 布尔值；默认非流式 |
| `max_tokens` / `max_completion_tokens` | 正整数，二选一；默认 min(1024, 所有者配置的上限)，初始上限 16384 |
| `temperature` | 0–2；未指定时使用后端默认值 |
| `top_p` | 0–1；未指定时使用后端默认值 |
| `seed` | 整数；不能据此保证跨模型 / 版本的绝对复现 |
| `frequency_penalty` / `presence_penalty` | -2–2，实际效果由后端支持情况决定 |
| `reasoning_effort` | `none` / `low` / `medium` / `high` / `max`，默认 `none`；模型需支持相应值 |
| `reasoning.effort` | 可代替 `reasoning_effort`；不要同时传入相互冲突的值 |
| `stream_options.include_usage` | 布尔值，用于流式统计 |
| `n` | 只支持 1 |
| `stop`、`tools`、`tool_choice` | 转发到后端，由后端检查及实现 |
| `response_format` | 支持范围和 Schema 预检查见下方服务合同 |

当前只兼容这一部分 Chat Completions API；未知字段可能被忽略，不应把请求未报错当作功能已生效。
图片、音频、Embeddings、Responses、Agent 和模型管理接口不属于本入口的支持范围。

## 响应中的 `usage` 与 `inference`

- `usage.prompt_tokens`、`completion_tokens`、`total_tokens`：后端报告的 token 统计，不是按字符估算。
- `inference.parameters`：实际发送到后端的输出上限与已指定的采样 / reasoning 参数。
- `inference.backend_default_parameters`：没有显式指定、由后端决定的采样项；网关不猜测它们的最终值。
- `inference.timing_ms.queue`：在共享网关排队的耗时。
- `inference.timing_ms.upstream`：包括后端排队、模型加载、生成和回传的时间，不是纯 GPU 计算时间。
- `inference.timing_ms.total`：本地网关观察到的总耗时，不包含完整的客户端公网往返时间。
- `inference.request_id`：可提供给服务所有者用于排查，无需发送 Key 或完整对话。

`inference` 是项目扩展字段；标准 `choices` / `usage` 结构保持不变。
Python SDK 通过 `model_extra` 访问扩展；使用严格 JSON schema 的客户端需允许它。
流式首块、结束块、用量块可带推理信息；首块耗时只是当时的快照。
后端未报告的 KV 命中、显存占用、精确计算时间等不会伪造成实测数据。

## 上下文版本选择

用原有 Key 调用 `GET /v1/models` 查看当前可选型号；部署了多个上下文档时，
每项的 `context_window` 给出实际后端窗口。请求里的 `model` 选择对应档位。
例如本机的 `qwen3.5:9b-32k` 为标准版，`qwen3.5:9b-128k` 为长上下文版。
`local-default` 继续指向部署配置的默认型号。

两档共享原始权重，后端一次只驻留一个档位。换档会等待当前请求完成并重新加载，
因此同批任务尽量使用同一档；窗口包含输入、聊天模板和实际输出。
模型名称不代表每个请求都有独占算力，超出实际生成槽位的请求会排队。

## 限流、错误与重试

默认策略：同一 Key 身份同时一个生成请求，最多接纳五个请求，逐个执行；每分钟每个 Key 身份 60 次请求。
所有者可用 `perKeyConcurrency` 放宽同一身份的在途请求数，用 `concurrency` 调整网关转发并发，
两项范围均为 1–8；总接纳数为 max(5, concurrency)，最多八个。单路后端可先设为 `perKeyConcurrency=2, concurrency=1`，允许第二个请求排队；
这不等于模型可以同时生成两份答案。排队时取消请求会立即释放名额。

网关对后端的等待使用同一个服务端总时限，不再额外受到 Node fetch 五分钟响应头超时影响。
若出现 503，所有者可通过日志中的 `upstream_status` 和 `error_code` 区分后端响应与传输错误。
请求体不超过 2 MiB；排队加处理默认最长三十分钟。本地还有其他负载时，响应会更慢。

| HTTP 状态 | 如何处理 |
| --- | --- |
| 400 / 415 | 检查 JSON、参数以及 `Content-Type: application/json` |
| 401 | Key 缺失、无效或已撤销，联系服务所有者 |
| 404 | Base URL、模型或路径不正确；不要重复拼接 `/v1` |
| 413 | 减少输入大小 |
| 429 | 等待 `Retry-After` 指定秒数；并发保持在所有者配置范围内，避免无间隔重试 |
| 502 / 503 | 隧道或本地后端可能离线，稍后重试或联系所有者 |
| 504 | 排队 / 生成超时，减少上下文或输出上限后重试 |

网关错误一般有 `error.message`、`error.type` 和 `error.code`。代理层错误也可能是纯文本或空响应。
SDK 可能自动重试，避免再叠加无限重试循环；无法确认是否完成的生成可能在重试后再次计算。
排查时提供时间、HTTP 状态和请求 ID 即可。不要在公开 Issue、截图或日志中放入 Key、私人消息或完整部署信息。

### llama.cpp 请求角色兼容性

仅有一条 system 或 developer 指令的任务，网关会保留该指令并补充空 user 轮次。
常规多轮请求应保留 user 问题；本模型的 system/developer 指令需放在开头的单条消息中。
已知的聊天模板角色错误返回 400 并提示修正 messages；无需将同一错误请求反复重试。

## 本机部署服务合同（2026-09-08）

此节说明当前 llama.cpp 部署；公网代理的独立超时不由本机配置保证。
`GET /v1/models` 的 `service` 对象会返回实际网关限额、当前网关队列状态及计费/幂等能力。
模型目录及 `health: gateway_only` 不代表模型已完成健康生成检查。

| 项目 | 当前行为 |
| --- | --- |
| 32K 总窗口 | 32768 tokens，包含模板、系统指令、工具描述、输入与输出 |
| 128K 总窗口 | 131072 tokens，同样由输入与输出共享 |
| 输出上限 | 两种配置均为 16384；默认 1024；是上限，不保证每次生成满额 |
| 输入上限 | 总窗口减去本次 max_tokens；还须包含实际聊天模板的 tokens |
| 超预算 | 使用实际模型模板和 tokenizer 预检查；非流式返回 400 / CONTEXT_LENGTH_EXCEEDED；不删输入、不减少输出预算 |
| tokenizer | 原 GGUF 内嵌词表与预处理元数据；执行版本 llama.cpp d222767c7 + Ollama v0.33.2 兼容层，不是另装的客户端 tokenizer |
| 实际模型并行 | 32K：3 slots；128K：2 slots；16 GiB Mac 同时只驻留一种配置，切换配置会等待并重新加载 |
| 入场上限 | 每 Key 8 个在途请求，全服务合计 8 个；包括执行与等待；最多 5 个不同用户 |
| 排队 | FIFO 网关队列和模型内部调度，无优先级；3 个 32K 请求可同时占用模型 slots，其余等候 |
| 等待时限 | 无单独排队时限；接收起 1800 秒总预算，排队、模型加载、预检查、推理均计入 |
| 速率 | 每 Key 每分钟 60 次，包括查询；无 TPM、每日 tokens 或余额限制 |
| 拥塞 | 429，含 Retry-After: 10；已识别的加载/繁忙错误同样返回 429 |
| 计费 | 本服务没有计费系统；成功和失败均不收取 token 费用，charged: false；计算消耗仍可能发生 |

例如实际 `prompt_tokens=17146`、`max_tokens=16384` 合计 33530，32K 配置会在生成前拒绝。
保持相同输入时，可把输出预算降到 15622，或改用 128K 配置。模板计数计入输入，不能仅按用户文字估算。
预检查的 `inference.prompt_tokens` 与后端实际 `usage.prompt_tokens` 分别保留，以便核对。

### Schema 的明确支持范围

`response_format.json_schema.schema` 使用底层 grammar 约束解码；网关还会校验完整输出。
支持显式单一 type、嵌套 object/array、properties、required、additionalProperties、enum/const、
数组 minItems/maxItems（含固定向量和二维矩阵）、整数 minimum/maximum、字符串 minLength/maxLength、
本地 `$defs`/`definitions` 引用和不带兄弟约束的 anyOf。

不支持 oneOf、allOf、浮点数范围、pattern/format、远程或递归引用，以及白名单之外的关键字：
返回 400 / UNSUPPORTED_JSON_SCHEMA，不退化到普通 JSON 模式。enum/const 仅可与 type 组合；
`$ref` 不可带兄弟约束。每个 Schema 最大 64 KiB、24 层、1024 个节点；请求仍受 2 MiB 总上限约束。
较复杂语法会增加编译和采样成本，没有统一的延迟保证。

完整输出不符合 Schema 时返回 SCHEMA_VALIDATION_FAILED；不会标记为成功 stop。
达到 token 上限时保留 finish_reason=length，此时 JSON 可能不完整，不能按符合 Schema 的结果使用。
流式内容在最终校验之前都是暂定片段；需等 stop 和 [DONE]，并检查是否有 error。

### 长连接、错误与安全重试

非流式响应在推理完成后发送。本机总时限 1800 秒；SDK 的 timeout 是客户端设置，
不改变服务端上限。请求 JSON 中的 timeout 不受支持，不要依赖它延长服务端时限。
流式响应在本地参数检查后发送 SSE headers，每 15 秒发送 `: heartbeat` 注释，覆盖排队和等待模型响应。
标准 SSE 客户端会忽略这些注释。若后续检查或推理失败，发送 `data: {"error": ...}`，不发送成功的 [DONE]。
因此流式开始后不能再改变 HTTP 状态；必须检查流中的错误。

所有到达本机网关的响应均包含 X-Request-ID；错误中同时包含 request_id、code、stage、retryable、
retry_after、usage、usage_source、charged。错误类型区分并发/RPM、上下文/输出限制、模板/Schema、
上游不可用、上游超时和本机排队/请求超时。公网层独立生成的错误不保证包含本机 Request ID。

日志包含接收时间、网关排队时长、后端阶段耗时、失败状态、消息角色数量与后端报告的 usage；
不记录 Key 或提示正文。网关的 upstream 时间包含模型内部排队，不冒充 worker 真正开始计算的时间。
未拿到后端最终统计时 usage=null / usage_source=not_reported，不伪造为 0。
流式失败的日志同时记录 HTTP status 和 failure_status，避免将已经发出 HTTP 200 的错误流算成成功。

当前不支持幂等缓存；发送 Idempotency-Key 会明确返回 400 / IDEMPOTENCY_NOT_SUPPORTED。
连接断开会取消本机对应的上游请求。重试仍可能重复计算；没有重复收费。
对 429/503/504 使用 Retry-After 并加入随机退避，关闭 SDK 无限制重试；400 应修正请求后再提交。
网关不会自动重放失败 POST。模型更新应先排空请求，单台 Mac 不承诺滚动更新零中断。
