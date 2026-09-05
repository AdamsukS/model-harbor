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
| `stop`、`response_format`、`tools`、`tool_choice` | 转发到后端，由后端检查及实现 |

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

## 限流、错误与重试

初始策略：同一 Key 身份同时一个生成请求，最多接纳五个请求，逐个执行；每分钟每个 Key 身份 30 次请求。
请求体不超过 2 MiB；排队加处理默认最长三十分钟。本地还有其他负载时，响应会更慢。

| HTTP 状态 | 如何处理 |
| --- | --- |
| 400 / 415 | 检查 JSON、参数以及 `Content-Type: application/json` |
| 401 | Key 缺失、无效或已撤销，联系服务所有者 |
| 404 | Base URL、模型或路径不正确；不要重复拼接 `/v1` |
| 413 | 减少输入大小 |
| 429 | 等待 `Retry-After` 指定秒数；避免并发和无间隔重试 |
| 502 / 503 | 隧道或本地后端可能离线，稍后重试或联系所有者 |
| 504 | 排队 / 生成超时，减少上下文或输出上限后重试 |

网关错误一般有 `error.message`、`error.type` 和 `error.code`。代理层错误也可能是纯文本或空响应。
SDK 可能自动重试，避免再叠加无限重试循环；无法确认是否完成的生成可能在重试后再次计算。
排查时提供时间、HTTP 状态和请求 ID 即可。不要在公开 Issue、截图或日志中放入 Key、私人消息或完整部署信息。
