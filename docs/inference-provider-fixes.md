# 本机 API 修复与验收记录：2026-09-08

范围：按所有者要求只修改本机服务，不检查或修改 SSH、公网 Caddy、CDN 或 WAF。

## 已修复

- 原生路由器声明 keep-alive，但立即复用其连接可复现 ECONNRESET。
  实测默认 Node Agent 连续三次为 200/reset/200；关闭上游连接复用后三次均 200。
  网关每次使用新的 loopback 连接，无自动重放 POST。
- 实际模板与 tokenizer 预检查总预算，超额明确报 CONTEXT_LENGTH_EXCEEDED。
- Schema 白名单与 Ajv 完整结果校验，拒绝底层不能强制的约束；覆盖流式与非流式。
- SSE 排队及等待首包期间每 15 秒心跳；迟到错误有结构化 error。
- 机器可读错误码、Request ID、失败阶段、重试建议、未知用量为 null、本服务不计费。
- /v1/models 附加实际服务限额；明确幂等未支持，拒绝被误认为已生效的幂等键。
- 网关 SIGTERM 等待在途请求，生成的 launchd 配置给予 1810 秒退出时间。
  强制终止、模型 worker 重启和单实例维护仍不能保证零中断。
- 部署改用包含 Schema 验证依赖的单文件 bundle，避免 macOS launchd 读取 Downloads 依赖失败。

## 可复验

```sh
pnpm typecheck
pnpm exec vitest run tests/inference-gateway.test.ts tests/inference-schema.test.ts tests/admission-queue.test.ts tests/sharing-cli.test.ts
pnpm build:inference
```

本机端到端证据：`runtime/diagnostics/provider-fixes-20260908/verification.json`。
三路同时测试普通生成、严格 3×3 矩阵与流式矩阵均成功；两种模型均接受 16384 输出预算。
实际 prompt token 用量与预检查相同；上下文超额、不支持的浮点范围与输出超额均明确 400。
这不代表已经生成完整 16384 tokens，也不代表 24 小时验收已完成。

## 长期验收与未完成项

`node scripts/inference-soak.cjs 24 21` 在 loopback 使用原 collaborator-1 Key、三路模型请求，
前 21 次为较大输出，随后持续短请求至 24 小时。日志只保留状态、时长、用量与 Request ID，
写入本机私有状态目录 `acceptance-20260908.jsonl`。连续失败会停止新增请求，不自动反复重试。
测试尚未结束时不得报告满足“20 次超过 600 秒”和“24 小时无持续 503”。

另有 20 个延迟 620 秒的隔离 HTTP 测试，用于验证网关传输定时器，
证据位于 `runtime/diagnostics/provider-fixes-20260908/transport-after.jsonl`。
模拟后端测试不代表真实模型吞吐，也不覆盖公网链路。

610 秒公网 504 **未宣布修复**：本机记录的约 610 秒 499 与外层关闭连接相容，
但无法仅凭该记录确定关闭方。本机模型超时默认 3600 秒、网关 1800 秒，公网入口实际设置未核查。
本次不提供成功率、P95/P99、故障恢复时间或滚动更新的未经实测 SLA。
服务没有独立 Status Page、余额/账单查询接口或持久幂等结果缓存；不能将这些能力描述为已经提供。

完整限额、Schema 子集和错误行为见 [INFERENCE_API.md](INFERENCE_API.md)。

## 部署核验与后台任务

- 类型检查、31 个相关回归测试、diff 空白检查均通过。
- 已安装单文件网关 SHA256：`437c10fb999e4a17ebeb1b14d8bceb21d42321ff5134681cf23125e6b807ef46`。
- 更新前 bundle 备份保留于私有状态目录 `backup-provider-20260908`。
- 24 小时真实模型验收已启动等待器，初始状态为 waiting_for_idle；当前用户请求未被中断。
  计时从模型空闲后真正开始负载时计算；不能把等待时间算入24小时。
- 后台跟进自动化名称为“本机 Qwen 长请求验收”，每小时读取结果，仅在异常或完成时通知。
- launchd ExitTimeOut=1810 已加入配置生成器，但检测到用户活跃请求后未重载当前 launchd 配置；
  该生命周期设置要在下一次空闲维护安装时生效。已部署代码的 SIGTERM 等待逻辑不能替代 launchd 的退出期限。
