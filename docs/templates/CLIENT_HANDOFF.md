# 模型服务接入说明

此文件由服务所有者提供给协作者；Key 单独交付。不要将填写了实际地址的版本提交到公开仓库。

| 项目 | 内容 |
| --- | --- |
| Base URL | `{{BASE_URL}}` |
| 模型 ID | `{{MODEL}}`，也可以使用 `local-default` |
| 鉴权 | `Authorization: Bearer <你的个人 Key>` |
| 输出上限 | 每请求 `{{MAX_TOKENS}}` tokens；默认 `{{DEFAULT_TOKENS}}` |
| 并发与频率 | 每 Key 身份最多 1 个生成请求；全服务最多接收 5 个并排队；每 Key 身份每分钟 30 次请求 |

你不需要服务器账号、SSH 或本地模型文件。收到 Key 后，把它保存到自己的 `OPENAI_API_KEY` 环境变量，
不要写进代码仓库或共享截图。以下示例的模型别名会映射到上表中的实际模型。

## 快速调用

```bash
export OPENAI_BASE_URL='{{BASE_URL}}'
# OPENAI_API_KEY 通过私下渠道领取并在本地设置。
curl "$OPENAI_BASE_URL/chat/completions" \
  -H "Authorization: Bearer $OPENAI_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"model":"local-default","messages":[{"role":"user","content":"你好"}],"stream":false}'
```

Python（已安装 `openai` 包）：

```python
import os
from openai import OpenAI

client = OpenAI(
    base_url="{{BASE_URL}}",
    api_key=os.environ["OPENAI_API_KEY"],
    timeout=660,
)
response = client.chat.completions.create(
    model="local-default",
    messages=[{"role": "user", "content": "你好"}],
)
print(response.choices[0].message.content)
print(response.usage)
print((response.model_extra or {}).get("inference"))
```

支持 OpenAI Chat Completions 格式的文本请求和流式输出，未开放完整 OpenAI API。
多轮对话需每次提交所需历史；本入口不持久保存会话，不执行工具，也不访问服务所有者的 Agent 记忆。
服务端会在本地记录请求身份、状态、耗时及后端 token 统计，不在访问日志中记录提示词和回答。

## 流式输出

设置 `stream=True` 与 `stream_options={"include_usage": True}`，逐块读取 `choices[0].delta.content`。
只有 `chunk.choices` 非空时才读取它；最后的用量块可能是 `choices: []`。
用量来自 `chunk.usage`，推理参数和耗时来自 `(chunk.model_extra or {}).get("inference")`。
流中断时可能收不到最终统计。

## 遇到问题

- 401：Key 无效或被撤销，请联系给你 Key 的服务所有者。
- 429：按 `Retry-After` 等待，减少并发，不要无限重试。
- 502 / 503 / 504：本地设备、隧道或推理后端可能不可用，或生成超时，请稍后重试。
- 404：检查地址是否重复拼了 `/v1`；可请求 `GET {{BASE_URL}}/models` 查询模型。

本服务依赖所有者的本地设备保持在线，不承诺全天候可用。反馈时提供时间、状态码和请求 ID，
不要发送 Key 或私人消息内容。

完整通用 API 文档见 ModelHarbor 仓库的 `docs/INFERENCE_API.md`；部署文档见 `docs/DEPLOYMENT.md`。
