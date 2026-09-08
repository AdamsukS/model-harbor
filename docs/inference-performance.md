# 公网 API 503 与延迟排查（2026-09-06）

## 发现

检查本机共享网关的 9 月 4–6 日访问日志，共发现 45 次 503。这些请求的后端等待耗时
中位数为 301.432 秒，网关排队中位数为 0 毫秒；输出上限分别为 8192（27 次）和
16384（18 次）。Ollama 日志显示，部分请求在被取消前仍以约 15–16 tokens/s 生成。
访问日志只能证明请求失败，无法判断协作者的整个任务是否终止、重试或已恢复。

用延迟 310 秒才发送响应头的本机假后端复现：旧网关虽配置 360 秒总时限，仍在
301.013 秒返回 503，诊断通道记录 `UND_ERR_HEADERS_TIMEOUT`。
Node 22.23.2 内置 fetch 的独立响应头超时是 300 秒，延长 AbortSignal 总时限不能覆盖它。
这是共享网关的集成问题，无需修改 Ollama。

同一假后端、同一 360 秒时限，新网关在 310.023 秒返回 200，保留完整响应。
27 项针对性测试与 TypeScript 检查通过，覆盖流式响应、取消、超时、单用户与后端并发、
限流、认证、重定向拒绝及共享队列的 Agent 服务兼容性。

修复已于本地时间 12:42 前应用到共享服务，旧版程序与配置已备份。上线后通过公网验证
普通响应、SSE 响应以及同一 key 同时发出两个请求，四次均返回 200；第二个并发请求
在网关排队 2.462 秒后完成。证据见 `runtime/diagnostics/production-smoke.json`。

## 修复

- 后端请求改用 Node 原生 HTTP/HTTPS，响应头等待和响应体读取统一受已有总时限控制。
- 支持 `perKeyConcurrency` 与 `concurrency`（范围 1–5，默认均为 1），总在途上限仍为 5。
- 排队中取消或超时立即释放名额；后端 429 保留为 429，503 提供 `Retry-After`。
- 私有日志增加 `upstream_status` 和 `error_code`，不记录后端错误正文或凭据。

## 延迟实测

Apple M4、16 GiB，Ollama 0.33.2，`qwen3.5:9b-128k`，单路推理。
固定同一提示、temperature=0、seed=42、reasoning_effort=none、非流式、64 输出 tokens；
每条路径三次，轮换测试顺序，另一次冷启动预热不计入中位数。

| 路径 | 中位耗时 |
| --- | ---: |
| 直连 Ollama 的兼容 API | 4.913 秒 |
| 本机共享网关 | 5.101 秒 |
| 公网 API（从本机经公网绕回） | 7.660 秒 |

所有九次请求均返回 200，输出均为 64 tokens，网关排队为 0–1 毫秒。
公网请求的客户端耗时减去网关总耗时，中位差为 2.749 秒，包含公网往返、连接建立和代理开销。
这是短请求的小样本诊断，不是吞吐基准，也不能代表其他地区协作者的网络延迟。
独立连续请求 `/v1/models` 的耗时为 2.344、2.420、0.599 秒，说明连接复用值得保留。

原始结果保存在 `runtime/diagnostics/latency.json`；超时复现脚本及前后结果保存在
`runtime/diagnostics/header-timeout.cjs`、`timeout-before.json` 和 `timeout-after.json`。
这些是传输诊断，与模型能力 benchmark 的官方指标无关。

## 使用建议

复用一个 SDK client／HTTP 会话；交互式调用启用 streaming，以便尽早看到生成结果。
按任务需要选择输出上限，固定参数再比较性能；不要为了降低延迟悄悄改变正式评测设置。
客户端总超时应大于网关时限，并对 429／503 遵循 Retry-After 做有上限的退避重试。

当前硬件先使用 `perKeyConcurrency=2, concurrency=1`，允许同一用户第二个请求排队。
这能减少并发请求被直接拒绝，不能提升模型本身的 tokens/s。真正的两路推理应先对更短上下文
单独测试，再同时调整 Ollama 与网关；128K 上下文直接翻倍并发可能加重内存压力。

参考：[Undici 超时参数](https://github.com/nodejs/undici/blob/main/docs/docs/api/Client.md)、
[Ollama 并发与内存说明](https://docs.ollama.com/faq#how-does-ollama-handle-concurrent-requests)。

## 2026-09-07：请求模板错误被误报为 503

当天排查时，`collaborator-1` 的访问记录为 33 次 503、15 次 200。
这 33 次 503 都来自后端 HTTP 500，耗时约 5 ms 到 6 秒；与此前 301 秒超时不同。
后端记录了 `Jinja Exception: No user query found in messages.`。
原始请求正文未保存，因此不能从旧日志反推出每个失败请求的完整 messages 结构。

用最小合成请求复现：仅有 system／developer 的 messages 在原模板下报相同 500，
保留原有角色和内容并追加空 user 消息后可渲染；普通 user 请求正常。
网关现对 llama.cpp 的单条 system／developer 请求执行这一兼容处理，两个上下文档共用该逻辑。
没有把系统指令降为 user，也没有添加新的任务文本。

其他仍无法找到用户问题的会话，后端若返回这两种已知 Jinja message 错误，或 system 消息位置／数量错误，网关返回
带修正说明的 400，不再伪装成可重试的服务不可用。其他未知后端 500 仍保持 503。
错误体仅作有界匹配，不对外回显或写入访问日志；日志新增原始消息角色计数
`message_roles`，不记录提示词和回答，供客户端重试时核对请求形状。

最小复现和公网验证在 `runtime/diagnostics/503-20260907/`。
已安装网关；安装目录 `backup-template-20260907` 保留上一个版本。
