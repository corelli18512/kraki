# 客户端稳定性指标（iOS / Mac）

目的：只靠元数据，看清两个原生客户端里所有会影响用户体验的环节：打开 App、断线、发消息、语音、点开会话，以及崩溃或被系统杀掉。

原则：
- 每个“过程”只在结束时上报**一条汇总**。
- 只记录时长、次数和原因分类标签，不记录消息内容、错误文案或网络名称。
- 计算逻辑在 `StabilityTracker` / `SendTracker` / `VoiceTracker`（`Core/Diagnostics/`）。这些代码总是编译，因此有单元测试覆盖。
- 只有诊断版（`KRAKI_DIAG`）会通过现有的 KrakiDiag → `kraki-diag` Monitor 通道上报；正式版不上报，也不启动网络路径监听。

## 事件

### `ready.summary`：打开 App 到看到最新消息
- **类型（kind）**：`cold` 为进程首次连接；`warm` 为 iOS 从后台回来；`wake` 为 Mac 睡眠唤醒。
- **里程碑**：从 App 可见开始计时（毫秒）。
  - `firstContentMs`：看到内容，可能是旧的
  - `wsOpenMs`：连接建立
  - `authedMs`：认证完成
  - `listFreshMs`：会话列表更新
  - `viewCurrentMs`：当前会话已追平；如果在会话列表页，就是列表已更新
- **其他字段**：
  - `attempt`：失败重试次数
  - `gap`：打开时当前会话缺几条消息
  - `backgroundMs`：在后台（或睡眠）待了多久
  - `path`：wifi / cellular / wired / other / none
  - `previousExit`：只在 cold 时记录。`unclean` 表示上一个进程在前台时死掉了，可能是崩溃、卡死被系统杀掉或强制退出
- **结果（outcome）**：`ready`；`abandoned`（就绪前离开）；`timeout`（30 s 仍未就绪）。

### `outage.summary`：前台断线
只统计已登录、在前台、且不在“打开过程”中的断线；后台主动断开和睡眠都不算。
- `source`：客户端是怎么发现断线的。取值包括 `peer_closed`（附关闭码）、`transport_error`（附 NSError 码）、`ping_timeout`、`transport_silent`、`receive_failed` 等。
- 时长：
  - `detectMs`：最后一次收到数据 → 发现断线（半开连接时会很长）
  - `reconnectMs`：发现 → 重新认证
  - `catchupMs`：认证 → 追平
  - `impactMs`：最后收到数据 → 追平，即用户实际受影响的时长
  - `visibleMs`：界面真正显示 “Reconnecting” 的时长
- 上下文：
  - `attempt`：重试次数
  - `pathChanged`：断线前 10 s 内网络发生过切换
  - `afterWake`：唤醒后 60 s 内
  - `path`：当前网络类型
- 结果：`recovered`；`backgrounded`（断线期间离开）；`abandoned`（10 分钟仍未恢复）。

### `send.summary`：一条消息从发出到结束
- `kind`：typed / voice / answer / steer
- `outcome`：`delivered`（回显确认）；`deleted`（用户删除）；`cleared`（登出或删除会话）
- `confirmMs`：从创建到确认，跨重启也按原始发送时间计算
- `correctionMs`：语音消息的整理时长
- `shown`：界面上出现过的最坏状态，none / unconfirmed / failed；`shownMs`：显示的总时长
- `cause`：`stalled`（等不到回显）、`correction`（语音整理失败）、`signed_out`、`refused`
- `background`：标记为失败时 App 是否在后台
- `manualRetries` / `autoResends`：手动重试和自动补发的次数
- `restored`：是否跨越了 App 重启
- `offline`：发送时链路是否不通
- `falseAlarm`：由客户端推导，含义是显示过问题、但用户没有手动重试也最终送达了

### `voice.summary`：一次录音
- `outcome`：
  - `final`：拿到结果
  - `failed`
  - `cancelled`
  - `departed`：离开了会话
  - `suspended`：App 进入后台
  - `ended`：其他结束，例如额度在收尾时用完，只保留了原始草稿
- `stage`：结束时所处的阶段，preflight / permission / lease / recording / finishing
- `cause`：失败分类
  - 权限与设备：`permission`、`mic_unavailable`、`audio_session`
  - 服务与网络：`unavailable`、`offline`、`timeout`、`network`、`gateway`
  - 额度与租约：`quota`、`lease_timeout`、`lease_busy`、`lease_rejected`、`lease_denied_<原因>`
  - 其他：`identity_changed`、`config`
- 时长：
  - `startMs`：按下到开始采音，包括权限、租约和连接的等待
  - `recordMs`：录音时长
  - `finalizeMs`：松手到出结果
- 其他：
  - `confirmed`：纠错是否被确认；未确认时保留原文草稿
  - `warm`：按下时连接是否已预热
  - `count`：租约续期（rollover）次数
  - `correctionOn`：这次录音时用户是否开着 Correct Transcripts。关闭时 `confirmed=false` 是预期，不算纠错失败

### `open.summary`：点开一个会话
只在在线、且不处于打开 App 或断线过程中时记录。
- 字段：`firstContentMs`、`viewCurrentMs`、`gap`
- 结果：`current`（已追平）、`left`（中途离开）、`timeout`

## 建议目标（初稿，收一周数据后再定）

| 指标 | p95 目标 |
|---|---|
| warm 看到最新 | < 3 s |
| cold / wake 看到最新 | < 5 s |
| 断线影响 impactMs | < 8 s |
| 前台断线次数 | < 1 次 / 天；2 分钟内 ≥3 次视为风暴，应为 0 |
| 发消息确认 confirmMs | < 5 s |
| 显示过问题的消息 | < 1%，误报应为 0 |
| 语音松手到结果 | < 4 s |
| 语音失败率 | < 2% |
| 点开会话看到最新 | < 1.5 s |

## 查看数据（手动工具，不进 CI）

```bash
python3 scripts/diag/stability-report.py --pull corelli-tecent-cloud-small-0 --out /tmp/stability \
  [--head-log head.log] [--since 2026-10-01] [--platform ios|mac]
```

生成 `/tmp/stability/stability-report.html`，按五个部分汇总，超出目标的数值标红。如果提供了 Head 日志（`journalctl -u kraki-relay`），还会列出服务器侧的重连风暴（2 分钟内 ≥3 次认证）；即使客户端不是诊断版，也能据此判断有没有风暴。

## 发布顺序（重要）

Monitor 按白名单校验：只要一批数据里出现它不认识的事件、字段或取值，就会以 400 拒收**整批**数据，而客户端收到 400 后会直接删掉这批数据。所以：

1. **先部署 Monitor**（`packages/monitor`）。
2. 再发布带这些事件的诊断版客户端。

`packages/monitor/src/__tests__/schema-sync.test.ts` 会解析 Swift 源码，核对事件名、字段、各类取值和自动补发的 `resend_*` 状态是否都在白名单里。它曾发现一个遗漏：#329 引入的 `resend_*` 状态不在白名单里，任何包含自动补发的批次都会被整批丢弃；同一 PR 已修复。
