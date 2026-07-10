# Pulse Outage Post-Mortem & Debugging Guide

> 2026-07-10 — root cause, fixes, and operational debugging tools for the pulse reliable-transport layer.

## Summary

A single bug in `@coinfra/pulse` (the reliable-transport library used by kraki's head relay) caused **every head restart to permanently wedge all pulse message delivery** — the prod symptom was "the web arm shows nothing, chat is completely broken after a deploy."

The bug was in `pruneOutbox()`: it set `outboxBase = ackSeq` without clamping to `sendSeq`. After a head restart from a durable-only snapshot, the peer (tentacle) could advertise a `recvCursor` higher than the head's restored `sendSeq` (non-durable sends were lost in the crash). This made `outboxBase > sendSeq`, and on the next fresh reconnect the peer's `seq=1..N` frames were treated as duplicates and silently dropped — permanently wedging the link.

**Fixed in**: `@coinfra/pulse@0.3.1`, `@kraki/head@0.16.2`, `@kraki/tentacle@0.29.0`.

## Root Cause

```
1. Head sends durable(1733) + non-durable(1734–1751) → sendSeq=1751
2. Tentacle receives all → recvCursor=1751
3. Tentacle's hello/ack carries recvCursor=1751 → head's pruneOutbox(1751)
   → outboxBase=1751 (durable 1733 pruned → unstore → saveSnapshot)
   → snapshot: sendSeq=1751, outboxBase=1751 ✓ consistent
4. Head sends more non-durable(1752–1800) → sendSeq=1800 (no snapshot — non-durable)
5. Head crashes/restarts → loads snapshot from step 3: sendSeq=1751, outboxBase=1751
6. Tentacle (still running) reconnects → hello with recvCursor=1800
7. Head's onHello → pruneOutbox(1800) → outboxBase=1800, sendSeq still 1751 ← INCONSISTENT
   → no durable entries to prune → no unstore → no saveSnapshot
8. Later durable event triggers saveSnapshot → persists sendSeq=1752, outboxBase=1800 ← CORRUPTED
9. Next head restart → loads corrupted snapshot
10. Tentacle reconnects fresh (recvCursor=0) → head sends reset with oldest=outboxBase+1=1801
11. Tentacle: recvCursor=1800 → head's new sends (seq=1753, 1754...) all ≤ 1800 → DUPLICATES → silently dropped
12. PERMANENT DEADLOCK
```

### Fix

Two-layer clamp in `@coinfra/pulse@0.3.1`:

1. **`pruneOutbox`**: `outboxBase = min(ackSeq, sendSeq)` — never let outboxBase exceed sendSeq.
2. **`loadSnapshot`**: `outboxBase = min(outboxBase, sendSeq)` on restore — self-heal corrupted snapshots from pre-0.3.1.

## Additional Fixes (same session)

### Offline push preview regression (`ec6a255c`)

`buildPushPreview()` encrypted the push preview only to ONLINE consumers (`recipients` filtered by `onlineConsumers`). But push previews are for OFFLINE devices. The head's `PushManager.sendToDevice` found `keys[offlineDeviceId] === undefined` and bailed — no push was ever sent.

**Fix** (`tentacle 0.29.0`): `buildPushPreview` now builds its own recipient list from ALL `consumerKeys` (online + offline).

### Silent message drop on key-sync race

`sendEncrypted()` silently returned when `recipients.length === 0` (online consumer with invalid key). Added `SEND-DECISION` trace with `droppedReason` so these drops are visible in pulse-trace.log. Kept the return (not queueing) because invalid keys would loop forever in `flushE2eQueue`.

## Current Deployed Versions

| Component | Version | pulse | Where |
|-----------|---------|-------|-------|
| `@coinfra/pulse` | 0.3.1 | — | npm |
| `@kraki/head` (main) | 0.16.2 | 0.3.1 | AWS Tokyo (`relay.kraki.chat`, REGION=us) |
| `@kraki/head` (edge) | 0.16.2 | 0.3.1 | Tencent Cloud (`cn.relay.kraki.chat`, REGION=china) |
| `@kraki/tentacle` | 0.29.0 | 0.3.1 | npm + local install |
| `@kraki/arm-web` | 0.14.0 | 0.3.1 | prod (`app.kraki.chat`, auto-deployed via CI) |

All packages are installed from npm — no local links or source hot-fixes in prod.

## Debugging Tools

### Head health canary (always on, no trace needed)

Every 30s the head logs a health line to journald:
```
health {"conns":1,"endpoints":2,"durableRows":0,"rssMb":67,"heapUsedMb":9,"heapTotalMb":10}
```

Check for OOM / memory leaks:
```bash
# Edge (China)
ssh corelli-tecent-cloud-small-0 'journalctl -u kraki-relay -n 100 --no-pager -o cat | grep health'

# Main (US)
ssh corelli-aws-tokyo-0 'journalctl -u kraki-relay -n 100 --no-pager -o cat | grep health'
```

Key indicators:
- `rssMb` / `heapUsedMb` should be stable (not monotonically growing)
- `durableRows` should be 0 or near-0 (non-durable messages don't persist)
- `endpoints` = number of devices that ever connected (GC'd after 24h offline)
- `conns` = currently connected devices

### Head pulse trace (gate: `KRAKI_TRACE_PULSE=1`)

Enable on the edge relay:
```bash
ssh corelli-tecent-cloud-small-0
echo 'KRAKI_TRACE_PULSE=1' >> /etc/kraki/relay.env
systemctl restart kraki-relay
journalctl -u kraki-relay -f | grep TRACE
```

Trace events: `WS-RX`, `HUB-DELIVER`, `HUB-FORWARD`, `HUB-TX`, `HUB-STORE`, `HUB-UNSTORE`, `FWD-SEND`, `GC-PURGE`, `GC-EVICT`, `DEV-CONNECT`, `DEV-DISCONNECT`, `CTRL-SELF`, `PUSH-FIRE`, `PUSH-SEND`, `PUSH-SKIP`.

Each line is structured JSON with `t` (epoch ms), `comp: "head"`, and the event fields. Correlate with arm/tentacle logs via `wallMs` timestamps and `fp` (payload fingerprint).

**Remember to disable after debugging** (trace is verbose under streaming):
```bash
sed -i '/^KRAKI_TRACE_PULSE=1$/d' /etc/kraki/relay.env
systemctl restart kraki-relay
```

### Tentacle pulse trace (gate: `KRAKI_TRACE_PULSE=1`)

The tentacle's `KRAKI_TRACE_PULSE` must be set before the daemon starts. The `kraki start` command regenerates the launchd plist without forwarding this env var, so you need to either:

1. **Inject into plist + reload** (survives `kraki start` but needs re-injection after):
```bash
python3 -c "
p = open('$HOME/Library/LaunchAgents/cloud.corelli.kraki.plist').read()
if 'KRAKI_TRACE_PULSE' not in p:
    p = p.replace('</dict>', '<key>KRAKI_TRACE_PULSE</key><string>1</string></dict>', 1)
    open('$HOME/Library/LaunchAgents/cloud.corelli.kraki.plist','w').write(p)
"
kraki stop && launchctl unload ~/Library/LaunchAgents/cloud.corelli.kraki.plist
launchctl load ~/Library/LaunchAgents/cloud.corelli.kraki.plist
```

2. **Or run the daemon directly** (simpler, doesn't survive reboot):
```bash
kraki stop
KRAKI_TRACE_PULSE=1 NODE_ENV=production LOG_LEVEL=debug HOME=$HOME \
  ~/.local/share/kraki/Kraki.app/Contents/MacOS/kraki __daemon-worker \
  >> ~/.kraki/logs/daemon.log 2>&1 &
```

Trace writes to `~/.kraki/logs/pulse-trace.log`. Key events: `SEND-OK`, `SEND-DECISION` (with `droppedReason`), `TX`, `RX`, `DELIVER`, `WS-TX`, `WS-RX`, `PUSH-PREVIEW-BUILD`.

### Arm/web logs via Playwright (transport-independent)

The arm/web logs do NOT depend on pulse to ship them — they're captured entirely in the browser via Playwright's `addInitScript` (WebSocket wrapper) + `exposeFunction` (out-of-band drain).

Three scripts in `scripts/`:

```bash
# Passive observation — connect and watch WS + pulse events for N seconds
pnpm exec tsx scripts/arm-prod-log.ts --duration 60

# Chat with an existing session
KRAKI_SESSION_ID=<id> pnpm exec tsx scripts/arm-prod-chat.ts --message "hello" --duration 60

# Create a NEW session (select agent + model via UI) and send a prompt
pnpm exec tsx scripts/arm-prod-newsession.ts
```

All scripts use a persistent browser profile at `.tmp/arm-pw-profile` (paired once via `kraki connect --json` token). The proxy is `socks5://127.0.0.1:1080` (hysteria).

Events captured: `WS-OPEN/CLOSE/ERROR/SEND/MESSAGE`, `PULSE-SEND/TX/RX/DELIVER/ACKED/CONNECTED/RESET-INBOUND`, `APP-DECRYPT/ENCRYPT-OK/SEND-ENCRYPTED/AGENT-MESSAGE/USER-MESSAGE-ECHO`, `CONSOLE`, `PAGEERROR`.

### Three-hop correlation

All three hops use the same `wallMs` (epoch ms) and `fp` (64-byte djb2 hash of the pulse payload) for cross-process correlation:

```
arm PULSE-SEND (seq=1, fp=76b406c4)
  → head HUB-DELIVER (from=arm, seq=1, fp=76b406c4)
  → head HUB-FORWARD (dests=[tentacle], fp=76b406c4)
  → head FWD-SEND (dest=tentacle, fp=76b406c4)
  → tentacle RX (seq=1741) → DELIVER → APP-DECRYPT
```

## Deploy Commands

### Edge relay (Tencent Cloud, China)

```bash
ssh corelli-tecent-cloud-small-0 'cat > /tmp/deploy-edge-relay.sh && chmod +x /tmp/deploy-edge-relay.sh && /tmp/deploy-edge-relay.sh <VERSION>' \
  < scripts/deploy-edge-relay.sh
```

### Main relay (AWS Tokyo, US)

```bash
ssh corelli-aws-tokyo-0
sudo npm install -g @kraki/head@<VERSION> --registry https://registry.npmjs.org
sudo systemctl restart kraki-relay
```

### Local tentacle

```bash
kraki stop
kraki update    # pulls latest from npm
kraki start
```

### Arm/web

Auto-deployed via CI when `main` passes. Manual deploy:
```bash
gh workflow run "Deploy Web" -f target=production
```

## SSH Hosts

| Host | Role | SSH alias |
|------|------|-----------|
| Tencent Cloud | Edge relay (China) | `corelli-tecent-cloud-small-0` |
| AWS Tokyo | Main relay (US) | `corelli-aws-tokyo-0` |
