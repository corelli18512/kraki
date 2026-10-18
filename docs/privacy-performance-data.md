# Performance data: privacy policy text and App Store labels

Public privacy policy: https://app.kraki.chat/privacy/ (source:
`packages/arm/web/public/privacy/index.html`). This file describes the performance
data the iOS, Mac and Windows apps send (Settings →
Privacy → Share Performance Data, on by default). Windows uses the Web client's
`lib/diag` (same wire format, signature and vocabulary; platform `windows`;
the browser Web app sends nothing). Technical reference:
`docs/stability-metrics.md` (events) and `docs/client-diagnostics-design.md`
(transport, limits, collector). Keep them in sync.

What is sent: event names, timings, counts and coarse categories — for example
how long a message took to be confirmed, how long until a reply started, gaps
while a reply streamed, connection drops and reconnect times, voice input
failures by category, how long opening the app or a conversation took, whether
the previous run ended in a crash, and how long the main thread was busy. Each
batch carries the app version and build, OS version, CPU architecture, a random
per-launch id, and opaque ids (device, session, message) that Kraki already
uses to route messages.

How users learn about it: once per install, after sign-in (existing users: on
the first launch of the version that turns it on), a card says what is sent and
offers OK / Don't Share. It waits for the notification permission answer so it
never stacks on that prompt (`PerformanceNotice.swift`). Afterwards it lives in
Settings → Privacy.

What is never sent: message text, drafts, transcripts, voice, attachments,
file names or paths, URLs, error messages, network names.

Where it goes: Kraki's own diagnostics collector on the same servers as the
relay, signed by the device's existing key. Kept 14 days, then deleted.

## Privacy policy — English

> **Performance data.** To find problems and improve the experience, the Kraki apps
> send performance data: timings and counts such as how long a message took to
> be delivered, how long until a reply started, interruptions while a reply was
> arriving, connection drops, voice input errors by category, app start times
> and whether the app previously crashed, together with the app and system
> version. It never includes message text, drafts, voice, attachments, file
> names or links. It is linked to your device and account so we can follow up
> on reports, is stored on Kraki's own servers and deleted after 14 days, and
> is not used for advertising or shared with anyone. You can turn it off at any
> time in Settings → Privacy → Share Performance Data; anything not yet sent is
> then deleted.

## 隐私政策 — 中文

> **性能数据。** 为了发现问题、改进使用体验，Kraki App 会发送性能数据：
> 例如消息多久被确认送达、回复多久开始出现、回复过程中是否卡顿、连接断开和
> 重连的时间、按类别统计的语音输入错误、App 启动耗时以及上次是否异常退出，
> 并附带 App 和系统的版本号。其中绝不包含消息内容、草稿、语音、附件、文件名
> 或链接。这些数据与你的设备和账号关联，便于我们跟进问题；保存在 Kraki 自己
> 的服务器上，14 天后删除，不用于广告，也不提供给任何第三方。你可以随时在
> "设置 → 隐私 → 共享性能数据"中关闭；关闭后尚未发送的数据会被删除。

## Foreground usage counts — publish before the activity-reporting release

This is separate from optional performance diagnostics. Updated authenticated
clients send a content-free foreground heartbeat (not queued/replayed); the relay
records only account + Beijing calendar date, at most once per day. Background
agents/connections do not count. The operational daily tally is not disabled by
**Share Performance Data**. Do not describe that toggle as disabling all account
usage records.

> **Basic usage counts.** To understand how many accounts use Kraki each day, we
> record that your signed-in app was in the foreground on a particular date.
> This record contains your account identifier and the date, not conversations,
> actions or precise foreground times. Daily records are retained for 35 calendar
> days and removed with account deletion. Servers combine these counts using
> keyed pseudonyms so the same account is counted only once across devices and
> regions. This basic account activity tally is separate from optional performance
> diagnostics and is not controlled by Share Performance Data. It is not used for
> advertising or cross-app tracking.

> **基本使用统计。** 为了了解每天有多少账号使用 Kraki，我们记录已登录的 App
> 是否在某一天处于前台；只保留账号标识和日期，不记录对话、操作内容或精确的
> 前台使用时间。每日记录保留 35 个自然日，删除账号时也会删除。不同服务器用
> 带密钥的去标识化标记合并计数，同一账号跨设备、跨地区只计算一次。这项基本
> 账号活跃统计独立于可选的性能诊断，不受“共享性能数据”开关控制，不用于广告
> 或跨 App 跟踪。

Release review: add **Usage Data → Product Interaction**, linked to the user,
Analytics, not tracking, alongside existing account identifiers. Review the actual
store questionnaire and applicable consent/legal obligations before publication;
this engineering description is not a legal compliance determination.

## App Store privacy labels (iOS and Mac)

Add, or confirm, these entries under **Data Linked to You** (linked because
each batch is signed by the registered device):

| Data type | Purpose | Notes |
|---|---|---|
| Diagnostics → Crash Data | App Functionality, Analytics | Only "the previous run ended in the foreground" (no crash log, no stack trace of user data) |
| Diagnostics → Performance Data | App Functionality, Analytics | Timings and counts listed above |
| Diagnostics → Other Diagnostic Data | App Functionality, Analytics | Connection and voice error categories, app/OS version |

Not used for tracking.

The Mac app ships outside the App Store (Sparkle), so only the website privacy
policy applies to it; the iOS labels above are required before the TestFlight
external / App Store build that turns this on.
