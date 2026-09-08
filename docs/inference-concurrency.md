# M4 / 16GB 推理并发实验（2026-09-06）

## 结论

当前 Ollama 0.33.2 对 `qwen35` 架构强制使用一个推理槽位。
实际把 `OLLAMA_NUM_PARALLEL` 设为 2 并重启后，日志仍显示 `-np 1`，吞吐没有提升。
这项限制可在[对应版本源码](https://github.com/ollama/ollama/blob/v0.33.2/server/sched.go)中核对。

同机、同一份 GGUF 权重，使用已安装的 llama.cpp b10630-d222767c7 可以创建两个
独立的 128K 槽位，并取得实际并发收益。后续上限实验与常驻部署见本文最后一节。
本次实验不构成全量模型能力评测，也不保证所有客户端和长上下文工作负载均兼容。

## 配置与方法

- Apple M4，16 GiB；Qwen3.5 9B Q4_K_M；K/V cache 为 q4_0。
- 两路的总上下文容量为 262144，每个槽位仍为 131072；没有把单请求窗口缩短为 64K。
- 复用现有权重与二进制，没有下载或替换模型。
- 可重建的提示缓存限制为 512 MiB，每槽最多 4 个上下文检查点。原配置分别为 8192 MiB 和 32。
- temperature=0、seed=42，thinking 关闭，固定生成 128 tokens。
- 短输入约 40 tokens，较长输入约 2810 tokens；每批四个请求，每种组合两轮。
- 记录完整模型响应、耗时、token usage、内存压力等级与 swapout 计数。

原始文件在 `runtime/diagnostics/concurrency/`。`p1-128k.json` 保留原缓存配置下的
部分测试，因内存压力与 swap 增长而停止；`p2-128k-cache512.json` 保留请求双路但
实际被 Ollama 降为单路的记录。这些记录没有当作成功双路结果。

## 原生 llama.cpp 结果

表中的吞吐为两轮总输出 tokens 除以两轮总耗时，包含提示处理；完成时间是四请求批次的均值。

| 输入 | 客户端串行吞吐 | 双路吞吐 | 吞吐提升 | 四请求耗时：串行 → 双路 |
| --- | ---: | ---: | ---: | ---: |
| 短输入 | 12.52 tokens/s | 17.59 tokens/s | 40.4% | 40.88 → 29.11 秒 |
| 约 2810 tokens | 8.25 tokens/s | 9.18 tokens/s | 11.3% | 62.06 → 55.78 秒 |

较长输入的双路两轮分别为 71.28、40.29 秒，缓存和预填充的影响明显，不应只引用较快的一轮。
并发提高总吞吐，不意味着单个正在生成的请求也更快。

32 次吞吐请求全部完成；随后八次带不同会话代码的槽位复用检查全部返回各自正确代码，
强制工具调用正确生成 `get_weather(city="Paris")`。
这些是功能检查，不是隔离安全性的完整证明或官方 benchmark 得分。

实验最高内存压力等级为 2（warning），未观察到等级 4（critical）；整个原生实验
新增 swapout 约 524.75 MiB。其他桌面应用保持运行，结果代表当时的机器负载。
这一阶段尚未测试四路；后续实测见下文。

## 公网实测

按用户授权，临时将现有网关接到双槽位后端，使用 `collaborator-1` 经原公网地址调用。
固定四个请求，每个输出 64 tokens，SSE，串行和双路各两轮；所有请求成功，并核对了
最终 usage 和 `[DONE]`。

| 客户端并发 | 四请求平均完成时间 | 总吞吐 | 首 token 延迟中位数 |
| --- | ---: | ---: | ---: |
| 1 | 31.02 秒 | 8.25 tokens/s | 2.95 秒 |
| 2 | 17.34 秒 | 14.76 tokens/s | 2.62 秒 |

整批耗时减少 44.1%，总吞吐增加约 78.9%。数据来自本机经公网绕回的短请求实验，
不能替代其他地区客户端的实测。原始记录为 `public.json`。

## 兼容性与部署边界

使用 `--reasoning auto`，由请求的 `reasoning_effort: "none"` 关闭 thinking，保留其他请求
启用 thinking 的能力。直接调用本版 llama.cpp 时，裸 `response_format: {"type":"json_object"}`
可能产生 Markdown 代码块；带显式 object schema 和 JSON Schema 的请求能返回纯 JSON。
网关新增 `backend: "llama.cpp"` 配置，仅在该后端下为裸 JSON 模式补充 object schema；
调用方已提供的 schema 保持不变。原始复现见 `json-format.json`。

通过实际网关再次验证了 thinking 关闭／开启、纯 JSON、六次约 2K 输入的不同会话代码
检查以及工具调用完整往返，全部通过，见 `compat.json`。新增网关兼容逻辑的 13 项相关测试、
配置与启动脚本的 16 项测试以及 TypeScript 检查通过。

试验启动脚本为 `runtime/diagnostics/concurrency/start-llama-two-slot.sh`。对应网关配置为：

```json
{
  "upstream": "http://127.0.0.1:11435",
  "backend": "llama.cpp",
  "concurrency": 2,
  "perKeyConcurrency": 2
}
```

这是一项后端切换，不是 Ollama 原地增加并发。16GB 机器不适合两套进程同时加载该 9B 模型。
常驻部署必须明确公网推理与 Ollama 原生 `/api/chat`、`ollama run` 的运行方式，避免双份模型争用内存。
模型权重、原 Ollama LaunchAgent 和网关配置均保留，可恢复。

## 第一阶段结束时的生产状态

公网已恢复到原 Ollama 后端：有效推理并发 1、每个 key 最多 2 个在途请求。
五分钟超时修复、排队取消释放、512 MiB 提示缓存和 4 个检查点的限制继续生效。
实验 llama.cpp 进程已停止。当时双路方案的常驻切换待明确是否需要保留 Ollama 原生接口，
未将两份模型同时常驻在这台 16GB 设备上。

## 第二阶段：实测上限与常驻部署

用户授权常驻切换后，补测了实际 3、4、6、8 个生成槽位。最终采用：

| API 模型名 | 每请求窗口 | 实际同时生成 | 用途 |
| --- | ---: | ---: | --- |
| `qwen3.5:9b-32k` | 32768 | 3 | 标准版，日常协作任务 |
| `qwen3.5:9b-128k` | 131072 | 2 | 长上下文版，保留原有模型名 |

`local-default` 保持指向原来的 128K 型号，避免改变既有调用语义。
新任务可显式选择 `qwen3.5:9b-32k`；认证 Key、公网地址和 Chat Completions 接口保持不变。
`GET /v1/models` 返回这两个型号和各自的 `context_window`。

网关 `concurrency=8, perKeyConcurrency=8` 表示最多转发／接纳八个在途请求，
并非八个实际生成槽位。超过表中生成槽位的请求在后端等待；总在途超过八个仍返回 429，
每身份每分钟 60 次和服务端总期限 1800 秒保持生效。客户端建议同时提交 2–3 个生成任务。

### 上限实验

所有吞吐均为完整批次的输出 token 总数除以墙钟耗时，包含提示处理。每档两轮，
短输入约 40 tokens、每请求输出 96 tokens、temperature=0、seed=42、thinking 关闭。
本阶段高并发批次的请求数等于客户端并发数，不能拿批次秒数直接与第一阶段四请求批次比较。

原始 Ollama 附带的 llama-server，预留八个 32K 槽位时：

| 客户端实际并发 | 总吞吐 tokens/s |
| ---: | ---: |
| 1 | 12.17 |
| 2 | 19.00 |
| 4 | 16.74 |
| 6 | 17.02 |
| 8 | 16.50 |

这组 42 个吞吐请求、32 次不同会话代码检查和工具调用均完成；最高内存压力为 2，
完整测试新增 swapout 5104 MiB。八路可运行，但不适合这台同时运行桌面应用的 16 GiB 设备常驻。
见 `llama-p8-standard.json`。实际四个 128K 槽位则在客户端串行阶段已经触发等级 4，
四个短请求耗时 129.50 秒、总吞吐 2.97 tokens/s，新增 swapout 7270 MiB，自动停止；
没有完成四路并发测试，不能把该数字称为四路吞吐。见 `llama-p4-upper.json`。

启用路由的同源兼容构建，减少预留槽位后的实测：

| 预留配置 | 客户端并发 | 总吞吐 tokens/s | 完整该配置测试新增 swapout |
| --- | ---: | ---: | ---: |
| 32K × 4 | 1 / 2 / 3 / 4 | 16.32 / 24.08 / 24.76 / 21.07 | 0 MiB |
| 32K × 6 | 6 | 21.87 | 302.75 MiB |
| **32K × 3** | **3** | **24.71** | **0 MiB** |
| **128K × 2** | **2** | **24.17** | **0 MiB** |
| 128K × 3 | 3 | 23.91 | 1796.81 MiB |

每个配置还运行了独立会话代码检查与强制工具调用。最终 32K 三路和 128K 双路的
完整测试最高内存压力均为 1；三路 128K 最高为 2，吞吐没有超过双路。
对应原始记录：`llama-compat-p{3,4,6}-standard.json`、`llama-compat-p{2,3}-long.json`。
不同构建与不同预留内存布局分开报告，不把跨组差异全部归因于并发数。

这些是短请求及功能检查结果，不是 32K／128K 全窗口同时填满的压力保证。
其他应用、提示长度、缓存命中、工具轮次和 thinking 都会影响实际容量。
因此“实测跑通八路”和“推荐同时生成三路”是不同结论；不存在脱离工作负载的绝对并发上限。

### 原生多档路由与构建

使用 llama.cpp 内置 presets 和 `--models-max 1`，只驻留一个模型实例。
两档复用原始 GGUF 权重，但各有真实的上下文容量和槽位数；并非只加模型别名。
换档会等待当前档位的在途请求结束，再卸载和加载，首次请求增加加载等待。
同一批任务尽量选同一档，避免来回切换。

Ollama 0.33.2 的 `llama/server/CMakeLists.txt` 强制 `LLAMA_SUBPROCESS=OFF`，
附带二进制无法使用 router 子进程。官方 b10630 二进制也不能直接使用此 Ollama 模型：
除了 RoPE metadata 长度差异，还需要 tensor 命名与布局兼容层。
实验性的 metadata 副本没有投入生产，原始 GGUF 未修改。

常驻二进制由以下固定来源构建，沿用 Ollama 已有兼容层，将其构建文件中的
`set(LLAMA_SUBPROCESS OFF CACHE BOOL "" FORCE)` 改为 `ON`。另应用
`patches/llama-router-cancel.patch`，使路由请求取消时关闭到模型进程的 HTTP 连接：

- [Ollama v0.33.2 构建配置](https://github.com/ollama/ollama/blob/v0.33.2/llama/server/CMakeLists.txt)，提交 `f96e7aa0513b9973a0ccc71be414c2ecb9d65b1a`。
- [Ollama 模型兼容层说明](https://github.com/ollama/ollama/blob/v0.33.2/llama/compat/README.md)。
- llama.cpp `d222767c7`（b10630），[原生路由实现](https://github.com/ggml-org/llama.cpp/blob/d222767c7/tools/server/server-models.cpp)。
- Release，静态链接，Metal、嵌入 Metal library、GGML_NATIVE 开启，CMake `-j 4` 构建 `llama-server`。

源码下载、构建脚本及日志位于 `runtime/diagnostics/concurrency/native-build/` 和
`prepare-native-build.py`；安装目录的 `native-build.json` 保存源码版本及二进制 SHA-256。
可复用的配置模板是 `config/llama-models.ini.example`，启动脚本是 `scripts/start-llama.sh`。
将 Ollama tar 中的 `llama/`、`cmake/`、`LLAMA_CPP_VERSION` 解包，并提供固定 llama.cpp 源码后：

```sh
git -C /path/to/llama.cpp-d222767c7 apply /path/to/model-harbor/patches/llama-router-cancel.patch
cmake -S /path/to/ollama-0.33.2/llama/server -B /path/to/build \
  -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF \
  -DFETCHCONTENT_SOURCE_DIR_LLAMA_CPP=/path/to/llama.cpp-d222767c7 \
  -DGGML_METAL=ON -DGGML_METAL_EMBED_LIBRARY=ON -DGGML_NATIVE=ON
cmake --build /path/to/build --target llama-server -j 4
python3 scripts/test-native-proxy-cancel.py /path/to/build
```

取消回归测试链接实际构建的原生路由库，使用本机假 HTTP 后端，不加载模型。
它分别让后端不发响应头、发头后不发正文，取消代理并保持测试进程存活，
断言后端连接在1秒内关闭。原版两项均失败，补丁后两项均通过。

`com.codesoul.modelharbor.llama` LaunchAgent 管理常驻原生后端；原 Ollama LaunchAgent
已 bootout 并 disable，防止两套服务同时加载模型。网关与隧道继续使用原 LaunchAgents。
原 Ollama plist、原配置和模型保留在安装目录及 `backup-native-20260906`，可回滚。

### 端到端验证与连接复用修正

新构建下的网关再次通过 thinking 关闭／开启、JSON object、六次约 2K 输入的会话代码
检查和工具调用往返，见 `compat-native-final.json`。这些检查不是官方能力 benchmark。

首次公网四请求批次成功，随后的八请求批次出现一个 502，只有七个请求进入本机网关，
这七个均为 200。原始失败保留在 `public-profiles.json`。复测的四请求、八请求、
混合两档请求全部成功，见 `public-profiles-recheck.json`，监测始终最多一个模型处于
loading/loaded 状态。错误发生在本机网关之前；未取得远端 Caddy 的错误日志，
不能断言这一次 502 的唯一根因。

另确认了连接复用配置不匹配：Node 22 默认空闲连接 5 秒，而生成的 Caddy 配置没有覆盖其
默认 2 分钟上游 keepalive。[Caddy 文档](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy#the-http-transport)
明确说明这类不匹配可能导致 HTTP/1.1 POST 返回 502。网关现将 keepAliveTimeout 设为
185 秒，使 Caddy 先淘汰空闲连接；请求上传限制和 30 分钟推理期限没有改变。
6.1 秒空闲后的连接复用回归测试通过；旧默认值不复用、新配置复用，见 `keepalive.json`。
修改已安装到常驻网关，最终公网复测记录在 `public-profiles-final.json`。

最终公网复测四请求、八请求、混合两档请求共 16 个，全部为 200，SSE 的 `[DONE]`、
最终 usage 和返回模型名均核对通过；没有同时驻留两个模型，见 `public-profiles-final.json`。
网关与队列的 22 项相关测试（含连接空闲复用、模型路由、八请求接纳）、TypeScript 检查通过。
私有 `client-guide.local.md` 已重新生成，列出两个上下文型号和八请求在途限额，不包含 Key。
32K 超限请求返回 400，`local-default` 仍返回 128K 型号并正确完成算术检查；
标准版三个真实槽位、单份模型驻留、三个 LaunchAgents 运行及 Ollama 禁用状态均通过最终检查，
见 `final-health.json`。

### 32K 较长输出补测

同一 `collaborator-1` Key 经公网请求标准版，输入 3167 tokens，实际输出 1024 tokens，
reasoning=none、单请求、无缓存命中。首个内容 token 22.60 秒，完整完成 101.48 秒，
收到完整 usage 与 `[DONE]`，HTTP 200；首 token 后约 12.97 tokens/s。
原始请求与响应记录为 `public-long-32k.json`，不是远端原任务的重放。
该结果仅验证了此输入长度下的 1024-token 持续输出，未验证实际生成 8192／16384 tokens
或长输出三路并发。按这一段速度粗估，8K／16K 输出约需 11／21 分钟，加上输入处理和排队，
实际会随上下文增长和并发变化。长输出先用客户端并发 1，服务端总期限仍为 1800 秒。
32K 是输入、模板、工具描述与输出共用的窗口；单次输出配置上限为 16384，默认只有 1024。
