# ModelHarbor

[English](README.md)

ModelHarbor 是一个本地优先的推理服务与实验工具集，用于在个人硬件上运行、评测并
逐步扩展多种大语言模型和推理后端。

项目当前支持的第一个运行方案是 Apple Silicon 上通过 MLX-LM 运行 Qwen3.5-9B。
项目级接口保持后端无关，后续可以继续接入其他本地模型与推理引擎。Agent 编排、
持久化 Memory、摘要、检索和上下文裁剪计划作为独立服务层逐步实现。

## 当前状态

- API：`http://127.0.0.1:8000/v1`
- 当前模型：`mlx-community/Qwen3.5-9B-4bit`
- API 模型别名：`default_model`
- 模型版本：`8b2b98c00a6b4d291155e4890773ca8f769aee53`
- 本地模型大小：约 5.57 GiB
- 运行后端：MLX-LM + MLX + Apple Metal
- 并发目标：已验证 5 个客户端同时提交并排队完成
- 上下文目标：128K；32K 已验证，64K 和 128K 为分阶段实验
- 默认缓存：保留一个 Prompt Cache，内存上限 `1200MB`
- 网络范围：仅监听本机回环地址，不包含鉴权
- SGLang：已安装和实测，但当前被其 Qwen3.5 混合 Mamba/Metal 兼容性限制阻塞

## 快速开始

要求：Apple Silicon macOS、约 8 GiB 可用磁盘空间，以及
[`uv`](https://docs.astral.sh/uv/)。在项目目录执行：

```bash
scripts/prepare.sh
scripts/start-mlx.sh
scripts/health.sh
scripts/smoke.sh
```

`prepare.sh` 可以重复执行：它会创建固定版本的 Python 环境，并复用已经下载的
模型文件。`start-mlx.sh` 会等待端口就绪，并把受管理的进程记录写入被 Git 忽略的
`runtime/` 目录。

停止服务：

```bash
scripts/stop.sh
```

日志位于 `runtime/mlx.log`。最小调用示例：

```bash
curl http://127.0.0.1:8000/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "default_model",
    "messages": [{"role": "user", "content": "你好，只回复 OK"}],
    "max_tokens": 16,
    "chat_template_kwargs": {"enable_thinking": false}
  }'
```

调用当前 MLX 服务时必须使用 `default_model`。如果直接传入 Hugging Face 仓库 ID，
MLX-LM 会把它当作动态加载另一个模型的请求，而本项目会在运行时主动禁止联网解析模型。

## 容量与缓存实验

默认 Prompt 并发和 Decode 并发都是 `1`。同时到达的请求会在后端等待，避免 5 条
Decode 流争抢 16 GiB 统一内存。`scripts/smoke.sh` 已验证 5 个并发客户端均能完成。
这代表当前运行目标，不是严格的接入上限；后续需要由 Agent Gateway 实现用户鉴权、
限额和显式有界队列。

缓存实验必须按顺序运行：

```bash
scripts/bench-cache.sh 32k
scripts/bench-cache.sh 64k
scripts/bench-cache.sh 128k
```

64K 实验要求 32K 成功，128K 实验要求 64K 成功。每个请求都带有 Swap Watchdog；
如果相对预热基线新增 1 GiB Swap，它会终止基准服务。已验证的 32K 实验复用了
32,714 个缓存 Token，将首 Token 延迟从 `197.879s` 降至 `0.843s`。

在 16 GiB 机器上，128K 是实验目标而不是稳定生产承诺。后续 Agent 层应结合近期
消息窗口、Memory 检索、历史摘要和确定性裁剪来控制实际 Prompt。

## 文档

- [API 文档](docs/API.md)
- [模块与维护文档](docs/MODULES.md)
- [KV Cache 基准](results/cache-baseline.md)
- [SGLang 兼容性结论](results/sglang-compatibility.md)

