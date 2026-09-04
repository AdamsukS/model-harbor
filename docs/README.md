# 文档导航 / Documentation

ModelHarbor 有两个独立入口：本地 Agent / Memory 服务，以及可选的带 Key 鉴权的共享推理服务。
先按自己的使用目的选择文档；同名 `/v1/chat/completions` 在两个入口的能力不同。

| 你要做什么 | 从这里开始 |
| --- | --- |
| 已拿到服务所有者的 URL 和 Key，直接调用模型 | [共享推理 API 使用指南](INFERENCE_API.md) |
| 自己部署一套，或更换服务器 / 云厂商 | [通用部署与迁移指南](DEPLOYMENT.md) |
| 查看安装命令、配置字段、实现细节（English） | [Inference sharing guide](SHARING.md) |
| 在本机运行 Agent、工具和持久化记忆 | [项目快速启动](../README.zh-CN.md#快速启动)、[本地 Agent API](API.md) |
| 排查本地 Agent 的依赖与运行问题 | [运行维护](OPERATIONS.md) |
| 为协作者准备本服务的接入说明 | [交付模板](templates/CLIENT_HANDOFF.md)，或运行 `pnpm sharing handoff` |
| 修改模型适配、网关或工具能力 | [模块与扩展边界](MODULES.md)、[工具与授权](TOOLS.md) |

## 公开内容与私有内容

公开仓库保存代码、占位配置、协议说明、部署步骤和合成测试。
真实域名、服务器地址、账户、SSH 密钥、API Key、生成配置、个人接入说明与运行日志放在本地私有状态目录。
分享自己的服务时，单独发送接入说明，并分别交付每个人的 Key；不要把完整状态目录发给协作者。

示例中的 `api.example.com` 和 `203.0.113.10` 是占位值。阅读公开文档不代表获得任何实例的访问权限。
项目不要求指定云厂商账号，也不读取云厂商访问密钥。

## English entry points

- [Share local inference](SHARING.md): configuration, Caddy, SSH, macOS services, client examples and metadata.
- [Local Agent API](API.md): scope headers, memory, tools and Agent Bench endpoints.
- [Operations](OPERATIONS.md) and [modules](MODULES.md): local lifecycle and implementation boundaries.
- The Chinese [inference API guide](INFERENCE_API.md) is the consumer reference; the
  [deployment guide](DEPLOYMENT.md) explains provider-independent setup and migration.
