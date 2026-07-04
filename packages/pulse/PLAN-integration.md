# Plan: 正式接入 pulse(逐跳架构)

> 状态源。这是把 pulse 真正接进 Kraki 的大工程。spike 已证明模型可行,
> 老集成已 reset。现在按逐跳 mindset 从头接。

## 已经确定的地基(不再讨论)

- **pulse 逐跳**:arm↔head 一条 pulse,tentacle↔head 一条 pulse。head 是同时
  参与两条、总在线的 pulse 端点。
- **pulse = 带可靠性的 ws**。加密在 pulse 之上,pulse 运不透明 payload。
- **pulse 帧头明文,payload 密文**:head 读帧头(seq/ack/durable),不解密 payload。
- **durable**:只 delete_session 标 durable。head 两个端点 supported=true,SQLite
  持久化。arm/tentacle supported=false。
- spike 已验证:桥 + SQLite durable + head 重启恢复。deliver.durable 已加。

## 信封格式(三方必须一致)—— 先定死

今天的线格式(head 能读的信封层):
```
BroadcastEnvelope  { type:'broadcast', blob, keys, notify? }
UnicastEnvelope    { type:'unicast', to, blob, keys, ref? }
```
`blob` = base64(iv‖ciphertext‖tag),head 读不了。

新逐跳格式:pulse 帧头从 blob **外面**走,payload(密文 blob)在帧头里。
两个选择:

**(A) pulse 帧头进信封字段**(推荐,改动小):
```
{ type:'unicast', to, pulse: <base64 pulse header bytes>, blob, keys }
```
head 解 `pulse` 字段(seq/ack/durable/hello…),`blob` 照旧透明转发/存。
pulse frame 的 payload = 那个 blob(密文)。

**(B) pulse 帧完整包在信封外,blob 塞进 pulse payload**:
head 收到的就是 pulse frame bytes,payload 段是密文 blob。
更纯但 head 要完全换掉信封解析。

→ **本 plan 采 (A)**:信封多一个 `pulse` 字段带帧头,`blob`/`keys` 语义不变,
head 增量加"读 pulse 字段"逻辑,不推翻现有路由/auth/presence。

## 工作分解

### Phase A — head 升级为多连接 pulse 端点 + SQLite 桥
1. head 依赖 `@kraki/pulse`。
2. `PulseHub`(head 新模块):`Map<deviceId, Endpoint>`,每个连接一个端点,
   durable supported=true。SQLite 表 `pulse_outbox` + `pulse_meta`(spike 已验证的 schema)。
3. head 的转发路径(handleBroadcast/handleUnicast)包一层:
   - 收到带 `pulse` 字段的信封 → 喂对应端点 `onBytes` → 处理 effects:
     - `deliver` → 这条要转给目标设备 → 用目标设备的端点 `send(blob, {durable})`
       → 把产生的 pulse 帧头 + blob 组成信封发给目标(或目标离线时靠 durable 存)。
     - `store`/`unstore` → SQLite。
     - `transmit`(ack/hello/resend)→ 发回源设备。
   - 连接建立/断开 → 对应端点 onConnected/onDisconnected。
   - 定时器 → onTick 所有端点(心跳/liveness/durable 过期)。
4. head 重启:boot 时从 SQLite 恢复每个端点的 snapshot + outbox。
5. **保留**现有 auth/pairing/presence/push 不动。
6. **退场**:老的 `relaySeq`/`trackedSend`/`pending_messages` 与 pulse 冗余。
   本 plan 先**并存 + flag**(KRAKI_PULSE),验证后再删,不一步到位。

### Phase B — tentacle 重接(逐跳,frame 在信封外)
1. tentacle 一个 pulse 端点(对 head 这条 WS),supported=false。
2. 出站:reliable producer 消息 → 加密成 blob → `pulse.send(blob)` → 帧头进
   信封 `pulse` 字段 + blob → 发。deltas 等瞬态仍走老 fire-and-forget。
3. 入站:收到带 `pulse` 字段的信封 → 端点 onBytes → `deliver` 的 payload = blob
   → 解密 → handleConsumerMessage。
4. 生命周期:WS open/close → onConnected/onDisconnected;staleCheck timer → onTick。
5. **修 approve 谎报**:permission_resolved 广播改成等 pulse acked 再确认。
6. **确认幂等**:重发的 approve/answer 对已解析 id 是 no-op(审计说已有,验证接上)。

### Phase C — arm 重接(逐跳 + 乐观回滚)
1. arm 一个 pulse 端点(对 head 这条 WS),supported=false。
2. 出站:reliable consumer 消息(approve/answer/send_input/mode/delete_session)
   → 加密 → `pulse.send(blob, {durable: type==='delete_session'})` → 帧头进信封。
3. 入站:pulse 帧 → onBytes → deliver → 解密 → handleDataMessage。
4. **乐观 + 失败回滚**(你定的模型):
   - approve/mode 等:乐观应用 + 记旧状态 → 收 `acked` 落定 → 超时/未 acked 回滚+报错。
   - delete_session:乐观删 + durable=true(head 替离线 tentacle 存)。
5. 生命周期:transport open/close → onConnected/onDisconnected;tick timer → onTick。

### Phase D — 端到端验证
1. 真 SQLite + 真 head + 真 tentacle + 真 arm 逻辑的集成测试(packages/tests):
   - reliable 消息跨 arm 断线重连不丢
   - delete_session 在 tentacle 离线时:arm 发→head 存→tentacle 上线→删
   - head 重启后 durable 不丢
   - approve 断线重连 exactly-once + UI 落定
   - approve 永远发不出去 → 超时回滚 + 报错
2. Playwright:pulse 开,浏览器 arm 真实渲染 + 一个断线恢复场景。
3. 全套回归:tentacle 524 / head / arm 单测 pulse 关时不变。

## kraki-free 红线(pulse 包不动)

- pulse 包本身**一行不改**(除非又发现真 bug)。所有 kraki 逻辑在 head/tentacle/arm。
- head/tentacle/arm 可以有 kraki 概念(它们本来就是 kraki)。
- 但"pulse 帧头 vs payload"的分层要严格:pulse 只碰帧头,payload 永远是它不懂的 blob。

## 顺序 & 风险

- **A 先**(head 是枢纽,且 spike 已把它的模型验证过,风险最低)。
- **B、C** 跟上(对称,各接一条 WS)。
- **D 收尾**。
- flag-gated 全程:KRAKI_PULSE 关时走老路,开时走 pulse,可回滚。
- 老机制退场(relaySeq/pending_messages)**不在本 plan**——先让 pulse 并存跑通。
