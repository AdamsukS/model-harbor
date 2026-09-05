# 通用部署与迁移指南

本方案不绑定阿里云：阿里云、其他云厂商或自建公网主机，只要满足相同的 DNS、HTTPS 和 SSH 条件，
都可以承担转发入口。代码不依赖云厂商 SDK、实例 ID、地域名、控制台接口或云账户密钥。
云厂商的区别由部署者在自己的控制台处理，实际值写进本地 `sharing.local.json`。

仅调用别人已部署的模型，请直接看 [API 使用指南](INFERENCE_API.md)。完整英文操作说明见 [SHARING.md](SHARING.md)。

## 支持范围与前提

| 部分 | 已实现 / 需要满足的条件 |
| --- | --- |
| 公网主机 | 能接收 HTTP/HTTPS、运行 OpenSSH 和 Caddy 的 Linux 主机 |
| 服务器自动配置脚本 | 目前面向 Ubuntu/Debian 的 systemd + OpenSSH 布局；其他发行版需要调整用户管理和 SSH 服务名后验证 |
| 本地网关 | Node.js 22、pnpm 11；始终监听本机回环地址 |
| 本地常驻 | macOS 有安装器；Linux 可前台运行，自动常驻需自行接入服务管理器 |
| 推理后端 | 当前验证的是 Ollama 的 OpenAI 兼容接口；更换模型可配置，更换其他后端需验证协议与参数支持 |
| DNS | 你能为完整域名设置记录，不要求在主机所属云厂商管理 DNS |
| 连接 | 本地设备能主动连接公网主机的 SSH 端口，不要求本地有公网 IP |

“云厂商无关”不等于所有系统和后端已自动适配。现有扩展点足够替换地址、模型和部署平台，
无需增加一个只服务于某家云的代码分支。

## 安装顺序

1. **准备本地推理。** 安装并启动 Ollama，确认所选模型已存在。本地只共享推理时不必启动 Agent/Memory。
2. **安装项目并构建。**

   ```bash
   pnpm install --frozen-lockfile
   pnpm exec tsc -p tsconfig.json
   pnpm sharing init
   ```

3. **填写私有配置。** 命令会显示状态目录；编辑其中的 `sharing.local.json`。
   不要修改公共示例来填个人值，也不要把状态目录加入 Git。
4. **生成服务器与隧道配置。** `pnpm sharing render` 只在本地生成文件，不修改 DNS 或连接服务器。
5. **配置 DNS 和服务器。** 为域名添加指向服务器的 A 记录；在服务器执行生成的 `server-setup.sh`，
   把生成的 Caddy 站点加入已有配置，校验后热加载。具体命令见 [SHARING.md](SHARING.md#2-render-and-configure-the-public-server)。
6. **核对 SSH 主机指纹。** 使用原有可信登录方式确认主机；隧道保持严格校验，不跳过证书或主机密钥检查。
7. **启动本地服务。** macOS 使用 `pnpm sharing install-macos`；Linux 使用下方前台命令。
8. **验证并交付。** 测试模型列表、普通响应、流式统计、错误 Key 和重连，再生成协作者接入说明。

本地配置默认在 macOS 的 `~/Library/Application Support/ModelHarbor/inference/`，
或 Linux 的 `~/.local/share/modelharbor/inference/`。可以通过 `INFERENCE_STATE_DIR` 指向其他私有目录。
所有管理命令应使用同一个状态目录。

## 哪些配置可以替换

| 配置 | 变更用途 |
| --- | --- |
| `domain` | 换域名或 DNS 服务；示例只使用 `api.example.com` |
| `sshHost`、`sshPort` | 换公网服务器或 SSH 端口；与云厂商无关 |
| `sshUser` | 专用、无交互会话的隧道账号，不使用 root 常驻 |
| `remoteBind`、`remotePort` | 匹配服务器上原生 / Docker Caddy 的访问路径 |
| `upstream`、`model` | 指向本地推理服务和已安装模型；不要在 URL 内嵌凭据 |
| `port` | 本地鉴权网关端口 |
| `maxTokens` | 请求输出上限；与模型上下文容量不是同一参数 |
| `timeoutSeconds` | 排队加生成的服务端时限；长输出默认 1800 秒 |
| `sshInterface` | 默认留空；仅在 macOS 需要绑定特定网卡时填写实际接口名，不把 `en1` 当通用默认值 |

改配置后重新 `render`。涉及服务运行参数时重装 / 重载对应服务；涉及服务器监听策略时同步更新服务器配置。
重新渲染不会自动轮换 API Key。

## 网络边界

| 端口 / 方向 | 用途 |
| --- | --- |
| 公网 TCP 443 → Caddy | 协作者 HTTPS 请求 |
| 公网 TCP 80 → Caddy | 默认 HTTPS 配置的 HTTP 重定向及可能使用的 ACME 验证路径 |
| 本地设备 → 公网 SSH 端口 | 主动建立反向隧道；SSH 端口可配置 |
| 服务器回环或私有网桥 → 隧道监听端口 | Caddy 的内部转发目标，不对公网开放 |
| 本地回环网关 → 本地推理端口 | 保留在本地设备上的服务链路 |

在不同厂商控制台中，入站控制可能叫安全组、防火墙或网络规则；采用相同的最小端口需求即可。
不要为了接通服务而把本地 Ollama、Agent、Memory 端口直接公开。
本方案的生成器不管理云防火墙，也不代替系统防火墙配置。

### 原生 Caddy 与 Docker Caddy

- Caddy 直接运行在服务器上：`remoteBind` 使用 `127.0.0.1`。
- Caddy 运行在 Docker 网络内：容器里的 `127.0.0.1` 是容器自己，需要填该网络的私有网桥网关地址。
  可以用 `docker network inspect <你的网络名>` 查询，不能直接照抄其他人的网段。
- SSH 账号只允许绑定配置的监听地址与端口；鉴权仍在本地执行。
- 不要覆盖已有网站的 Caddyfile；合并新站点并保存本地备份，验证后热加载。

## Linux 前台运行

先保持 Ollama 可用，再在两个终端分别运行：

```bash
export INFERENCE_STATE_DIR="$HOME/.local/share/modelharbor/inference"
pnpm start:inference
```

```bash
export INFERENCE_STATE_DIR="$HOME/.local/share/modelharbor/inference"
ssh -F "$INFERENCE_STATE_DIR/ssh.conf" -NT modelharbor-api-tunnel
```

长期运行时，将上述命令交给目标系统已有的服务管理器，并配置重启与日志策略。
macOS 安装器只管理共享入口和隧道，不保证设备解锁 / 登录之前可用，也不接管已有 Ollama 进程。

## 验证与交付

使用合成提示词验证，不把真实业务数据作为公开测试记录：

1. 域名正确解析，HTTPS 证书有效；原有站点仍可访问。
2. 不带或带错误 Key 时返回 401；有效 Key 可以查询模型。
3. 普通生成有 `choices`、后端 `usage` 和 `inference` 元数据。
4. 流式输出持续到达，最后有用量块和 `[DONE]`；客户端能处理空 choices。
5. 重启专用隧道后恢复连接；撤销某 Key 后，其新请求被拒绝。

生成一份带本实例地址的接入说明：

```bash
pnpm sharing handoff
```

输出 `client-guide.local.md` 保存在私有状态目录，包含 API URL、模型和输出上限，不包含 Key、服务器 IP、
SSH 账号、内部网桥或日志。它可以私下发给本服务的协作者；每人的 Key 另行交付。
源模板 [CLIENT_HANDOFF.md](templates/CLIENT_HANDOFF.md) 则只含占位符，可以公开复用。

## 迁移到另一家云 / 另一台主机

1. 在新主机确认操作系统、OpenSSH、Caddy 和网络条件，保留旧主机服务直到验证完成。
2. 修改私有配置的 `sshHost`、端口、私有网桥等字段，重新渲染；把服务器脚本只交给新主机。
3. 配置新主机的隧道账号和 Caddy，核对新主机指纹，再切换本地隧道。
4. 更新 DNS；验证 HTTPS、鉴权和实际生成。切换隧道到 DNS 生效期间可能短暂中断，应安排维护时间。
5. 重新生成接入说明；核实新路径稳定后，再停用旧主机的专用账号 / 转发配置。

私有状态目录留在本地，通常不需要为了换服务器而更换协作者 Key。
证书续期、DNS 缓存时间及云端访问规则由各自部署环境决定，不在代码里写死地域、账号或实例配置。

## 故障定位

| 现象 | 检查方向 |
| --- | --- |
| SSH 未到密码阶段就断开 | 对照实际主机地址、服务端 SSH 日志、本机 TUN / 代理路由；端口可连接不等于握手成功 |
| 主机密钥校验失败 | 通过可信渠道核对指纹；不关闭 `StrictHostKeyChecking` |
| 502 / 503 | 本地网关与 Ollama 是否在线、隧道是否连接、Caddy 能否访问私有监听地址 |
| 模型列表成功但生成失败 | 检查 Ollama 模型是否存在与当前资源，模型目录不是健康检查 |
| 返回 429 或等待很久 | 检查单 Key 并发、整体队列和本地其他推理任务 |
| 重启后服务不在线 | 检查设备登录状态、本地服务管理器和模型服务；不要只检查公网主机 |

处理故障时，真实配置、日志和私有数据仍留在本地。发布 Issue 时只提供脱敏信息及最小复现。
