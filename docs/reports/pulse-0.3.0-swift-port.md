# Pulse 0.3.0 Swift Port — coalesceKey 适配清单

## 现状

| | TypeScript | Swift |
|---|---|---|
| 版本 | 0.3.0 (npm) | 0.2.0 等价 |
| coalesceKey | ✅ 完整实现 | ❌ 完全没有 |
| 测试数 | 132 | 64 |
| 向后兼容 | TS ↔ TS 全功能 | TS → Swift 安全（忽略 trailing bytes），Swift → TS 安全（不发 key） |

## 需要改动

### 1. Wire.swift — Frame 枚举加 coalesceKey

**位置**: `packages/pulse/swift/Sources/Pulse/Wire.swift`，约 20 行

```swift
// Frame 枚举: data case 加 coalesceKey
case data(seq: UInt64, ack: UInt64, payload: [UInt8], durable: Bool, coalesceKey: String?)

// encodeFrame: DATA 分支
case let .data(seq, ack, payload, durable, coalesceKey):
    w.header(.data)
    w.u8((durable ? 1 : 0) | (coalesceKey != nil ? 2 : 0))  // bit0=durable, bit1=hasKey
    w.u64(seq)
    w.u64(ack)
    w.blob(payload)
    if let key = coalesceKey { try w.str(key) }               // trailing str

// decodeFrame: DATA 分支
case .data:
    let msgFlags = try r.u8()
    let seq = try r.u64()
    let ack = try r.u64()
    let payload = try r.blob()
    let durable = (msgFlags & 1) == 1
    let hasKey = (msgFlags & 2) == 2
    let coalesceKey: String? = hasKey ? try r.str() : nil     // 读 trailing str
    return .data(seq: seq, ack: ack, payload: payload, durable: durable, coalesceKey: coalesceKey)
```

**注意事项**:
- bit 1 = 0 时 frame 字节完全不变，与 0.2 版本 byte-identical ✅
- bit 1 = 1 时 trailing str 紧随 blob，old decoder 读完 blob 停止，忽略尾随字节 ✅

---

### 2. Endpoint.swift — Effect 枚举加 coalesceKey

**位置**: `packages/pulse/swift/Sources/Pulse/Endpoint.swift`，约 5 行

```swift
// deliver case 加 coalesceKey
case deliver(seq: UInt64, payload: [UInt8], durable: Bool, coalesceKey: String?)
```

注意：Swift 的 `Effect` enum 使用关联值，所有匹配 `case deliver(...)` 的地方都需要加参数。用 `nil` 表示无 key。

---

### 3. Endpoint.swift — OutboxEntry 加 coalesceKey

**位置**: `packages/pulse/swift/Sources/Pulse/Endpoint.swift`，约 5 行

Outbox 当前是 tuple 数组：
```swift
private var outbox: [(seq: UInt64, payload: [UInt8], durable: Bool, sentAt: Int)] = []
```

改为：
```swift
private var outbox: [(seq: UInt64, payload: [UInt8], durable: Bool, sentAt: Int, coalesceKey: String?)] = []
```

所有引用 `outbox[i].seq`、`outbox[i].payload` 等的地方不变（Swift tuple label 访问不受新字段影响）。

---

### 4. Endpoint.swift — send() 方法加 coalesceKey

**位置**: `packages/pulse/swift/Sources/Pulse/Endpoint.swift`，约 35 行

```swift
func send(_ payload: [UInt8], durable: Bool = false, coalesceKey: String? = nil) -> (seq: UInt64, effects: [Effect]) {
    // 1. 互斥检查
    if coalesceKey != nil && durable {
        fatalError("coalesceKey requires durable=false")  // 或 throw
    }
    
    // 2. Key 长度验证（>255 UTF-8 bytes → reject before state mutation）
    if let key = coalesceKey, key.utf8.count > 255 {
        fatalError("coalesceKey exceeds 255 bytes")
    }
    
    var effects: [Effect] = []
    
    // 3. 发送时 coalesce：删除同 key 的旧 outbox entry
    if let key = coalesceKey {
        let before = outbox.count
        var droppedSeqs: [UInt64] = []
        outbox = outbox.filter { entry in
            if entry.coalesceKey == key {
                droppedSeqs.append(entry.seq)
                return false
            }
            return true
        }
        if !droppedSeqs.isEmpty {
            effects.append(.purged(droppedSeqs: droppedSeqs, reason: "coalesced:\(key)"))
        }
    }
    
    sendSeq += 1
    let seq = sendSeq
    let actualDurable = durable && self.durable.supported
    outbox.append((seq: seq, payload: payload, durable: actualDurable, sentAt: clock, coalesceKey: coalesceKey))
    
    if actualDurable { effects.append(.store(seq: seq, payload: payload)) }
    
    if state == .connected {
        let wireDurable = durable && peerDurableSupported
        effects.append(transmit(.data(seq: seq, ack: recvCursor, payload: payload, durable: wireDurable, coalesceKey: coalesceKey)))
    }
    
    return (seq, effects)
}
```

---

### 5. Endpoint.swift — onData 加 coalesceKey 转发

```swift
// onData 中: deliver effect
effects.append(.deliver(seq: f.seq, payload: f.payload, durable: f.durable, coalesceKey: f.coalesceKey))
```

---

### 6. Endpoint.swift — resendFrom 加 coalesceKey 转发

```swift
// resendFrom 中 transmit data frame
let wireDurable = entry.durable && peerDurableSupported
effects.append(transmit(.data(
    seq: entry.seq, ack: recvCursor, payload: entry.payload,
    durable: wireDurable, coalesceKey: entry.coalesceKey
)))
```

---

### 7. Endpoint.swift — Snapshot 序列化/反序列化

**Snapshot 结构体** 加字段：
```swift
public var outbox: [(seq: UInt64, payload: [UInt8], durable: Bool, sentAt: Int, coalesceKey: String?)]
```

**snapshotInternal** 写 coalesceKey：
```swift
coalesceKey: entry.coalesceKey
```

**loadSnapshot** 读 coalesceKey：
```swift
coalesceKey: entry.coalesceKey  // pre-0.3 snapshot 中不存在 → nil
```

---

### 8. 测试 — 新增 coalesce.test.ts 对应的 Swift 测试

约 150 行，覆盖 6 个场景：

| 测试 | 说明 |
|------|------|
| COALESCE-BASIC | 100 个同 key send → 只保留 1 个，deliver 最新 |
| COALESCE-MIXED | 不同 key + unkeyed 共存，按 seq 顺序 |
| COALESCE-GAP | 已 deliver 的 entry 被 coalesce 后 consumer 跳过 |
| COALESCE-DURABLE | coalesceKey + durable=true 抛错 |
| COALESCE-SNAPSHOT | coalesceKey 经 snapshot round-trip 存活 |
| COALESCE-VALIDATION | >255 字节 key 抛错，outbox 不变 |

---

## 改动量估计

| 文件 | 改动行数 |
|------|---------|
| Wire.swift | ~20 |
| Endpoint.swift | ~60 |
| Harness.swift (test) | ~10 |
| WireTests.swift | ~40 |
| **新** CoalesceTests.swift | ~120 |
| **合计** | **~250 行** |

其中约 150 行是测试代码，核心实现约 100 行。

---

## 兼容性保证

- **Swift → TS**: 旧 Swift 不发 coalesceKey（bit 1 = 0），TS 正确解码为 `undefined` → ✅
- **TS → Swift**: TS 发带 key 的 frame，旧 Swift decoder 读 blob 后停止，忽略 trailing bytes → ✅ 不会崩
- **新 Swift → 新 TS**: 全功能互通 ✅
- **CoalesceKey 在 head hub 转发**: head 是 TS，已经通过 stash 改动支持转发 key 到 arm endpoint → ✅
