# Plan: durable 能力 refactor 进 pulse(kraki-free)

> 状态源。做之前、做当中反复对照。核心红线在最后,违反即回滚。

## 一句话目标

把"离线持久暂存"这个**传输能力**从 head 手写(pending_messages)解耦、归位到
pulse,成为 durable-supported 端点的通用能力。**pulse 全程零 kraki 概念。**
这是 refactor(能力已存在),不是发明。

## 已定死的决定(不再讨论)

1. **最小 durable 集 = 只 delete_session**。其余 tentacle 离线时无意义 → fail-fast。
2. **store 归 pulse 库**:核发 `store`/`unstore` effect,适配器只管落盘。
3. **fail-fast 不靠 server_error**。tentacle 离线时 head 在线,arm→head 成功,不存在
   发送失败。机制 = arm 的 pulse 等不到端到端 acked → 超时 → 应用回滚。head 保持哑。
4. **先做 pulse,确保 kraki-free**;head 升级 + 集成是后续,不在本 plan。

## 架构(已 review 定稿)

- pulse 逐跳:`arm↔head` 一条 pulse,`head↔tentacle` 另一条。
- head 是同时参与两条、总在线的 pulse 端点(head 升级在后续 plan)。
- durable 是"端点在握手时协商的能力":head 声明 supported=true,arm/tentacle false。
- durable 判定从"接收端取时筛"**前移**到"发送端 send 时标 flag"(refactor 净变化)。
- E2E 与 pulse 正交:payload 永远 opaque bytes,pulse 不知道那是密文。

## pulse 核要加什么(本 plan 的全部工作)

### A. 握手协商 durable 能力
- `EndpointOptions.durable?: { supported: boolean; maxRetentionMs?: number }`
  - 默认 `{ supported: false }`。
- HELLO frame 增加 durable 能力字段(线格式变更 → fixtures 要更新,TS/Swift 同步)。
- 收到对端 HELLO 后,记录 `peerDurableSupported: boolean`。

### B. send 时的 durable flag
- `send(payload, opts?: { durable?: boolean })`。
- `durable: true` 且 `peerDurableSupported` → DATA frame 带 durable 位。
- `durable: true` 但对端不 supported → 降级为普通(pulse 不报错;是否 fail 由应用
  按 acked 超时判定 —— 那是应用层的事,不在核)。

### C. durable 端点收到带 durable 位的消息 → store effect
- 我(supported=true 的端点)收到一条带 durable 位、但**无法立即向下游确认**的消息
  时,发 `{ t:'store', seq, payload }` 让适配器落盘。
- **关键 kraki-free 边界**:核只给 seq + bytes。**"存去哪、给谁、按什么 key" 核不知道**
  —— 那是适配器(head 应用层)的路由知识。核连"有个第三方目标"都不知道。
  → 这意味着 store 的语义要谨慎定义(见"待解决的设计张力")。

### D. resume 补 durable store
- 端点重连握手时,现有逻辑补内存 outbox;durable 端点还要能把 store 里属于该对端
  的消息重新投递。**但"属于该对端"又是路由知识** → 见张力。

### E. unstore
- 下游确认取走后,发 `{ t:'unstore', seqUpTo }` 让适配器清盘。

## ⚠️ 必须先解决的设计张力(动手前想清楚)

**核心难点:store/resume 需要"这条最终给谁"的知识,但那是 kraki 路由,核不能知道。**

pulse 是逐跳的。head 的 arm↔head 端点收到一条 durable 消息,它 deliver 给 head 应用层。
"这条要转给 tentacle、tentacle 离线所以要存"——这是 **head 应用层**读 `to` 做的,不是
pulse 端点。那 pulse 的 store effect 到底在这个流程的哪一步发?

两种可能,本 plan 要选一种(倾向 B,更 kraki-free):

- **(A) store 在"接收 durable 消息"时发**:arm↔head 端点收到带 durable 位的 DATA →
  核发 store。问题:此时核不知道"要不要真存"——存不存取决于"下游 tentacle 在不在线",
  而那是应用层知识。核凭什么发 store?→ 语义不清,弃。

- **(B) store 是"发送端点"的能力,不是"接收端点"的**:重新理解 —— durable 是
  **发送方 outbox 的一个属性**。一个端点 send(durable) 后,这条进它的 outbox;如果
  对端离线迟迟不 ack,而**这个发送端点自己 supported=true(能持久)**,它就把 outbox
  里这条落盘(store effect),重连后从盘里 resume。
  → 但这又回到"发送方 arm 不 supported、会离线"的老问题。

**这两种都不干净。真正的解法可能是承认:head 上是"两个独立 pulse 端点 + 中间一个
应用层 store",durable 消息在 head↔tentacle 那个端点的 outbox 里等,而那个端点
supported=true 所以 outbox 可落盘。** 即:
- arm→head:普通 pulse,arm send(durable) 只是让 head **应用层**知道"这条要 durable
  转发"(通过 frame 的 durable 位,head 可读)。
- head 应用层:收到 → 交给 head↔tentacle 端点 send();tentacle 离线 → 这条进该端点
  outbox;该端点 supported=true → outbox 落盘(store effect)→ 重连 resume。

**结论:durable 位是"给下一跳端点的指示:请把这条放进可落盘的 outbox"。store/unstore
是 outbox 持久化,不是独立存储。这样核只管"我的 outbox 要不要落盘",不需要知道目标。**

→ **本 plan 采用这个理解**:durable = "这条 outbox 条目需持久化(跨进程重启)";
supported = "本端点的 outbox 能落盘";核发 store/unstore = outbox 落盘/清盘,**只给
seq+bytes,不涉及目标**。head 应用层负责把 arm 来的 durable 消息喂给 head↔tentacle
端点。完全 kraki-free。

## 最苛刻的测试(与 kraki 无关,A/B 匿名端点)

核心不变量测试(现有 70 TS / 37 Swift)全部保留。durable 新增:

1. **能力协商**:A supported=false + B supported=true → 双方正确记录 peerSupported。
   四种组合(FF/FT/TF/TT)都测。
2. **durable flag 只在对端 supported 时上线**:A→B 且 B not supported,send(durable)
   → frame 无 durable 位,行为同普通。
3. **supported 端点的 outbox 落盘**:A supported=true,send(durable) 给离线 B →
   核发 store(seq,bytes)。B 一直离线 → store 保留。
4. **resume 从 store 补发**:承 3,A"重启"(新 Endpoint + 从 store 快照恢复)→ B 上线
   → A 从 store resume 补发 → B 收到 → A 收 ack → 发 unstore。
5. **durable + 非 durable 混合**:交错 send(durable) 和 send() 给离线对端,只有 durable
   的进 store,非 durable 的只在内存 outbox(重启即失)。断言 store 里只有 durable 的。
6. **unstore 时机**:只有对端 ack 后才 unstore;ack 之前 store 一直在。
7. **durable 消息也遵守 exactly-once + 有序**:store→resume→deliver 不重不乱。
8. **property(fast-check)**:随机 fault 程序里混入 durable/非 durable send + 随机
   重启(从 store 恢复),断言:所有 durable 消息最终送达 exactly-once;所有非 durable
   消息在"重启前未 ack"的允许丢失;store 最终清空(全 unstore)。
9. **wire fixtures**:HELLO 带 durable 能力字段的字节级 fixture,TS+Swift 一致。
10. **maxRetentionMs**:store 里超过保留期的条目 → 核发 unstore(或 expired 信号),
    不再 resume。测过期边界。

## kraki-free 红线(每写一段自查,违反即回滚)

1. **词汇黑名单**:pulse 源码(核+类型+测试)不出现:session/delete/approve/kraki/
   tentacle/arm/head/relay/encrypt/E2E/permission。出现=泄漏。
2. **payload 永远 Uint8Array**,pulse 永不 parse/inspect/JSON.parse。
3. **durable 只用传输词**:supported / durable / maxRetentionMs / store / unstore。
4. **store/unstore effect 只给 seq + bytes**,不给"目标/key/路由"。核不知道有第三方。
5. **"relay 是中转站"不进 pulse**。核只知"对端 supported"。转发智能全在核之外。
6. **测试用 A/B 匿名端点**,不提 kraki 场景。
7. **终极自查**:把 pulse 源码拎进一个不相干项目,应能原样编译+测试+使用。

## 顺序

1. 先在 spec/PROTOCOL.md + FIXTURES.md 定义 durable 的线格式 + 语义(纯传输语言)。
2. TS 核实现 A-E,配测试 1-10 逐个红→绿。
3. property 测试(8)扩展。
4. Swift 同步实现 + 测试对齐,wire fixtures 双语言字节一致。
5. 全绿 + kraki-free 自查通过 → 更新 design-report.html 的过时处 → commit。
6. (本 plan 到此。head 升级 + 集成是下一个 plan。)
