# Single Session Subscription + Opaque Multicast 协议提案

**状态：** Protocol / Head / Tentacle / Web 已实现并通过真实 dev-stack 验证；iOS 不在本次范围  
**日期：** 2026-07-15  
**基于版本：** `9848c4822c423763b02ca824cc86a473efd02e5b`（workspace `v0.29.16`，Head `v0.16.5`）  
**范围：** 权威协议与已实现行为；本次实现覆盖 Protocol、Head、Tentacle、Web，不包含 iOS。  
**版本策略：** 不考虑旧 Head、旧 Tentacle 或旧 Arm 的兼容；相关组件按同一协议版本发布。

---

## 1. 最终模型

每个 Arm 在任一时刻最多只观看一个 session。

因此 subscription 不是集合：

```ts
sessionId: string | null
```

含义：

- `string`：当前 Arm 正在观看这个 session；
- `null`：当前 Arm 没有观看任何 session；
- A → B：直接把当前 subscription 从 A 原子替换为 B；
- A → null：离开 session 页面；
- 不支持一次订阅多个 session；
- 不需要 `sessionIds[]`、generation 或 subscription epoch。

核心链路：

```text
Arm --E2E unicast set_session_subscription(B)--> Tentacle

Tentacle:
  currentSessionByArm[armDeviceId] = B

Tentacle --E2E unicast session_subscription_set(B, snapshot)--> Arm

之后：
  session B delta/card
    -> opaque multicast(to: every Arm currently watching B)
    -> Head
    -> each target Arm
```

第一阶段只有以下高频消息受 subscription 过滤：

```text
agent_message_delta
card_action
```

以下消息继续发送给所有在线 Arm：

```text
session_list
user_message
agent_message
active
idle
compacting
session metadata
permission/question preview state
```

TRACE、附件和历史 spine 继续按需 unicast pull。

---

# Part I：Outer relay protocol + Pulse 0.4 streams

## 2. Pulse 0.4 的优先级模型

本提案基于 Pulse `0.4.1` 的 multi-stream transport，不新增业务层 numeric priority 字段。

Kraki 固定使用两条逻辑 stream：

```ts
const STREAM_LIVE = 0;
const STREAM_BULK = 1;
```

| Stream | 语义 | 本提案中的消息 |
|---|---|---|
| `0` live | 高优先级、交互和当前状态 | `session_list`、`set_session_subscription`、`session_subscription_set`、`agent_message_delta`、`card_action`、input/abort/permission/question control |
| `1` bulk | 后台、大响应 | `session_messages_*_batch`、`turn_trace_batch`、`attachment_data` |

Pulse 0.4 的保证：

- 每条 stream 有独立 `epoch/seq/ack/outbox/recvCursor`；
- 同一 stream 内 in-order、exactly-once 或 explicit reset；
- stream 0 的 hole 不阻塞 stream 1，stream 1 的 hole 也不阻塞 stream 0；
- `StreamSet.onTick()` 按较低 stream ID 先返回 transmit effects，因此 live 获得调度优先；
- stream 之间没有全局顺序保证；
- 这不是对已经进入 WebSocket/kernel buffer 的 bulk bytes 做硬抢占。

因此 subscription assure 的控制链必须全部留在 stream 0。历史 spine、TRACE 和 attachment reconcile 位于 stream 1，不能被当成 stream-0 页面进入 barrier 的一部分。

当前 release 的 Head、Tentacle 和 Web 已采用 Pulse 0.4 multi-stream；本协议不考虑兼容，iOS 实现 subscription 时也必须接入相同的 live/bulk `StreamSet`。

## 3. 新增 `MulticastEnvelope`

当前协议：

```ts
export type RelayEnvelope =
  | UnicastEnvelope
  | BroadcastEnvelope;
```

修改为：

```ts
export interface MulticastEnvelope extends PulseFrameField {
  type: 'multicast';

  /** Head 可见的明确目标设备集合。 */
  to: string[];

  /** Pulse 模式下不使用；ciphertext 位于 pulse DATA payload。 */
  blob: string;

  /** Pulse 模式下不使用；recipient keys 位于 pulse DATA payload。 */
  keys: Record<string, string>;

  /** 可选错误关联 ID。 */
  ref?: string;
}

export type RelayEnvelope =
  | UnicastEnvelope
  | MulticastEnvelope
  | BroadcastEnvelope;
```

外层 JSON：

```json
{
  "type": "multicast",
  "to": ["app_phone", "app_web"],
  "pulse": "<base64 Pulse frame>",
  "blob": "",
  "keys": {}
}
```

Pulse DATA payload 内保持现有 E2E 结构：

```json
{
  "blob": "<一份 AES ciphertext>",
  "keys": {
    "app_phone": "<phone wrapped AES key>",
    "app_web": "<web wrapped AES key>"
  }
}
```

因此：

- plaintext 只序列化一次；
- 内容只 AES 加密一次；
- 每个 recipient 只增加一个 wrapped key；
- Head 只根据外层 `to` 转发；
- Head 不看到 `sessionId`、消息类型或内容。

## 4. 三种 envelope 的职责

| Envelope | 目标 | 用途 |
|---|---|---|
| `unicast` | 一个 device ID | Arm command、subscription request/ACK、range、TRACE、attachment |
| `multicast` | 明确的一组 device IDs | subscriber live data、全局 app 控制消息 |
| `broadcast` | Head 动态选择同用户设备 | 不再用于新业务数据面；可在后续删除 |

即使消息要发送给所有在线 Arm，Tentacle 也应先构造明确的 app device target list，再用 multicast，而不是 broadcast。

这会自然解决当前 Tentacle 数据被无效 fanout 到其他 Tentacle 的问题。

## 5. Head multicast 校验

Head 收到 authenticated multicast 后必须：

1. 要求 `pulse` 是字符串；
2. 要求 `to` 是非空数组；
3. 要求每个 target 是非空 device ID；
4. 对 target 去重；
5. 限制 target 数量，例如最多 64；
6. 拒绝 sender 自己；
7. 拒绝 `@head`；
8. 要求所有 target 与 sender 属于同一 user；
9. 第一阶段只允许 `tentacle -> app` multicast；
10. 跳过当前离线 target；
11. 不为离线 target 创建 non-durable backlog；
12. 不解析 Pulse DATA payload；
13. 不比较 outer `to` 与 inner E2E `keys`。

推荐上限：

```text
MAX_MULTICAST_TARGETS = 64
```

如果 Tentacle 的目标数超过 64，应分成多个稳定分组，每组单独构建 ciphertext 和 multicast。

## 6. Multicast 只承载 non-durable live/control data

第一阶段 multicast 用于：

```text
agent_message_delta
card_action
session_list
user_message / agent_message live notification
active / idle / compacting
session metadata
```

这些数据都有独立恢复权威，因此 multicast DATA 必须：

```text
durable = false
```

离线 Arm 不积累 multicast live backlog，而是在 reconnect 后通过：

```text
session_list
subscription snapshot
spine range sync
TRACE pull
```

恢复。

建议为 Head 增加可选 machine-readable error code：

```ts
export type ServerErrorCode =
  | 'multicast_invalid_targets'
  | 'multicast_too_many_targets'
  | 'multicast_target_forbidden'
  | 'multicast_durable_not_supported'
  | 'push_dispatch_forbidden';

export interface ServerErrorMessage {
  type: 'server_error';
  message: string;
  code?: ServerErrorCode;
  ref?: string;
}
```

---

## 7. Pulse routing target 必须绑定 `(streamId, DATA seq)`

Pulse 0.4 的 live 和 bulk 有独立 seq space；两条 stream 都可能同时存在 `seq = 1`。因此只按 seq 保存 target 会发生碰撞。

当前 Tentacle Pulse 0.4 实现已经用 per-stream target map 修复了旧 unicast repair 丢 target 的问题。Multicast 必须扩展同一个抽象：

```ts
export type DeliveryTarget =
  | { kind: 'unicast'; deviceId: string }
  | { kind: 'multicast'; deviceIds: string[] }
  | { kind: 'broadcast' };

private targetByStream = new Map<
  number,
  Map<bigint, DeliveryTarget>
>();
```

发送：

```ts
const { seq, effects } = streams.send(streamId, payload, options);
let targets = targetByStream.get(streamId);
if (!targets) {
  targets = new Map();
  targetByStream.set(streamId, targets);
}
targets.set(seq, target);
run(effects);
```

每次 transmit，包括 repair/resend：

```ts
const decoded = decodeFrameWithStream(effect.bytes);
const target = decoded?.frame.t === 'data'
  ? targetByStream.get(decoded.streamId)?.get(decoded.frame.seq)
  : undefined;
```

ACK 后清理：

```ts
const targets = targetByStream.get(effect.streamId ?? STREAM_LIVE);
for (const seq of targets?.keys() ?? []) {
  if (seq <= effect.seqUpTo) targets?.delete(seq);
}
```

这保证 unicast 和 multicast 在两条 stream 上的 repair 都保留正确目标。

### 7.1 Head 不保存第二份 route registry

验证 Pulse 0.4 的 hole/repair 行为后，Head 不需要维护独立的：

```text
(sourceDeviceId, streamId, seq) -> route
```

当 source stream 收到乱序 DATA 时，Pulse 不会把后一个 payload 缓存在应用层并在前一个 frame 到达时一起 deliver；它会显式要求 repair。缺失 DATA 的 resend 是一个新的、独立的 `transmit` effect。

因此 sender 的职责是：每次原始发送或 repair/resend 都根据 `(streamId, seq)` 重新生成带正确 target 的 outer envelope。

Head 对当前 envelope 只需：

1. decode `streamId`；
2. 校验当前 outer `to` 或 `to[]`；
3. feed frame to source `StreamSet`；
4. 如果当前 frame产生 `deliver`，使用当前 envelope 的目标；
5. 把 payload forward 到每个 destination 的相同 `streamId`。

这与当前 Pulse 0.4 unicast target-retention 模式一致。Multicast 只需要把 sender 端保存的 target value 从单个 device ID 扩展为 device ID 数组。

Control frame 没有业务 target；其 envelope 不参与 DATA delivery。

---

## 8. Push 独立于 live multicast

当前 `pushPreview` 附着在 broadcast live envelope 上。如果没有在线 recipient，Tentacle 会在生成 preview 之前返回，导致全离线时没有 push。

Subscription 后必须把 push 拆成独立 Head-bound operation。

复用现有：

```ts
HEAD_PULSE_TARGET = '@head'
```

新增 Head-terminated control message：

```ts
export interface DispatchPushMessage {
  type: 'dispatch_push';
  payload: {
    preview: BlobPayload;
  };
}
```

Tentacle 发送 outer unicast：

```json
{
  "type": "unicast",
  "to": "@head",
  "pulse": "<包含 dispatch_push JSON 的 Pulse frame>",
  "blob": "",
  "keys": {}
}
```

Head self-channel 看到：

```json
{
  "type": "dispatch_push",
  "payload": {
    "preview": {
      "blob": "<encrypted preview>",
      "keys": {
        "app_phone": "<wrapped key>",
        "app_web": "<wrapped key>"
      }
    }
  }
}
```

Head 规则：

1. sender 必须 authenticated；
2. sender role 必须为 `tentacle`；
3. 只向同 user 的 offline app devices 发 push；
4. target 必须有对应 `preview.keys[deviceId]`；
5. Head 不解密 preview；
6. 是否存在 session subscriber 不影响 push。

---

# Part II：Single session subscription protocol

## 9. 新增 `set_session_subscription`

Arm 到 Tentacle 的 E2E inner message：

```ts
export interface SetSessionSubscriptionMessage extends BaseEnvelope {
  type: 'set_session_subscription';
  payload: {
    /** 当前希望观看的唯一 session；null 表示不观看任何 session。 */
    sessionId: string | null;
  };
}
```

订阅 session A：

```json
{
  "type": "set_session_subscription",
  "deviceId": "app_phone",
  "seq": 901,
  "timestamp": "2026-07-15T10:00:01.000Z",
  "payload": {
    "sessionId": "sess_A"
  }
}
```

取消当前 subscription：

```json
{
  "type": "set_session_subscription",
  "deviceId": "app_phone",
  "seq": 902,
  "timestamp": "2026-07-15T10:01:00.000Z",
  "payload": {
    "sessionId": null
  }
}
```

它通过现有 outer unicast 发往 Tentacle：

```json
{
  "type": "unicast",
  "to": "dev_tentacle",
  "pulse": "<E2E set_session_subscription>",
  "blob": "",
  "keys": {}
}
```

因此 inner message 不需要 `targetDeviceId`。Outer unicast 的 `to` 已经是唯一 routing authority。

## 10. 为什么不需要 generation

Generation 原本用于处理多个 replace-set request 乱序到达。

当前协议已有：

```text
同一个 Arm -> Tentacle Pulse source stream
严格 seq 顺序
in-order deliver
```

产品层又要求：

```text
一个 Arm 同时只有一个 session 页面
subscription transition 必须串行 assure
同一时刻最多一个 subscription request in flight
```

因此不需要第二套 ordering number。

正确约束是：

```text
Arm 不并发发送多个 set_session_subscription
Pulse 负责当前 request 的可靠发送/重传
Arm 不另起应用层并发 retry
首次连接/重连必须等待 post-auth session_list inbound barrier
barrier 前的 subscription ACK 一律不参与页面 assure
barrier 后从当前 desiredSessionId 执行唯一 request
```

如果用户在 ACK 前快速切换页面：

1. Arm 更新本地 `desiredSessionId`；
2. 当前 request 继续等待 ACK；
3. ACK 到达后，如果 ACK session 已不是 desired session，不进入 ready；
4. 立即发送最新 desired session；
5. 中间页面选择可以 coalesce，只发送最终 desired value。

这是一台串行状态机，不是多 generation replicated state。

## 11. Tentacle subscription state

Tentacle 只保存：

```ts
private currentSessionByArm = new Map<DeviceId, SessionId | null>();
```

收到 request 时：

```text
sessionId = string
  -> 校验 session 属于本 Tentacle
  -> 原子替换该 Arm 的旧 subscription

sessionId = null
  -> 删除/置空该 Arm 的 subscription
```

一个 Arm 从 A 切换到 B：

```text
currentSessionByArm[arm] = A
收到 set_session_subscription(B)
currentSessionByArm[arm] = B
```

不需要先发送 unsubscribe A。

设备断开时：

```text
device_left -> currentSessionByArm.delete(deviceId)
```

Tentacle restart 后 map 为空。Arm 在 reconnect/session page assure 中重新发送当前 desired session。

---

## 12. 新增 `session_subscription_set` ACK

### 11.1 Snapshot 类型

```ts
export interface SessionLiveSnapshot {
  /** runtime/sidebar authority */
  digest: SessionDigest;

  /** persistent spine recovery boundary */
  spineHeadSeq: number;

  /** 当前 CardManager state */
  card: {
    draft: string;
    action: CardActionState | null;
  };
}
```

### 11.2 ACK 类型

```ts
export interface SessionSubscriptionSetMessage extends BaseEnvelope {
  type: 'session_subscription_set';
  payload:
    | {
        accepted: true;
        sessionId: string;
        snapshot: SessionLiveSnapshot;
      }
    | {
        accepted: true;
        sessionId: null;
        snapshot: null;
      }
    | {
        accepted: false;
        sessionId: string;
        error: {
          code: 'session_not_found';
          message: string;
        };
      };
}
```

订阅成功：

```json
{
  "type": "session_subscription_set",
  "deviceId": "dev_tentacle",
  "seq": 2204,
  "timestamp": "2026-07-15T10:00:01.020Z",
  "payload": {
    "accepted": true,
    "sessionId": "sess_A",
    "snapshot": {
      "digest": {
        "id": "sess_A",
        "agent": "pi",
        "state": "active",
        "mode": "execute",
        "lastSeq": 42,
        "readSeq": 38,
        "messageCount": 42,
        "createdAt": "2026-07-15T09:00:00.000Z"
      },
      "spineHeadSeq": 42,
      "card": {
        "draft": "I am checking the protocol…",
        "action": {
          "type": "tool_start",
          "payload": {
            "toolName": "read",
            "headline": "Read protocol files"
          }
        }
      }
    }
  }
}
```

取消成功：

```json
{
  "type": "session_subscription_set",
  "deviceId": "dev_tentacle",
  "seq": 2205,
  "timestamp": "2026-07-15T10:01:00.020Z",
  "payload": {
    "accepted": true,
    "sessionId": null,
    "snapshot": null
  }
}
```

### 11.3 失败 ACK

Unknown session 仍然使用专用 ACK，而不是通用 `error`，让页面 subscription assure 只等待一种响应类型：

```json
{
  "type": "session_subscription_set",
  "deviceId": "dev_tentacle",
  "seq": 2206,
  "timestamp": "2026-07-15T10:02:00.020Z",
  "payload": {
    "accepted": false,
    "sessionId": "sess_missing",
    "error": {
      "code": "session_not_found",
      "message": "Session not found"
    }
  }
}
```

失败时：

- Tentacle 不修改该 Arm 的当前 subscription；
- Arm 不进入 liveReady；
- 页面显示加载失败或返回列表；
- 因为同一时刻只有一个 subscription request in flight，不需要额外 request ID、generation 或 ref。

---

# Part III：页面时序 assure

## 13. 同一 Tentacle 内从 A 切换到 B

页面层必须维护：

```ts
interface SessionSubscriptionState {
  desiredSessionId: string | null;
  confirmedSessionId: string | null;
  requestInFlight: boolean;
}
```

切换步骤：

```text
1. 用户从 A 导航到 B
2. desiredSessionId = B
3. confirmedSessionId = null，立刻停止应用 A 的 subscriber-only live frame
4. B 页面进入 subscriptionPending 状态
5. 如果没有 request in flight：发送 set_session_subscription(B)
6. Tentacle 原子 A -> B
7. Tentacle capture B snapshot
8. Tentacle 返回 `accepted: true` 的 unicast session_subscription_set(B, snapshot)
9. Arm 确认 desiredSessionId 仍然是 B
10. apply digest/card snapshot
11. confirmedSessionId = B
12. B 页面进入 liveReady
13. 比较本地 spine head 与 snapshot.spineHeadSeq
14. 如有缺口，在 bulk stream 1 发起 range reconcile
15. range 完成后 spineReady
```

B 页面在第 11 步之前：

- 可以显示 loading/skeleton；
- 不把旧 card state 视为 B 的当前状态；
- 不假设 live stream 已建立。

第 12 步之后：

- 立即应用后续 stream-0 delta/card；
- 可以显示本地持久 spine cache；
- 如果 `spineHeadSeq` 表明存在缺口，单独显示历史 reconcile/loading 状态；
- 不等待 bulk stream 1 才接收 live stream 0。

## 14. 快速 A -> B -> C

如果 B request 已经发送但尚未 ACK，用户又进入 C：

```text
desiredSessionId = C
```

不并发发送 C。

收到 B ACK 后：

```text
ACK.sessionId = B
desiredSessionId = C
```

Arm：

1. 不把 B 设为 liveReady；
2. 可以丢弃 B snapshot；
3. 立即发送 `set_session_subscription(C)`；
4. 等 C ACK；
5. C ACK 后进入 liveReady。

因为 request 串行，A/B/C 同值重复也不会产生 generation ambiguity。

## 15. 离开 session 页面

```text
desiredSessionId = null
send set_session_subscription(null)
```

UI 不需要等待 null ACK 才离开页面，但连接层必须继续完成该 request，之后才能发送下一次 subscription request。

如果用户在 null ACK 前重新打开 B：

```text
desiredSessionId = B
```

等待 null ACK 后再发送 B。

## 16. 跨 Tentacle 切换

如果 A 属于 Tentacle X，B 属于 Tentacle Y：

```text
1. 向 X 发送 set_session_subscription(null)
2. 立即设置 confirmedSessionId = null
3. 等待 X 的 null ACK
4. 向 Y 发送 set_session_subscription(B)
5. 等待 Y 的 B snapshot ACK
6. confirmedSessionId = B
7. B liveReady
```

这样始终保持“一个 Arm 同时只有一个 full live session”的产品不变量。

如果产品未来允许 split view，这个协议需要重新扩展；当前不为未存在的多 session UI 预留数组语义。

## 17. Reconnect

Arm reconnect 后不能只以 `auth_ok` 作为 subscription assure 起点。Head 的 destination Pulse endpoint 可能仍有上一次连接留下的短暂 non-durable frames；如果立即发送新 request，一个旧的 `session_subscription_set` 理论上可能先到达。

因此必须等待本次 Tentacle post-auth 发出的权威 `session_list` 作为 inbound ordering barrier：

```text
1. Pulse/auth ready
2. 收到本次 Tentacle post-auth session_list
   - 它在 Tentacle source stream 中晚于本次 auth 初始化
   - 它在 Arm destination stream 中排在此前残留帧之后
3. 丢弃 barrier 之前收到的任何 session_subscription_set
4. confirmedSessionId = null
5. 如果当前页面仍是 B，desiredSessionId = B
6. send set_session_subscription(B) on stream 0
7. wait matching B snapshot ACK on stream 0
8. apply digest/card snapshot
9. confirmedSessionId = B
10. liveReady
11. 如有 spine gap，通过 stream-0 request / stream-1 response 发起 range reconcile
12. range 完成后 spineReady
```

如果当前没有 session 页面：

```text
在 session_list barrier 后发送 set_session_subscription(null)
```

页面 subscription 状态机只接受 barrier 之后、且本地确有 request in flight、并且 `ACK.sessionId === desiredSessionId` 的 ACK。这样旧连接的无关 ACK 不会完成新页面 assure，也不需要 generation/request ID。

注意 Pulse 的两个方向是独立的：Arm live outbox 中未 ACK 的旧 `set_session_subscription` 可能在 reconnect 后自动重发，并在 `session_list` barrier 之后产生一个新 ACK。它仍然安全，因为命令是幂等的 set-value，而不是一次性 operation：

- ACK session 与当前 desired 不同：忽略，不结束当前 request；
- ACK session 与当前 desired 相同：Tentacle 已在当前时刻重新应用该值并捕获 snapshot，可以接受；
- 后续重复 ACK 在没有 request in flight 时忽略。

`session_list` barrier 只建立 Tentacle→Arm stream-0 的入站边界，不声称为两个方向提供全局顺序。

`session_list` barrier、subscription request/ACK、card snapshot 和后续 delta/card 全部位于 stream 0，因此它们保持严格顺序。Stream 1 的旧 range/TRACE/attachment frame 不参与这个 barrier，也不能阻塞 liveReady。

这让 Tentacle 的 subscription authority 始终明确。

---

# Part IV：Snapshot ordering

## 18. Tentacle 处理 request 的原子顺序

Tentacle 必须按以下顺序处理：

```text
1. validate sessionId
2. replace currentSessionByArm[armDeviceId]
3. capture SessionDigest
4. capture spineHeadSeq
5. capture CardManager draft/action
6. enqueue unicast session_subscription_set ACK
7. 才处理/发送之后产生的新 adapter live events
```

同一 Tentacle source **stream 0** 有序，而且 Head 把 source stream 原样映射到 destination stream，因此对目标 Arm：

```text
subscription ACK
before
subscription 建立后产生的 delta/card
```

## 19. 旧 session frame

在 A -> B 切换时，A 的旧 frame 可能已经进入 Head -> Arm destination endpoint。

Arm 必须只应用：

```ts
message.sessionId === confirmedSessionId
```

对于 subscriber-only 类型：

```text
agent_message_delta
card_action
```

如果 `message.sessionId !== confirmedSessionId`，直接丢弃。

B ACK 之前到达的 B subscriber-only frame 也不应用。正常有序实现下 B live frame 应位于 ACK 之后，这条规则作为防御边界。

## 20. Snapshot 应用

Arm 收到 stream-0 有效 ACK 后：

1. 用 `snapshot.digest` 更新 session runtime/metadata；
2. 用 `snapshot.card` 全量替换本地 live card；
3. 设置 `confirmedSessionId`；
4. 页面进入 `liveReady`，立即允许后续 stream-0 delta/card；
5. 比较本地 persistent head 与 `snapshot.spineHeadSeq`；
6. 如果存在缺口，通过 stream 0 发送 `request_session_messages_range` command；
7. Tentacle 在 stream 1 返回 `session_messages_range_batch`；
8. range 未完成期间保持 `spineReady = false`，但不撤销 liveReady；
9. TRACE 继续在 stream 1 独立 pull。

Card snapshot 是 replace，不是与旧 card events merge。

---

# Part V：消息分类

## 21. Subscriber-only

第一阶段：

```text
agent_message_delta
card_action
```

Tentacle 计算目标：

```ts
function subscribersFor(sessionId: string): string[] {
  return onlineAppDeviceIds.filter(
    deviceId => currentSessionByArm.get(deviceId) === sessionId,
  );
}
```

然后：

```text
targets = subscribersFor(sessionId)

if targets.length === 0:
  不发送 live frame
  不进入 pendingE2eQueue
else:
  encrypt once for targets
  multicast(targets)
```

## 22. 继续全局 multicast

第一阶段继续发给所有在线 Arm：

```text
session_list
session_created
session_ended
session_deleted
user_message
agent_message
active
idle
compacting
session title/model/mode/pin/read
permission_resolved
question_resolved
```

这样 sidebar、unread 和最终回复行为不需要同时重构。

## 23. Pull-only

继续 unicast request/response，但 request 和 response 位于不同 stream：

| 操作 | Arm request | Tentacle response |
|---|---:|---:|
| session messages/range | stream 0 | stream 1 |
| turn TRACE | stream 0 | stream 1 |
| attachment | stream 0 | stream 1 |

具体消息：

```text
request_session_messages
request_session_messages_range
request_turn_trace
request_attachment
```

## 24. 不再 replay 的 transient state

以下类型不进入通用 offline/pending queue：

```text
agent_message_delta
card_action
compacting
session_list
```

恢复权威：

| 数据 | 恢复权威 |
|---|---|
| Draft | subscription snapshot `card.draft` |
| Card action | subscription snapshot `card.action` |
| Runtime | `SessionDigest.state` |
| Spine | `messages.jsonl` + range sync |
| TRACE | `trace.jsonl` + pull |

---

# Part VI：Preview 复用，不新增 Attention message

## 25. `SessionAttentionMessage` 删除

不新增：

```text
SessionAttentionMessage
session_attention
```

原因：现有 `SessionDigest.preview` 已经能表达 sidebar attention。

当前类型：

```ts
export interface SessionPreviewDigest {
  text: string;
  type:
    | 'agent'
    | 'user'
    | 'error'
    | 'permission'
    | 'question'
    | 'answer';
  timestamp: string;
}
```

因此 question/permission 不需要第二套 attention wire state。

## 26. `updatePreview` 是什么

Web/iOS 中已有的 `updatePreview` 是客户端本地 store helper，不是 Tentacle 可以发送的 protocol message。

当前真正的 wire authority 是：

```text
session_list.payload.sessions[].preview
```

所以复用路径是：

```text
Tentacle 更新 SessionDigest.preview
-> 发送已有 session_list
-> Web/iOS 收到后调用现有 preview store/update 逻辑
```

不是新增一个 `update_preview` message。

## 27. Permission/question 打开时

Tentacle 维护一个低频 pending-preview authority：

```ts
interface PendingPreviewState {
  kind: 'permission' | 'question';
  text: string;
  openedAt: string;
}

private pendingPreviewBySession = new Map<string, PendingPreviewState>();
```

它是 Tentacle 内部状态，不是新 wire type。

`openedAt` 必须在 prompt 首次打开时生成并保持稳定。不能在每次构造 `session_list` 时使用新的当前时间，否则一个长期 pending prompt 会在任何 session-list 刷新时不断跳到 sidebar 顶部。

Tentacle 从当前 pending prompt 生成 digest preview。

### Permission

```ts
{
  type: 'permission',
  text: pending.text,
  timestamp: pending.openedAt,
}
```

其中 `pending.text` 来自：

```ts
action.payload.description || action.payload.toolName
```

### Question

```ts
{
  type: 'question',
  text: pending.text,
  timestamp: pending.openedAt,
}
```

其中 `pending.text` 来自 `action.payload.question`。

随后向所有在线 Arm 发送现有：

```text
session_list
```

未订阅该 session 的 Arm 因此仍会：

- 在 sidebar 看到 permission/question preview；
- 显示 pending 状态；
- 排序到最新 activity；
- 点击后进入 session subscription assure；
- 从 snapshot 得到完整 card。

## 28. Permission/question 解决时

当 permission/question：

```text
approved
denied
answered
auto-resolved
cancelled
idle-cleared
```

Tentacle 重新计算该 session preview：

- 如果还有 pending human action，保留其稳定 `openedAt` 和 pending preview；
- 如果当前 pending action 已解决，删除 `pendingPreviewBySession[sessionId]`；
- 然后回退到持久 spine 计算出的 preview；
- 更新 SessionDigest.state；
- 再发送现有 `session_list`。

这样 sidebar pending badge 被权威清理。

## 29. 为什么第一阶段接受全量 `session_list`

Permission/question 是低频控制事件，不是 token firehose。

第一阶段复用 `session_list` 的好处：

- 不增加新 wire type；
- Web/iOS 已有完整处理；
- preview、state、lastSeq、readSeq 同时保持一致；
- reconnect authority 不分裂；
- 减少协议面。

如果未来 session 数量很大、全量 `session_list` 成为明确成本，再新增通用：

```text
session_digest_updated
```

但不在本提案中预先添加。

## 30. Push 仍然必须独立

在线 sidebar attention 可以复用 `session_list.preview`。

离线设备收不到 session_list，因此仍需：

```text
dispatch_push -> @head
```

两者职责不同：

| 路径 | 目标 |
|---|---|
| `session_list.preview` | 在线 Arm 的 sidebar/pending state |
| `dispatch_push` | 离线 Arm 的系统通知 |
| subscription snapshot | 打开页面后的完整 card/draft/runtime |

---

# Part VII：Delta coalescing

## 31. Incremental delta 不能直接 keep-last

当前 `agent_message_delta` 通常是 incremental chunk：

```json
{
  "content": "下一段",
  "reset": false
}
```

如果 transport 用较新 chunk 覆盖旧 chunk，会丢文字。

在 multicast/coalescing 下必须保证待合并 payload 是 state-covering。

二选一：

### A. 合并尚未 flush 的 incremental chunks

```text
"这" + "是一" + "个测试"
=> "这是一个测试"
```

### B. coalescible frame 使用 full draft

```json
{
  "content": "当前完整 draft",
  "reset": true
}
```

无论采用哪种，subscription snapshot 始终带完整 draft，作为恢复权威。

---

# Part VIII：完整 TypeScript protocol diff

## 32. Outer relay additions

```ts
export interface MulticastEnvelope extends PulseFrameField {
  type: 'multicast';
  to: string[];
  blob: string;
  keys: Record<string, string>;
  ref?: string;
}

export type RelayEnvelope =
  | UnicastEnvelope
  | MulticastEnvelope
  | BroadcastEnvelope;

export type ServerErrorCode =
  | 'multicast_invalid_targets'
  | 'multicast_too_many_targets'
  | 'multicast_target_forbidden'
  | 'multicast_durable_not_supported'
  | 'push_dispatch_forbidden';

export interface ServerErrorMessage {
  type: 'server_error';
  message: string;
  code?: ServerErrorCode;
  ref?: string;
}

export interface DispatchPushMessage {
  type: 'dispatch_push';
  payload: {
    preview: BlobPayload;
  };
}
```

## 33. Inner subscription additions

```ts
export interface SetSessionSubscriptionMessage extends BaseEnvelope {
  type: 'set_session_subscription';
  payload: {
    sessionId: string | null;
  };
}

export interface SessionLiveSnapshot {
  digest: SessionDigest;
  spineHeadSeq: number;
  card: {
    draft: string;
    action: CardActionState | null;
  };
}

export interface SessionSubscriptionSetMessage extends BaseEnvelope {
  type: 'session_subscription_set';
  payload:
    | {
        accepted: true;
        sessionId: string;
        snapshot: SessionLiveSnapshot;
      }
    | {
        accepted: true;
        sessionId: null;
        snapshot: null;
      }
    | {
        accepted: false;
        sessionId: string;
        error: {
          code: 'session_not_found';
          message: string;
        };
      };
}
```

Union：

```ts
export type ConsumerMessage =
  | SetSessionSubscriptionMessage
  | /* existing */;

export type ProducerMessage =
  | SessionSubscriptionSetMessage
  | /* existing */;
```

没有新增：

```text
RelayCapabilities
ApplicationProtocolCapabilities
SetSessionSubscriptionsMessage
SessionSubscriptionsSetMessage
subscriptionEpoch
generation
targetDeviceId
sessionIds[]
SessionAttentionMessage
session_digest_updated
```

---

# Part IX：实施不变量

## 34. Arm 不变量

```text
最多一个 desired session
最多一个 confirmed session
最多一个 subscription request in flight
重连后先等待 post-auth session_list inbound barrier
只接受 barrier 后、request in flight 且 sessionId 匹配 desired 的 subscription ACK
旧 outbound set-value 自动重发是幂等的，不需要 generation
只有 confirmed session 的 delta/card 可以应用
页面只有在 matching snapshot ACK 后 liveReady
```

## 35. Tentacle 不变量

```text
每个 Arm 最多一个 current session
收到新 session 时原子替换旧 session
ACK snapshot 排在之后的 live events 前
subscriber-only event 不为离线/非订阅 Arm 排队
```

## 36. Head 不变量

```text
不理解 session
不理解 subscription
只验证 user/device/role target set
每个 source DATA frame 使用当前 envelope 上由 sender 按 `(streamId, seq)` 恢复的 target/target-set
source stream 原样映射到 destination stream
不解密 payload/push preview
```

---

## 37. 推荐接受的协议

建议接受以下最终 protocol shape：

1. `MulticastEnvelope { to: string[] }`；
2. Head 保持 session-blind，只路由 device target set；
3. `set_session_subscription { sessionId: string | null }`；
4. inner request 不携带 `targetDeviceId`；
5. 不使用 capability、compatibility、epoch 或 generation；
6. 每个 Arm 同时最多一个 subscribed session；
7. 页面通过 post-auth `session_list` barrier + 串行 request/ACK/snapshot assure 进入 liveReady；
8. `session_subscription_set` 返回单个 session snapshot；
9. 第一阶段 subscriber-only 仅为 delta/card；
10. 不新增 `SessionAttentionMessage`；
11. 在线 attention 复用现有 `session_list[].preview`；
12. permission 和 question 都必须生成带稳定 `openedAt` 的 preview，并在打开/解决时刷新 `session_list`；
13. 离线 notification 继续使用独立 `dispatch_push`；
14. sender 按 `(streamId, DATA seq)` 保存 target/target-set，Head 无需第二份 route registry；
15. Head 将 source stream 原样映射到每个 destination stream。

最终数据流：

```text
全局低频 session_list/preview/runtime
+ 单一当前 session live subscription
+ Head session-blind opaque multicast
+ 页面进入时 snapshot ACK assure
+ spine/TRACE/attachment 独立恢复
+ offline push 独立发送
```
