# Pulse Wire Fixtures

Byte-exact encodings of every frame type. **Both** the TypeScript and Swift
implementations MUST encode to these exact bytes and decode them back to the
same logical frame. `fixtures/wire.json` is the machine-readable copy that both
test suites load; this file explains it.

All multi-byte integers are **big-endian**. Bytes shown as hex.

## Encoding primitives

```
u8   : 1 byte
u32  : 4 bytes big-endian
u64  : 8 bytes big-endian
str  : u8 len || len UTF-8 bytes        (len 0..255)
blob : u32 len || len bytes             (len 0..2^32-1)
```

## Header

Every frame begins with `B1 01 <type>`.

## Fixtures

Each fixture: a logical frame, its field values, and the exact bytes.

### F1 — HELLO, cold consumer (nothing received yet, durable not supported)
```
frame  : HELLO { epoch: "a", recvEpoch: "", recvCursor: 0, durableSupported: false, maxRetentionMs: 0 }
bytes  : B1 01 01  01 61  00  00 00 00 00 00 00 00 00  00  00 00 00 00 00 00 00 00
          └header┘  │└"a"  │   └──── u64 recvCursor=0 ────┘ │  └── u64 maxRetentionMs=0 ──┘
                    len=1   len=0                        durFlags=0
```

### F2 — HELLO, warm resume (durable not supported)
```
frame  : HELLO { epoch: "node-7", recvEpoch: "phone-3", recvCursor: 42, durableSupported: false, maxRetentionMs: 0 }
bytes  : B1 01 01  06 6E6F64652D37  07 70686F6E652D33  00 00 00 00 00 00 00 2A  00  00 00 00 00 00 00 00 00
```

### F2b — HELLO, durable-supported endpoint (30-day retention)
```
frame  : HELLO { epoch: "head-1", recvEpoch: "", recvCursor: 0, durableSupported: true, maxRetentionMs: 2592000000 }
note   : durFlags bit 0 = 1; 2592000000 ms = 30 days = 0x9A7EC800
bytes  : B1 01 01  06 686561642D31  00  00 00 00 00 00 00 00 00  01  00 00 00 00 9A 7E C8 00
                                                              durFlags=1  └ maxRetentionMs ┘
```

### F3 — DATA, first message, no ack, not durable
```
frame  : DATA { seq: 1, ack: 0, payload: 0x DE AD BE EF, durable: false }
bytes  : B1 01 02  00  00 00 00 00 00 00 00 01  00 00 00 00 00 00 00 00  00 00 00 04  DEADBEEF
          └header┘ │   └──── u64 seq=1 ─────┘  └──── u64 ack=0 ─────┘  └u32 len=4┘ └payload┘
              msgFlags=0
```

### F3b — DATA, durable bit set
```
frame  : DATA { seq: 7, ack: 0, payload: 0x DE AD BE EF, durable: true }
bytes  : B1 01 02  01  00 00 00 00 00 00 00 07  00 00 00 00 00 00 00 00  00 00 00 04  DEADBEEF
              msgFlags=1 (durable)
```

### F4 — DATA, with ack and empty payload
```
frame  : DATA { seq: 258, ack: 257, payload: <empty>, durable: false }
bytes  : B1 01 02  00  00 00 00 00 00 00 01 02  00 00 00 00 00 00 01 01  00 00 00 00
```

### F5 — ACK
```
frame  : ACK { ack: 65535 }
bytes  : B1 01 03  00 00 00 00 00 00 FF FF
```

### F6 — RESET
```
frame  : RESET { epoch: "node-7", oldest: 100 }
bytes  : B1 01 04  06 6E6F64652D37  00 00 00 00 00 00 00 64
```

### F7 — HEARTBEAT
```
frame  : HEARTBEAT { ack: 42 }
bytes  : B1 01 05  00 00 00 00 00 00 00 2A
```

### F8 — DATA with a large seq (64-bit boundary sanity)
```
frame  : DATA { seq: 72057594037927937 (0x0100000000000001), ack: 0, payload: 0x41, durable: false }
bytes  : B1 01 02  00  01 00 00 00 00 00 00 01  00 00 00 00 00 00 00 00  00 00 00 01  41
```

### F9 — HELLO with multibyte-UTF8 epoch (length is in BYTES, not chars)
```
frame  : HELLO { epoch: "é", recvEpoch: "", recvCursor: 0 }
note   : "é" = U+00E9 = 0xC3 0xA9 (2 bytes) ⇒ str len = 2
bytes  : B1 01 01  02 C3A9  00  00 00 00 00 00 00 00 00
```

## Decode robustness cases (must NOT throw; frame is ignored)

| name | bytes | why ignored |
|------|-------|-------------|
| BAD-MAGIC | `B2 01 03 …` | magic ≠ 0xB1 |
| BAD-VERSION | `B1 02 03 …` | version ≠ 1 |
| UNKNOWN-TYPE | `B1 01 09 …` | type 9 not defined in v1 |
| TRUNCATED | `B1 01 02 00 00` | DATA header present but body short |
| EMPTY | `` (0 bytes) | no header |

A conformant decoder returns "no frame" (null/nil) for all of the above without
raising. The endpoint treats "no frame" as: ignore, no state change.
