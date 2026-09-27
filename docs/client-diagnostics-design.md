# Kraki Diag — 客户端诊断设计与实施交接

更新：2026-09-27。用户追加授权：**做到客户端发布 + 云端 REST 实际运行，不替用户安装/更新**。
发布工作树：`kraki-client-diagnostics-release`，基于最新 main，保留现有客户端登录/数据。

## 当前代码归属：独立 `@kraki/monitor`

诊断日志 REST 采集器现位于 [`packages/monitor`](../packages/monitor/README.md)，不再属于 Head package。
它独立构建/启动/测试/部署，零运行时 npm 依赖；仅通过只读 SQLite adapter 查询注册设备公钥验签。
Head 不再内嵌 collector，误发到 Head 的诊断路径返回 404。公网 `/api/diag/v1/*`、签名协议、
`kraki-diag` 服务名、loopback:4011、环境变量与日志存储路径均保持不变。
部署入口为 `packages/monitor/scripts/deploy.sh`，旧 `scripts/diag/deploy-sidecar.sh` 仅做兼容转发。
本次重构仅本地修改与验证，**没有部署、重启 Head/collector 或更新用户 App**。
下文第一阶段进度/性能数字是历史时点记录；不代表本轮重新授权部署或最新上传调度参数。

## 发布增补（历史发布记录，优先于下文最初分阶段计划）

- 本次使用显式 `DiagnosticsDelivery` 配置：Release 优化 + `KRAKI_DIAG KRAKI_DIAG_EXISTING_IDENTITY`。
  它保留生产 bundle/keychain/defaults/outbox 身份，沿现有 TestFlight / Sparkle 通道发布；
  普通 Release 仍不含日志采集代码，独立 `.diag` 身份的 Diagnostics 配置也保留。
- iOS 仅 workflow_dispatch 的 `diagnostics=true` 开启；Mac 仅显式 `mac-v…-diag` tag 开启。
  用 `verify-diagnostic-delivery.sh` 验证日志/toggle/现有身份；普通发布仍用 `verify-no-diag.sh`。
- 本次目标版本：iOS 0.1.8（构建号由 TestFlight workflow 分配），Mac 0.2.40 (42)。
- 设置有“记录并发送诊断日志”toggle（诊断版默认开）、最近上传时间、待上传量、人工异常标记按钮。
- 追加 `ui.busy`（前台 runloop 完成的 ≥50ms busy interval，排除 sleeping；不是 watchdog 栈）、
  `list.snapshot`（数量/seq bounds/pending 变化）、`session.view`、跨平台 `voice.action` 元数据。
- REST 部署为 **独立服务**（当前入口 `packages/monitor/src/cli.ts`），Node 24 内置 SQLite 只读连接 Head 的 devices 表；
  通过原域名的 `/api/diag/v1/*` 反向代理转发到 loopback:4011，不升级/重启 Head/Pulse。
- 重型黑匣子、自动渲染异常判定和完整真机 A/B 继续迭代，不再作为这次中间版发布的前置门槛；
  仍不声称已有整机 CPU/网络延迟百分比。发布和线上验收结果另存 release verification 文档。
- 操作权限不包括启动/安装/替换用户正在用的 App，用户自己稍后更新。


## 1. 目的与证据边界

- 查清重复答题的第二个新 `clientId` 从哪里生成，而不是用闸门掩盖问题。
- 定位 iOS/macOS 的卡顿、消息处理延迟和气泡渲染问题。
- 不改变按钮、消息投递、过期 answerTo、outbox、Pulse 的业务语义。

现场已确认持久化了不同 clientId 的两条同文消息；普通重传复用 ID，不能解释该现象。
但第二次调用来源、原始 answerTo、出问题端/安装构建仍没有直接证据。
**不能把“回调必然被调用两次”或“Mac 忙导致双击”写成已证实根因。**

现有 `KLog.diag/chat/chatEntry` 中有 release-safe 日志，并非正式包完全没有日志；
真正缺口是结构化关联、持久采集、远程收集以及常用路径的性能观测。

## 2. 对早期草案的修正（本文件取代旧方案）

1. Head 的 AccountApi Bearer 是**服务间密钥**，不是 App access token。绝不把它给客户端。
2. 不加 `simultaneousGesture` / 私有 `_onButtonGesture`：诊断不能改变待调查的点击分发。
3. 不做未经验证的 lock-free MPSC、后台挂起主线程抓栈或常驻满速 DisplayLink。
4. 不上传正文的 SHA1/短 hash：选择题/短文本可以字典反推。只记字节数和现成关联 ID。
5. REST 避免的是 Pulse 应用层排队/重放，**不能保证与 WebSocket 在物理链路上零竞争**。
6. 之前 <0.5% CPU、每天 <20 MB 等估算不是实测结论；20 MB 现在是硬限制，而非预测。
7. `ix` 只显式沿同步调用传递，不把“500ms 内最近一次用户操作”冒充布局的因果来源。
8. 普通 iOS 版本号保留合法数字格式；通过 bundle ID、显示名、Dev 图标区分，不用 `-diag` 版本后缀。
9. 暂不使用后台 URLSession：第一版前台低优先级传输，挂起后靠下次打开续传；不承诺退出后立即到达。
10. 不原样上传 MetricKit（可能含路径等），将来只提取审核过的字段。

## 3. 第一阶段实现状态

### 已实现的路径

- `packages/arm/ios/Kraki/Core/Diagnostics/DiagRecorder.swift`
  - 1024 条有界队列，`NSLock.try()`；争用丢弃，不等待 UI。
  - 单进程序号和 monotonic 时间；按秒最多 200 条。
  - 工作者做 JSON/gzip/文件 IO；单文件 ≤16 KiB 压缩、≤48 KiB 未压缩。
  - 原子完整批次文件，最多 50 MiB / 2048 个文件，最老先淘汰；排除备份，私有权限。
- `.../Diagnostics/KrakiDiag.swift`
  - utility queue、15 秒周期落盘；答题/回执/outbox 等关键事件合并为约250ms后本地落盘，不因此立即上传。
  - 任意时刻最多一个待执行的关键事件 flush；一条独立 HTTP task。强杀/断电仍可能丢最后尚未写出的事件，不承诺零丢失。
  - 常规成功后至少 60 秒再上传；答题活动后延后 10 秒；失败指数退避至 1 小时并加 jitter。
  - 禁用蜂窝/昂贵/受限网络，低电量或 serious/critical thermal 时暂停发起传输。
  - HTTP 压缩请求体尝试量最多 20 MiB/UTC 日，跨重启保存计数；失败尝试也计入。
  - 本地开关关闭取消 task、丢弃内存和未发送文件。已在网络上的字节无法撤回。
  - 切换设备/relay 清除旧 realm，绝不把另一个登录身份的批次传给新身份。
- `packages/monitor/src/diag-api.ts`
  - 独立签名鉴权、schema allowlist、大小/速率/配额/并发限制、幂等文件存储、14 天保留。
  - 无 `KRAKI_DIAG_DIR` 时返回 410，不操作诊断目录。
- 编译配置、设置页开关、发布二进制守卫。
- 输入链、outbox、回执、生命周期、Mac 点击来源和基础慢路径计时。
- 离线查看工具 `scripts/diag/timeline.py`。

### 明确还没完成

全量渲染状态变化/异常检测、帧与 runloop 监测、黑匣子窗口、完整语音/附件/Steps/推送链、
完整 diagnostics UI 健康页、真机 A/B、电量/内存测试、生产服务部署和签名分发。
**不能把第一阶段描述成完整方案已经交付或可以立即分发。**

## 4. 编译隔离与身份

`packages/arm/ios/project.yml`：

| 配置 | 类型/条件 | 身份 |
|---|---|---|
| Debug | 原有 debug，不含 KRAKI_DIAG | 原有 Dev 身份 |
| Release | 原有 release，不含 KRAKI_DIAG | 原有正式身份 |
| Diagnostics | release 优化，仅此配置定义 KRAKI_DIAG | iOS `chat.kraki.ios.diag`；Mac `chat.kraki.mac.diag` |

Scheme：`KrakiDiag`、`KrakiMacDiag`。显示名 Kraki Diag，使用现有 DevAppIcon。
所有采集类型/调用点均在 `#if KRAKI_DIAG` 内。
诊断身份使用独立 Keychain tag、Defaults、消息 DB、附件缓存和 outbox。
iOS NSE 使用 `group.chat.kraki.ios.diag` 和独立 keychain entitlement。
Mac 的正常 Sparkle 更新已有 bundle identity 限制，不会给 Diag 安装生产更新。
Mac 的窗口尺寸/缩放配置仍按原约定跨 Prod/Dev 共用，不能称“所有 UI 偏好完全隔离”。

`bash scripts/diag/verify-no-diag.sh <Production.app>` 检查宿主/NSE bundle ID 和 live-code 字符串。
已接到 iOS TestFlight / macOS release 的签名或导出前步骤。
这是与实际 Release 编译测试配合的防线，不声称一次 strings 检查能证明任意未来实现零泄漏。

**分发前需注册新的 Apple App ID/App Group 和 provisioning profile，且核对诊断 APNs topic。**
本轮无证书/provisioning/商店修改；本地无签名 build 通过不等于真机已安装。

## 5. REST 协议与安全

### 路由

- `GET /api/diag/v1/config`
- `POST /api/diag/v1/batch`：`Content-Type: application/json`，`Content-Encoding: gzip`

由反向代理直接转发到独立 `@kraki/monitor` 进程，不进入 Head 的 AccountApi service-key gate。
Head 本身不再提供这些 REST 路由；旧内嵌部署需要先迁移代理，否则返回 404。
没有新增 Pulse 消息、stream、ACK 或 Tentacle handler。

### 签名

App 使用已成功登录的设备 signing key。签名只在 utility queue 上生成，不写入诊断文件。
请求头：

```
X-Kraki-Device: <deviceId>
X-Kraki-Time: <13位 UTC 毫秒>
X-Kraki-Request: <UUID；POST 是 batchId，重试不变>
X-Kraki-Signature: <Base64 RSA PKCS1 v1.5 SHA256 signature>
```

签名字节是 UTF-8（换行连接，无末尾换行）：

```
kraki-diag-v1
<METHOD>
/api/diag/v1/<config|batch>
<deviceId>
<timestamp>
<request UUID>
<SHA256(压缩请求体) 的小写 hex；GET 使用空体>
```

Monitor 用只读 SQLite adapter 查询已注册/镜像的 app-role device 公钥验签，时间容差 ±5 分钟。
仅读取 `devices(id, user_id, role, public_key)`；不导入 Head 的 Storage 类型，不读会话消息，不创建/迁移/写入 Head DB。
它是只写诊断能力，不是通用 HTTP 登录；不使用 OAuth、服务 Bearer、message E2E key。
TLS 必需；仅显式 loopback 的本地测试允许 HTTP。客户端不跟随重定向，不发 cookies。
公网部署必须有 TLS、入口限流、专用数据目录/磁盘告警；数据是 HTTPS 保护的元数据，
**不是 E2E 加密**，收集端能读取。没有公开日志下载 API，分析用受控服务器文件访问。

### 输入约束和存储

- 压缩 ≤64 KiB，解压 ≤256 KiB，≤1000 events/batch，schema 1。
- 事件名/字段名 allowlist；数字/布尔/ID/固定 tag 格式检查，未知字段整批拒绝。
- 无通用字符串 log、正文、选择文字、草稿、转写、URL、附件或原始 NSError。
- 最多 2 个并发处理；IP 120/min、device 30/min；读取请求体最多 10 秒。
- 每设备每天 20 MiB 压缩、2048 文件；保留 14 天，启动/每小时清理，包括不活跃设备。
- 目录在每设备/天冷启动计量，后续缓存配额，不在每个请求扫描全部历史。
- 磁盘剩余 <1 GiB 返回 507，避免日志耗尽 relay DB 的空间。仍需部署级总磁盘配额/告警。
- 路径：`$KRAKI_DIAG_DIR/<SHA256(userId + LF + deviceId)>/<batchId>.json.gz`。
- 同 ID 同字节重试返回 204；同 ID 不同字节返回 409。跨重启/日期仍幂等。
- 写临时文件后 rename，再返回 204；客户端仅在成功后删除该批次。
- 一个 Monitor 实例独占一个目录；多副本共享目录的分布式配额/写入协调**不在 v1 范围**。

操作员 kill switch：`touch "$KRAKI_DIAG_DIR/DISABLED"`；新 POST 410，GET 返回 enabled=false。
不需重启 relay。客户端前台约每 15 分钟拉一次配置，收到关闭后清缓存/停止采集（首次认证后的请求更早）。
移除该文件可恢复。鉴权失败/端点不存在也停止上传；稍后 config 或重新认证可恢复。
仅在用户本地开关打开时轮询。

## 6. 事件格式与关联

批次（gzip JSON，**不是早期草案的 NDJSON**）：

```
{ schema: 1, batchId, processId, platform, version, build,
  image: { uuid, base, os, arch },
  events: [{ t, m, seq, ev, sid?, d: {...} }] }
```

- `t` UTC epoch ms，用于人工对照；`m` 同设备 monotonic ms，用于进程内间隔。
- `processId` 每次启动 UUID，`seq` 单进程递增。不同进程/设备的 monotonic 值不能相减。
- `image.uuid/base/arch` 对应主可执行文件的 Mach-O UUID/加载地址，保存匹配 dSYM 才能还原调用栈。
- 每批含完整身份元数据，不依赖先收到 launch；批次乱序到达不丢关联。
- `ix` 只在现有同步答题 UI 回调里建立并传到 `cmd.answer/cmd.input`。
- 异步 handoff、echo、restore、retry 用真实 `clientId` 连接；没有“最近一个 ix”猜测。
- `cmd.answer` 和 `cmd.handoff` 的栈是**当前线程**最多 12 个返回地址，不是正文或主线程远程采样。
- sessionId/clientId/questionId 是可关联的元数据，不是完全匿名数据；不记录姓名/设备名/登录名。

### 当前可用事件

| 事件 | 观测点/用途 |
|---|---|
| `ui.mouse` | 既有 Mac NSEvent 监视器捕获的 down/up：questionId、eventNumber、clickCount |
| `ui.answer` | iOS/Mac 高层回调；Mac monitor 派发和 SwiftUI Button 分别标来源；不要把不同层级的多条日志当重复提交 |
| `cmd.answer` | questionId、字节数、pending 数、是否出现过同问题调用、栈。duplicate 是诊断提示，**不阻断**提交 |
| `cmd.input` | sendInput/stageInput 刚创建的新 ID、answerTo、字节数、附件个数、显式 ix；source 区分语音 stage |
| `cmd.handoff` | 所有 send_input（含 retry/staged）的 AppState 交接结果、原始 answerTo、ID、调用栈；accepted 不代表服务端确认 |
| `cmd.result` | 新 sendInput 的本地结果 |
| `outbox.state` | created/restored/retry/cleared/sending/unconfirmed/failed/correcting |
| `echo.input` | authoritative user_message 的 seq、clientId、answerTo、清理前是否命中本地 outbox |
| `app.launch/phase` | 启动、认证、active/inactive/background/logout；后台时 outbox 数 |
| `ws.state` | 原有连接状态回调、重连次数 |
| `work.slow` | ≥8ms 的 iOS list sync/cell configure、Mac list update/cell configure、MessageProvider ingest |
| `diag.health/upload` | 有界队列/速率丢弃计数、失败上传的状态/字节数；成功上传不自我生成永久日志循环 |

`work.slow` 是**局部 inclusive span**，嵌套耗时不能相加；Mac cell 目前仅有 seq、无 sessionId，
不能用跨会话 seq 单独关联。它不是 frame hitch，也不是所有函数的 p95。
iOS 尚未观察 raw UITouch；不能依据“无 gesture 日志”推断设备没有第二次触摸。
锁争用丢弃目前没有单独计数；队列/速率丢弃有计数和 seq 缺口。日志缺失不是事件未发生的证明。

## 7. 后续完整观测目录（待实施，不可直接照旧草案复制）

1. **列表与气泡**：mutation/generation ID、稳定 item key、分页请求 ID、window bounds、前后数量、
   reload/tail/live/stage 分支、pin/drag/decelerating、anchor 与程序性 offset 修正。
   只在真正完成 layout 后比较测量/实际高度，区别估算、合法折叠、虚拟化和异常。
   检测 pending/echo 以 clientId 为准；不能按文本去重，也不能把失败 pending 在底部直接判成 bug。
2. **慢帧/长任务**：仅 active 且有动画/交互需求时看实际刷新预算，过滤 ProMotion 降频/睡眠/后台。
   runloop 区分 waiting 与 busy，不能把主线程正常空闲当 hang。先做 scoped work 关联，
   禁止用观察器结束时的栈冒充“卡住时的栈”，禁止未验证的 thread suspend/backtrace。
   MetricKit 作为延迟补充，并非实时检测，平台 availability 和 allowlist 需单测。
3. **数据流**：解密/解码/ingest/DB/layout 独立 span，缓存命中、batch rows、窗口 trim，
   subscription/history 请求生命周期。跨机器 envelope timestamp 只能算带时钟误差的近似，
   RTT 用同进程 request→ack；Pulse ACK 与服务端持久化/渲染确认分开。
4. **导航/恢复**：session 切换 generation、冷/热开页 DB/远端/首布局/首 pin，
   app 被杀不能总观测到：上次未正常退出只能是诊断线索，不等同 crash。
5. **语音**：operation ID、录音/toDraft/staged/dispatched/cancelled、lease 可用性、
   correction original/corrected 字节数、延迟和结果；禁止 transcript/audio/lease token。
6. **Steps/附件/artifact/推送**：request ID、缓存/拉取/解码耗时、大小、chunk 数、
   UI 展示完成、推送是否导致导航/抑制、读标记。不要记录附件 URL、名字、完整 ref 或通知正文。
7. **人工“刚才有问题”标记**：在设置页/菜单提供按钮，保存 event marker 和不含文本的可见 cell
   ID/几何。自动截屏/AX 文本 dump 禁止；截图必须另行明确授权。
8. **诊断健康**：持久显示最后成功上传、缓存/淘汰/丢弃数、远端开关状态、当前采样策略。
   磁盘失败单独计数但不递归制造洪水。

黑匣子后续再做：有界内存保存异常前约 2 秒和后约 5 秒，事件共享 process/seq 去重，
有触发冷却/日配额，不临时解除所有预算。**异常立即保存本地，不立即抢网上传。**
“200/s 上限”和“无界 unsampled 黑匣子”不可同时承诺。

## 8. 验证与验收

### 已有测试入口

```
pnpm test:monitor  # API + readonly WAL integration + isolated built runtime
pnpm --filter @kraki/monitor typecheck
bash scripts/diag/run-native-tests.sh
pnpm exec tsx scripts/diag/local-e2e.ts  # macOS，真实 Swift RSA/URLSession → 独立 loopback Monitor
python3 scripts/diag/timeline.py <本地下载目录或单个.gz> --question <id>
bash scripts/diag/verify-no-diag.sh <Release.app>
```

NativeTests 是独立优化构建，使用 URLProtocol mock、临时目录、隔离 Defaults；不启动真实 App，
不读 Keychain/生产会话，不调用模型。覆盖有界队列、并发序号、开关、gzip、文件滚动/恢复、
失败保留、同字节重试、注销停止。Monitor 测试覆盖禁用、验签、大小/隐私 schema、幂等/冲突、
配额、限流、保留、kill switch。

首轮实施验证结果（2026-09-27，拆包前的历史记录，本地，无签名/无发布）：
- `pnpm lint`、Head TypeScript `--noEmit` 通过；Head 全套 **18 文件 / 277 tests** 通过，其中新增 API 测试8项。
- NativeTests 全部通过；真实 loopback E2E 用临时 RSA key、真实 URLSession、真实 collector，首次POST注入503，重试后只落盘1份。
- iOS Simulator arm64 / Mac arm64 的 Diagnostics 和 Release 四组合均 build 成功；最终诊断代码又增量复编两端通过。
- 两个 Release app 通过发布守卫；两个正控（Diag身份、伪装生产metadata的Diag binary）均被拒绝。
- native 单测已接入现有 macOS CI job；本地 E2E脚本另可手动运行。
- 没有执行完整 UI 自动化回归、真机签名安装或 A/B，不把这些项目算通过。

本地基准：100,000 次 record + 每100次 drain，优化 host Swift 构建约 **0.20–0.33 μs/event**。
仅说明 producer 入队开销；不含栈采集、签名、压缩、磁盘、网络，**不能转换成整机 CPU 百分比**。

### 分发前必须补的实测门槛

- 同一实体设备、相同 release 优化场景，Diag off/on A/B：首屏、滚动、streaming、分页、答题、语音。
- 记录 p50/p95/p99 主线程 frame/work，RSS、CPU time、energy、存储写入量与真实压缩流量。
- 注入 RTT/限速/丢包；同时上传日志时测 answer/abort 的额外延迟；目标差值 p95 <10ms 或 <5%，
  属于待验证目标，不是现成保证。达不到则延后到空闲/手动导出。
- 强杀/重开、ACK 丢失、账户切换、服务器禁用、磁盘满、TLS/签名失败、长时间离线和限额跨日。
- Release/Diagnostics 两端都构建；普通发布 guard 必须通过，Diag 必须被同一 guard 拒绝。
- 新诊断 Apple 身份真机安装/登录/推送验证；保存 binary+dSYM+源码 revision 的可追溯清单。

## 9. 部署与退出

用户后续已授权本轮发布/部署，按顶部发布增补执行。使用与 Head 共用的 HTTPS 域名，由反向代理单独路由至 Monitor；只给 Monitor 设置私有 `KRAKI_DIAG_DIR`，
配置磁盘配额/告警/TLS入口限流后再启用；不把部署命令指向生产默认值试跑。
先让一个诊断客户端小流量运行，再扩大采集目录；不一次把所有高频日志打开。

诊断期结束：先禁用 collector/客户端开关，停止分发 Diagnostics，按保留策略删数据。
普通 Release 的编译隔离和 CI guard 长期保留。需要删除已上传数据时，按服务端 owner 目录删除；
客户端关闭不会撤销已成功上传的记录。
