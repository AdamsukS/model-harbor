# ModelHarbor

[English](README.md)

ModelHarbor 是面向个人硬件的本地优先、多模型 Agent 运行服务。当前 `next` 架构使用：

- [Hypha](https://github.com/AdamsukS/Hypha) 管理版本化 Agent 与 DomainPack 合约；
- [Plasmod](https://github.com/AdamsukS/Plasmod) 管理带作用域隔离的持久化 Agent Memory；
- [Ollama](https://ollama.com/) 提供不依赖 Python 的 Apple Silicon 原生推理；
- TypeScript 网关负责有界排队、上下文组装和 OpenAI 兼容 API。

项目名称与公开接口不绑定具体模型，Qwen3.5-9B 只是首个本地模型配置。

## 当前状态

- 默认分支：`next`（TypeScript + Go + 原生推理，不使用 Python 运行时）
- 旧版基线：`main`（MLX-LM/Python）
- API：`http://127.0.0.1:8787/v1`
- Agent Bench：`http://127.0.0.1:8787`
- 推理模型：`qwen3.5:9b-q4_K_M`，本地配置名为 `qwen3.5:9b-128k`
- 请求上下文：128K Token
- 调度：同时只执行一个生成；最多接纳 5 个请求、5 个用户
- Memory：Plasmod 磁盘存储，按照 tenant、用户和 Session 隔离检索
- 网络范围：仅本机回环地址

已有的 `models/Qwen3.5-9B-4bit` MLX 模型仍保留并被 Git 忽略。Ollama 不能直接读取该
目录，因此会额外下载 Ollama/GGUF 格式的模型。

## 架构

```text
客户端
  -> ModelHarbor :8787
       -> FIFO 接入队列（1 个执行 / 最多 5 个用户）
       -> Hypha DomainPack 合约
       -> Plasmod Memory 检索 :8080
       -> 有界上下文组装
       -> Ollama 推理 :11434
       -> Plasmod 对话事件写入 :8080
```

Hypha 与 Plasmod 不会被复制进项目，也不使用 submodule。`scripts/prepare.sh` 会把你的
两个 fork 固定到指定 commit，并检出到 Git 忽略的 `.runtime/`。ModelHarbor 通过 Hypha
官方发布的 npm 包使用其产品集成接口。

## 环境要求

- Apple Silicon macOS
- Node.js 22 LTS 并包含 npm（完整 Hypha checkout 当前锁定的原生 SQLite 依赖尚不兼容
  Node 26）
- pnpm 11
- Go 1.25 以上版本
- Ollama
- 约 8 GiB 额外磁盘空间

可以通过 Homebrew 安装缺少的工具：

```bash
brew install node@22 pnpm go ollama
```

## 快速启动

```bash
pnpm install
pnpm run runtime:prepare
pnpm start
pnpm run health
pnpm run smoke
```

浏览器打开 `http://127.0.0.1:8787` 即可使用同源 Agent Bench，其中包含 Chat、持久化
Session 历史、Plasmod canonical Memory 查看，以及运行时、KV 与队列指标。浏览器只保存
界面偏好，Plasmod 仍是唯一持久化来源。

准备脚本可以重复执行，并会拒绝修改存在未提交内容的 Hypha/Plasmod checkout。运行状态、
日志、PID、Plasmod 数据以及 fork 源码都不会进入 Git。

停止由 ModelHarbor 启动的进程：

```bash
pnpm stop
```

该命令不会删除模型、Memory 数据、fork checkout 或旧 MLX 环境。

## 调用示例

Chat 和 Memory 请求必须带 `X-User-ID` 与 `X-Session-ID`：

```bash
curl http://127.0.0.1:8787/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -H 'X-User-ID: local-user-1' \
  -H 'X-Session-ID: session-1' \
  -d '{
    "model": "local-default",
    "stream": false,
    "messages": [{"role": "user", "content": "你好，只回复 OK。"}]
  }'
```

Chat 已支持可选的 Hypha 治理只读工具：当前时间、Apple Calendar/Mail，以及免 Key 的 Exa MCP 网页搜索（免费档有限流）。
详见[工具与本地授权](docs/TOOLS.md)。目前仍为非流式 Chat；通用 MCP 动态工具导入、完整 Hypha Production Harness、自动摘要以及
直接 llama.cpp KV 实验会在后续逐步接入。

## 128K 与 KV Cache

Ollama 模型配置请求 `131072` Token。启动参数启用 Flash Attention、最多加载一个模型、
单路生成，并使用量化 `q4_0` KV Cache。默认关闭思考模式以控制交互队列延迟；可通过
`OLLAMA_THINKING=true` 开启。ModelHarbor 还会把实际组装的 Prompt 限制在
360,000 字符以内，优先保留最新对话，并裁剪过长的召回 Memory。

在 16 GiB Mac 上，128K 是实验容量目标，并不代表任意 128K 请求都一定能稳定完成。
模型权重、KV Cache、运行缓冲区、Plasmod 与 Node 会共享统一内存。后续可在现有
`InferenceClient` 接口后接入直接 llama.cpp 后端，以便更细粒度地研究 slot、prefix 与 KV。

## 文档

- [API 文档](docs/API.md)
- [模块与维护](docs/MODULES.md)
- [运行维护指南](docs/OPERATIONS.md)
- [工具与本地授权](docs/TOOLS.md)
- [Memory 对照测试方法](docs/MEMORY-EVALUATION.md)
