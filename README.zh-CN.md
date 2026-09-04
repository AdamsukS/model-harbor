# ModelHarbor

[English](README.md)

ModelHarbor 是面向个人硬件的本地优先、多模型 Agent 运行服务。当前 `next` 架构使用：

- [Hypha](https://github.com/AdamsukS/Hypha) 管理 Agent/DomainPack 合约、工具治理与 MCP 连接；
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
- Memory：Plasmod 磁盘存储；默认当前会话召回，可选同用户跨会话召回或关闭召回
- 工具：系统时间、免 Key 的 Exa MCP 搜索，以及所有者令牌保护的 Apple Calendar/Mail 只读工具
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
            <-> Hypha 工具治理（Exa MCP / 本机只读工具）
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

## 工具与 Memory 控制

在 Bench 中展开 **Tools & Memory controls**：

1. 选择当前会话召回、同用户跨会话召回或关闭召回。关闭召回仍会写入完成的对话，且仍包含
   界面中的历史消息，因此不能直接作为干净的实验基线。
2. 选择 **Public: time / web**，填写 **Approved public search query**，再让 Agent 搜索。
   Exa MCP 免费档不需要 Key，但有限流；只允许发送你明确批准的原样搜索词。
3. 使用 **Private: Apple Calendar / Mail** 时，需要配置的所有者身份、本地令牌和 macOS
   自动化授权。仅读取日程信息和收件箱邮件头，不会发信或创建日程；重复日程展开并不完整。

每条回答可查看工具轨迹和作用域校验后的召回证据。API 默认关闭工具；Exa 是已配置的搜索
提供方，不是自动在后台持续搜索的服务。详见[配置与安全](docs/TOOLS.md)、
[MCP 配置](config/mcp.json)和 [API 控制字段](docs/API.md)。

### 验证快照 — 2026-09-04

| 检查项 | 结果 |
|---|---|
| 自动化测试 / TypeScript / 生产构建 | 59 项测试通过，类型检查和构建通过 |
| 时间与 Exa MCP 搜索 | 已验证真实本地模型调用；搜索返回来源链接 |
| Apple Calendar / Mail | 适配器已实现；本机检查超时或提示不可用/权限拒绝，尚未验证账户读取 |
| Memory 必需事实任务 | 关闭召回 0/8，同用户跨会话召回 8/8 |
| 本地防护后的隔离负向检查 | 其他用户 4/4，新会话默认隔离 4/4 |

Memory 实验使用真实本地推理与 Plasmod，但任务数据是**虚构工作场景**：四类任务，每种模式
重复两次，并非真实私人账户任务或官方 benchmark。首次新会话隔离为 0/4；增加本地作用域
校验后为 4/4，任务提示没有改变，两次记录均保存在本地。该小样本不能证明通用长期记忆质量
或生产安全性。详见[测试方法与限制](docs/MEMORY-EVALUATION.md)。

服务运行后可执行：

```bash
pnpm test
pnpm run typecheck
pnpm run build
pnpm run tools:check-web
pnpm run tools:check-apple
pnpm run eval:memory
```

网页搜索检查不写入 Memory；Memory 实验会创建隔离测试用户的记录。完整实验轨迹保存在被
Git 忽略的 `runtime/evals/`，不会发布进仓库。

## 安全边界与当前限制

当前是本地原型，不是可直接公开部署的多用户网关。用户/会话请求头仅标识作用域，不能认证
调用者；本机工具令牌只保护账户工具执行。对外开放任何端点前，必须增加网关身份认证和租户
授权。搜索词会发送到外部提供方；默认部署的推理、对话历史与 Memory 保留在本地。网页结果
和召回内容都是不可信证据，不应被当作指令执行。

Chat 仍为非流式。通用 MCP 动态工具导入、完整 Hypha Production Harness、自动 Memory 摘要、
日历/邮件写操作，以及直接 llama.cpp KV 实验尚未实现。当前工具请求最多四轮模型推理、
六次工具调用。

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
