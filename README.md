# 本地 Qwen3.5-9B 服务 / Local Qwen3.5-9B Service

[中文](#中文) · [English](#english)

## 中文

这是一个面向 Apple Silicon 的本地 Qwen3.5-9B 推理服务。项目使用
`mlx-community/Qwen3.5-9B-4bit` 和 MLX-LM，提供兼容 OpenAI 的 HTTP API，
并包含可复现的 Prompt/KV Cache 实验工具。

当前阶段专注于可靠的基础推理服务。Agent 编排、持久化 Memory、摘要、检索和
上下文裁剪将在后续阶段作为独立服务层逐步实现。

### 当前状态

- API：`http://127.0.0.1:8000/v1`
- API 模型别名：`default_model`
- 模型版本：`8b2b98c00a6b4d291155e4890773ca8f769aee53`
- 本地模型大小：约 5.57 GiB
- 运行后端：MLX-LM + MLX + Apple Metal
- 并发目标：已验证 5 个客户端同时提交并排队完成
- 上下文目标：128K；32K 已验证，64K 和 128K 为分阶段实验
- 默认缓存：保留一个 Prompt Cache，内存上限 `1200MB`
- 网络范围：仅监听本机回环地址，不包含鉴权
- SGLang：已安装和实测，但当前被其 Qwen3.5 混合 Mamba/Metal 兼容性限制阻塞

### 快速开始

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

### 容量与缓存实验

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

### 文档

- [API 文档](docs/API.md)
- [模块与维护文档](docs/MODULES.md)
- [KV Cache 基准](results/cache-baseline.md)
- [SGLang 兼容性结论](results/sglang-compatibility.md)

## English

This project runs `mlx-community/Qwen3.5-9B-4bit` locally on Apple Silicon with
MLX-LM. It exposes an OpenAI-compatible HTTP API and includes reproducible
Prompt/KV-cache experiments.

The current phase focuses on a reliable inference baseline. Agent orchestration,
durable memory, summarization, retrieval, and context trimming will be added
later as a separate service layer.

### Current status

- API: `http://127.0.0.1:8000/v1`
- API model alias: `default_model`
- model revision: `8b2b98c00a6b4d291155e4890773ca8f769aee53`
- local model size: about 5.57 GiB
- backend: MLX-LM + MLX + Apple Metal
- concurrency target: 5 simultaneous clients have completed successfully
- context target: 128K; 32K is verified, while 64K and 128K are staged experiments
- default cache: one retained prompt cache capped at `1200MB`
- network scope: loopback only, with no authentication layer
- SGLang: installed and tested, but currently blocked by its Qwen3.5 hybrid
  Mamba support on Apple Metal

### Quick start

Requirements: Apple Silicon macOS, about 8 GiB of free disk space, and
[`uv`](https://docs.astral.sh/uv/). From this repository, run:

```bash
scripts/prepare.sh
scripts/start-mlx.sh
scripts/health.sh
scripts/smoke.sh
```

`prepare.sh` is idempotent: it creates the pinned Python environment and reuses
model files that are already downloaded. `start-mlx.sh` waits for the port to
become ready and writes a managed PID record under the ignored `runtime/`
directory.

Stop the service with:

```bash
scripts/stop.sh
```

Logs are stored in `runtime/mlx.log`. A minimal request is:

```bash
curl http://127.0.0.1:8000/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "default_model",
    "messages": [{"role": "user", "content": "Reply with OK only."}],
    "max_tokens": 16,
    "chat_template_kwargs": {"enable_thinking": false}
  }'
```

Always use `default_model` against the current MLX endpoint. Passing a Hugging
Face repository ID tells MLX-LM to dynamically resolve another model, while
this project intentionally disables network model resolution at runtime.

### Capacity and Cache experiments

Prompt and decode concurrency both default to `1`. Requests arriving together
wait inside the backend instead of making five decode streams compete for 16 GiB
of unified memory. `scripts/smoke.sh` has verified 5 concurrent clients complete
successfully. This is an operating target rather than hard admission control;
a future Agent Gateway should implement identities, quotas, and an explicitly
bounded queue.

Run cache experiments in order:

```bash
scripts/bench-cache.sh 32k
scripts/bench-cache.sh 64k
scripts/bench-cache.sh 128k
```

The 64K profile requires a successful 32K result, and 128K requires a successful
64K result. Every request has a swap watchdog that terminates the benchmark
backend if swap grows by 1 GiB from the warmed baseline. The verified 32K run
reused 32,714 cached tokens and reduced time to first token from `197.879s` to
`0.843s`.

On this 16 GiB machine, 128K is an experimental goal rather than a stable
production guarantee. The future Agent layer should combine a recent-message
window with memory retrieval, summarization, and deterministic trimming.

### Documentation

- [API contract](docs/API.md)
- [Modules and maintenance](docs/MODULES.md)
- [KV-cache baseline](results/cache-baseline.md)
- [SGLang compatibility result](results/sglang-compatibility.md)
