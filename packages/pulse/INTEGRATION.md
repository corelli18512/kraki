# Pulse integration plan (tentacle ↔ arm)

Goal: route the **reliable** tentacle→arm and arm→tentacle messages through a
per-device pulse `Endpoint`, so nothing is silently lost across a
disconnect/reconnect. E2E, auth, pairing, head, and durable session replay are
untouched. Deltas and other transient types keep their existing fire-and-forget
path.

## Key facts established from the code

- **Reliable set** = tentacle's `PERSISTENT_TYPES` (relay-client.ts:72) —
  session_created, agent_message, user_message, permission(_resolved),
  question(_resolved), tool_start, tool_complete, error, session_ended, idle.
  These (and their arm→tentacle counterparts) go through pulse. Deltas, active,
  attachment_data, session_list, greetings → unchanged.
- **RSA cost is unchanged** by per-device: E2E already wraps the AES key once
  per device (crypto/index.ts:102). Per-device pulse adds only (N-1) cheap AES
  ops, not RSA. So per-device (correct semantics) is affordable.
- **head does NOT stamp the sender deviceId** onto a forwarded broadcast
  (server.ts:924 forwards msg as-is). The arm therefore can't tell which
  tentacle a blob came from — so the pulse frame must carry the source deviceId
  *inside the encrypted envelope* (head still sees nothing).
- **pulse core is now browser-safe** (isomorphic base64) — the arm can import it.

## Wire shape (inside the E2E ciphertext)

Today: `plaintext = JSON.stringify(ProducerMessage)` → encryptToBlob.

New (reliable types only): a thin JSON envelope wrapping a pulse frame:
```
plaintext = JSON.stringify({
  kind: 'pulse',
  src: <senderDeviceId>,          // who this endpoint stream belongs to
  frame: base64(pulseFrameBytes),  // encodeFrame(...) output
})
```
- head sees only ciphertext (unchanged).
- receiver decrypts → sees `kind:'pulse'` → routes `frame` to the Endpoint for
  peer `src` → Endpoint emits `deliver(payload)` where payload is the original
  `JSON.stringify(ProducerMessage)` bytes → hand to existing handler.
- Non-pulse plaintext (deltas etc.) has no `kind:'pulse'` → handled exactly as
  today. Fully backward compatible.

## Tentacle changes (relay-client.ts)

1. `private pulse = new Map<deviceId, Endpoint>()` — one per consumer device.
   Lazy-created in `sendEncrypted` / on `device_joined`. epoch persisted per
   device under KRAKI_HOME (like SessionManager) for restart-durability.
2. `sendEncrypted(msg)`: if `msg.type ∈ PERSISTENT_TYPES`, for each online
   consumer device: `ep.send(utf8(JSON.stringify(msg)))`, and for each
   `transmit` effect wrap+encrypt **per device** (unicast to that device). Else
   keep the single broadcast path unchanged.
3. Link lifecycle → drive endpoints:
   - `device_joined` / key learned → `ep.onConnected(now)`
   - `ws close` (relay-client.ts:297) → `ep.onDisconnected(now)` for all
   - existing staleCheck timer (relay-client.ts:2252) → `ep.onTick(now)` for all
   - **ignore `open`/`close` effects** (shared head WS; can't dial per device)
4. Inbound (handleMessage ~:470): after decrypt, if `kind:'pulse'` feed
   `ep.onBytes(frame)`; act on `deliver` (→ existing consumer handler) /
   `reset-inbound`.
5. Outbox eviction: cap + GC endpoint on `device_removed` (:462).

## Arm changes (mirror)

- `pulse.ts`: a small manager holding `Map<tentacleDeviceId, Endpoint>` +
  snapshot persistence in IndexedDB.
- transport.ts inbound (:294 post-decrypt at encryption.ts:140): `kind:'pulse'`
  → onBytes → deliver → handleDataMessage.
- outbound reliable consumer msgs (send_input, approve, answer, …) → through the
  peer Endpoint → encryptOutbound as unicast.
- drive onConnected/onDisconnected from transport open/close; onTick from a timer.

## What we explicitly DO NOT touch

- head / auth / pairing / push.
- messages.jsonl + request_session_messages durable replay (pulse heals live
  tail-loss; full history still owned by SessionManager).
- delta debounce, attachment chunk stream.
- E2E crypto internals.

## Verification

Isolated dev stack under .tmp (KRAKI_HOME), Playwright e2e: start a session,
force a WS drop mid-turn, assert the arm ends with every reliable message (no
hole) — the exact failure pulse exists to fix.
