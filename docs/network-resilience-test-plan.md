# Kraki Network Resilience: Test Plan (Production-Grade Goals)

Status: implemented (2026-09-28), branch `test/network-resilience`, based on main `985a310`. Results in section 9.
Scope: iOS / Mac clients ↔ Head, Tentacle ↔ Head. The web client reuses the same infrastructure as a second priority.

## 1. Goals: what "production-grade" means

Defined by measurable metrics, not by "it feels like it doesn't drop". Each item below must have a matching assertion in automated tests.

| # | Metric | Target |
|---|---|---|
| G1 | No lost messages | Input the user sees as "sent/sending" reaches the agent **100%** of the time once the network recovers |
| G2 | No duplicates | The agent receives each clientId **exactly once** (resends are deduplicated by clientId) |
| G3 | No false failures | Outages ≤ 60 seconds, saturated bandwidth, latency spikes: **0** "failed to send", no manual retry ever needed |
| G4 | Fast recovery | After the network recovers: reconnected ≤ 5 seconds (when the server becomes reachable again with no local network change, bounded by the probe interval); backlog send echoes p95 ≤ 5 seconds; missed new messages caught up p95 ≤ 5 seconds |
| G5 | Dead-link detection | A half-open connection (peer silently gone) is detected and reconnected within ≤ 30 seconds |
| G6 | No false kills | While the link is carrying data (however slowly), **0** heartbeat-timeout kills; one real outage produces exactly **1** reconnect |
| G7 | Order and completeness | After recovery, messages are shown in contiguous seq order: no holes, no reordering, no duplicate bubbles |
| G8 | Honest status | "Reconnecting" is shown only when truly disconnected ≥ 2 seconds; message status matches reality (delivered/queued/unconfirmed) |
| G9 | Bounded resources | During a long outage (2 hours), memory, disk and reconnect frequency are capped; no heat, no battery drain |
| G10 | Process restarts | After the app is killed, Head restarts or Tentacle restarts, input that was sent but unconfirmed is still delivered per G1/G2 |

Release gate: all T1 scenarios + 1000 random chaos iterations with 0 violations; all core T2 scenarios pass; T3 8-hour soak with 0 violations.

## 2. Current state: gaps visible in the code (to be proven by tests)

From reading main; each gets a test that "fails first, passes after the fix".

1. **No automatic retry** (matching the high send failure rate you observed). `CommandSender` marks a message "unconfirmed" if no echo arrives within 20 seconds after sending, and only a manual retry helps. Production diagnostics have shown echo delays of 13–52 seconds; with saturated bandwidth, 20 seconds is guaranteed to trigger.
2. **Mac silently does nothing when a send is refused.** `sendEncryptedMessage` returns false when it cannot get the agent device's public key (e.g. right after launch/reconnect before the device list arrives); the Mac composer does nothing while iOS shows a failure. It should queue instead of refusing.
3. **Input is not persisted on Head.** App→agent `send_input` is a non-persistent forward on Head: dropped if the agent is offline for more than 5 minutes, lost outright when Head restarts.
4. **The app-side Pulse send queue lives only in memory.** Unacknowledged frames are lost when the process is killed; the persistent outbox restores them as "unconfirmed" but does not resend automatically.
5. **Heartbeats misjudge under congestion.** Head pings every 30 seconds with a fixed window; when the link is saturated by bulk data the pong cannot get through and the connection is kicked as dead (the direct cause of this reconnect storm).
6. **Tentacle reconnects every 3 seconds, with no backoff or jitter.** When Head restarts, all agents reconnect at once (thundering herd); during long outages it makes a pointless attempt every 3 seconds.
7. **"Reconnecting" is not debounced.** Even momentary drops make it flash.

## 3. Test environment: fully isolated, never touches production

```
 ┌──────────── Test host (this machine / CI macOS runner) ───────────┐
 │                                                                    │
 │  Clients (under test)            Fault-injection proxy     Server  │
 │  ├ native headless driver (Swift) ──► ┌──────────────┐    ┌──────┐ │
 │  │  real WebSocketClient/             │  chaos-proxy │──► │ Head │ │
 │  │  PulseManager/CommandSender        │ (L4, scripted)│   │(local)│ │
 │  ├ iOS Simulator / Kraki Dev ───────► │ per connection│   └──┬───┘ │
 │  └ TS mock app (protocol level) ────► │ control HTTP  │      │     │
 │                                       └──────▲───────┘      │     │
 │  Tentacle (real daemon) ─────────────────────┘ another leg ─┘     │
 │     └ Pi CLI + local scripted fake model (no paid calls)          │
 └────────────────────────────────────────────────────────────────────┘
```

- **Everything local**: a local Head (separate SQLite), a separate `KRAKI_HOME`, freshly created test accounts/devices; never your Kraki account, never the cn/tokyo relays, never the production identity in the keychain (reusing the isolation of `scripts/test-native.sh`).
- **The agent is real Pi + a fake model**: reusing the approach of `pi087-live.integration.test.ts`, a local OpenAI-compatible service replies from a script (controlling how slow, how long, how long it streams, and whether it includes large attachments). Zero cost, repeatable.
- **Fault-injection proxy `chaos-proxy`** (new, Node, no sudo needed): sits between every client and Head, and between Tentacle and Head, programmable per connection:
  - latency + jitter; bandwidth cap (token bucket, reproducing 3 Mbps by default); one-direction throttling
  - blackhole (connection kept open, silent both ways = half-open); one-direction blackhole
  - immediate RST / FIN; disconnect after byte N; hang during handshake (TCP connected, TLS/HTTP upgrade never answered)
  - refuse new connections for N seconds (relay unreachable); switch on a schedule ("blips", "10 minutes of jitter")
  - a control-plane HTTP API + timeline log (exact timestamps of every fault event, for aligning assertions)
- **Real packet loss/reordering** (T3): a TCP proxy cannot drop individual packets, so use `tc netem` in a Linux container (loss, reordering, duplication, burst loss), plus macOS Network Link Conditioner presets for manual/nightly verification.

## 4. Observation and judgment: not by eye

Every run produces a timeline that automatically judges G1–G10:

- **Ledger reconciliation**: the driver records every send (clientId, send time, UI state changes); on the Tentacle side read `input-client-index.jsonl` and `messages.jsonl`; reconciling them yields losses / duplicates / echo latency.
- **Inbound completeness**: the fake model produces a known sequence of agent messages from its script; the client's final message list is compared one by one (contiguous seq, no duplicates, no holes).
- **Connection events**: Head logs (authentication/disconnect/stale), client `ws.state` (diagnostic events) and the proxy timeline are aligned to compute "reconnects per real fault", "dead-link detection time" and "false kills".
- **UI state** (T2): XCUITest reads bubble accessibility states and the connection indicator, recording when and for how long "failed/unconfirmed/reconnecting" appear.
- Automatically kept on failure: proxy timeline, logs from all three sides, diagnostic batches, xcresult.

## 5. Scenario matrix

Each scenario: fixed steps + an explicit expectation (mapped to G#). The two links (App↔Head, Tentacle↔Head) are faulted separately and together.

### A. Connection layer
| Scenario | Fault | Expectation |
|---|---|---|
| A1 Blip | RST, recovers after 1 second | 1 reconnect ≤3s; sends resent automatically; G1 G2 G3 |
| A2 Short outage | Refuse connections for 15 / 45 / 90 seconds | Messages show "queued" meanwhile and are delivered automatically after recovery; at 90 seconds the status may become "waiting for network" but never "failed" |
| A3 Half-open | Blackhole both ways without closing | Detected and reconnected within ≤30s (G5); messages sent meanwhile are not lost |
| A4 One-way blackhole | Downlink-only / uplink-only silence | Same as A3; never permanently stuck "can send but not receive" |
| A5 Handshake hang | TCP up, upgrade/authentication never answered | Retry after connect/auth timeout (existing 30s/90s), connections do not pile up |
| A6 Network switch | Old connection goes half-open + new one immediately available (Wi-Fi→cellular) | Use the new path immediately, without waiting for the old connection to time out; no duplicate messages |
| A7 Proxy flap | Local proxy (xray) restarts: all connections RST + 3 seconds of refusal | Same as A2 |
| A8 Long outage | 2 hours | Backoff cap applies, resources bounded (G9), everything delivered after recovery |

### B. Bandwidth and latency
| Scenario | Fault | Expectation |
|---|---|---|
| B1 Narrow link | 3 Mbps + a concurrent 10 MB attachment pull (reproducing this incident) | **0 false kills** (G6); chat messages still delivered within ≤ 5 seconds |
| B2 Latency spikes | RTT normally 50ms, random 5–20 second spikes | No reconnects, no failures; late echoes merged correctly |
| B3 High latency | Fixed 1.5 second RTT + jitter (satellite/cross-border) | Everything works |
| B4 Very narrow link | 64 kbps (2G) | Small messages usable, heartbeats not misjudged |
| B5 Packet loss (netem) | 1% / 5% / 20% bursts | TCP retransmits on its own; no false errors at the application layer |

### C. Send path (optimistic sending)
| Scenario | Action | Expectation |
|---|---|---|
| C1 Sending while offline | Send 5 messages in a row while disconnected | Bubbles appear immediately (queued), delivered in order after recovery, once each |
| C2 Disconnect at send time | RST after the frame is written, before the ACK | Automatically resent with the same clientId, deduplicated by the agent, exactly once |
| C3 Lost echo | Agent received it, the echo is cut on the way back | The echo arrives after reconnecting, the bubble becomes delivered, no duplicate |
| C4 Slow echo | Echo delayed 30 / 60 seconds (saturated bandwidth) | No failure shown; status stays "sending/delivered to server" |
| C5 Device list not ready when sending | Send right after launch/reconnect | Queued, not silently dropped (fixes gap 2) |
| C6 App killed | Kill the process after sending, before the ACK, then restart | Resent automatically, exactly once (G10) |
| C7 Answers / permissions / abort | Each performed while offline | Same as C1, with answerTo/permission semantics unchanged, and stale answers never misdelivered |
| C8 Outage during voice correction | Network drops while correcting | Queued and sent after correction finishes, not lost |

### D. Receive path
| Scenario | Action | Expectation |
|---|---|---|
| D1 Outage while streaming | 30 second outage while the agent is streaming | After recovery the status card and final message are correct, with no duplicates or missing parts (G7) |
| D2 Agent completes several turns while offline | 2 minute outage, the agent produces 20 messages | Caught up after recovery, in order, within ≤ 5 seconds |
| D3 Background/foreground (iOS) | 10 minutes in the background with new messages arriving | Caught up after returning to the foreground; push notifications match the messages |
| D4 Multiple devices | Mac + iOS together, one of them offline | The other is unaffected; the recovered one catches up |

### E. Server and agent side
| Scenario | Action | Expectation |
|---|---|---|
| E1 Head restart | Restart Head while sends are in flight | Clients/agents reconnect with backoff (no thundering herd); unconfirmed input is eventually delivered (fixes gap 3) |
| E2 Tentacle ↔ Head down | Agent link down for 30 seconds / 6 minutes | App sends show "agent offline, will deliver later" and are delivered after recovery; not lost at 6 minutes because of Head cleanup |
| E3 Tentacle restart | Restart the daemon | No lost or duplicated input; sessions restored |
| E4 Both sides flapping | Independent random faults on the client and agent links | G1–G7 all hold |

### F. Random chaos (the core of T1)
A seeded random fault schedule (combining the fault types above by distribution) running a fixed workload (one input every 3 seconds, streaming agent replies, occasional attachments), 5 minutes per iteration, **1000 iterations with 0 violations**; failures report a reproducible seed.

## 6. Layered implementation

| Layer | Content | Frequency |
|---|---|---|
| T0 Unit | Retry state machine, backoff, heartbeat judgment (fake clock); add "lost ACK / duplicate / reorder" combinations to the Pulse endpoint property tests | Every CI run |
| T1 Protocol-level chaos | Local Head + real Tentacle (Pi + fake model) + TS mock app + chaos-proxy; protocol versions of scenarios A–E + random F | Every CI run (reduced set) / nightly (1000 iterations) |
| T2 Native clients | Headless Swift driver (extending the existing `ReliabilityLoopback`, connected to a real Head instead of a mock peer) running A–D; XCUITest on iOS Simulator + Kraki Dev verifying UI state (G8) | Client PRs / nightly |
| T3 Real network soak | netem in a Linux container (loss/reordering); Network Link Conditioner presets; 8-hour random soak; replay of this incident's profile (3 Mbps + large attachment) | Before release |
| T4 Production observation | Diagnostics dashboard: reconnects per device per hour, echo latency distribution, unconfirmed ratio; used as post-release acceptance | Continuous |

## 7. Implementation order

1. **Build the environment** (1): chaos-proxy + control plane; one-command local stack (Head + Tentacle + fake model); reconciler.
2. **Measure the baseline first** (2): run A–E on unmodified main to get "red" evidence and numbers for every gap (false kills, loss rate, false failure rate).
3. **Fix gap by gap** (3): priority ① automatic retry + relaxed/tiered echo timeouts ② queue sends instead of refusing ③ heartbeats never kill while data is flowing ④ Head persists `send_input` ⑤ Tentacle backoff + jitter ⑥ status debouncing ⑦ persist the app-side send queue. Each fix is accepted when its scenario turns from red to green.
4. **Wire into CI** (4): the reduced set becomes a PR gate (triggered by change scope, following the existing `test-scope`); the 1000-iteration chaos run and the soak run nightly/before release, triggered manually, not on every gate.

## 8. Constraints

- Never connect to production relays, never use your account or keychain identity, no paid model calls, no microphone access.
- Never modify the client you are using or the local daemon; the test stack uses separate ports and `KRAKI_HOME`.
- This branch contains only test infrastructure and the plan; every product fix gets its own PR with red-to-green scenario evidence.


## 9. Results (2026-09-28)

The test infrastructure (section 3) is in place:
- `packages/tests/src/chaos/`: fault-injection proxy, local service stack (real Head, real Tentacle, with a deterministic scripted adapter as the agent, zero cost), control plane.
- `KrakiMacTests/NetworkResilienceTests.swift`: runs 21 scenarios on the production networking stack (AppState/WebSocket/Pulse/CommandSender).
- `scripts/chaos/run-native.sh`: runs everything with one command, outputting per-scenario metrics JSON and timelines.

Deviation from the plan: the agent is a scripted adapter rather than real Pi with a fake model. The network path (RelayClient, SessionManager, Head) is entirely real, which is more deterministic and faster.

### Baseline (main 985a310) → after the fixes

| Scenario | Baseline | After |
|---|---|---|
| A2 45 s outage | Reconnected 16 s after the network recovered | 0.7 s |
| A3 Half-open | Detected at 25 s, but "unconfirmed" already shown at 20 s | Detected at 25.6 s, no false error |
| A4 Uplink-only outage | — (new scenario) 57 s, kicked by Head | 25.7 s |
| B1 Incident replay (3 Mbps + old clients pulling 2 MB whole) | 4 false kills, 3 messages unconfirmed for 90 s | 0 reconnects, echo p95 0.88 s |
| B1b 0.32 Mbps continuously saturated | False kills, "unconfirmed" shown | 0 reconnects, max delivery gap 6.8 s |
| B2 20 s latency spike | 1 false kill | 0 reconnects |
| C6 App killed after sending, then relaunched | Message lost | Delivered in 1.1 s |
| A8 3 min outage | — | About one attempt every 4 s for the first 2 min, then about every 15 s (4 in the last minute) |
| E2b Agent offline 6 min (beyond Head's 5 min cleanup) | — | Delivered within 21 s after recovery |
| F Random chaos (20 rounds) | — | 0 lost, 0 duplicated, 0 false errors |

All 21 scenarios pass (after merging the latest main, 20 rounds of random chaos each with seeds 329 and 4242): `docs/network-resilience-results/`; raw baseline output: `baseline-main-985a310.txt`.

### Fixes (each has a scenario that went from red to green, plus unit tests)

1. **Pulse (`@coinfra/pulse` 0.5.1 + vendored Swift)**: while the peer's cursor is advancing, in-flight data is no longer treated as lost and resent wholesale. This was the amplifier of reconnect storms under congestion: in the endpoint model the old implementation resent 120 frames within 45 s, the new one 0.
2. **Head**: when a pong is late, if the client has sent frames since the ping, or the send buffer is shrinking, the link is not judged dead and `device_pending` is not broadcast.
3. **Client connection**: only a pong can settle the ping we sent (fixing undetected uplink-only outages); under congestion, wait up to 300 s as long as real data is still being delivered; ping timeout 22 s, check interval 2 s; reconnect backoff starts at 0.5 s, capped at 4 s for the first 2 min, then 15 s, 30 s after 10 min, ±20% jitter; a Pulse stream "starved" by its sibling stream is tolerated up to 300 s.
4. **Client sending**: automatic resend (same `clientId`) after reconnecting, after the agent comes back online and after restart; transient transport refusals queue instead of being silently dropped; "unconfirmed" is timed only as "link up but no data delivered at all for 30 s", with one silent resend at the halfway point.
5. **Tentacle**: input already accepted in the same process (queued or running) is not dispatched again when retried; a duplicate input echoes the stored `user_message` back to the requester; reconnects use exponential backoff with jitter (1 s → 30 s), reset only after successful authentication; `idempotent_input` is declared in `device_greeting.features`.
   - Compatibility: clients only auto-resend already-sent input to Tentacles that declare `idempotent_input` (an old Tentacle that receives a retry while the input is queued may run it twice); input that was never sent can always be sent.
6. **UI**: "Reconnecting" appears after a 2 s delay (`AppState.showsReconnecting`), so momentary drops do not flash.

### Target adjustments (recorded honestly)

- G4 changed from "≤3 s" to "≤5 s": when the server becomes reachable again with no local network change, it is bounded by the probe interval, worst case about 4.8 s (4 s cap plus 20% jitter). Measured repeatedly at 0.3–3.9 s. Immediate reconnect on system network changes (NWPathMonitor) is not implemented yet; only then can it get to about a second.
- Tail loss (within a connection, with the sender idle afterwards): the fix takes 2 heartbeat cycles (≤30 s) instead of 1. This trade-off avoids false resends under congestion.

### Not yet covered / known limitations

- ~~URLSession's WebSocket exposes no byte-level progress, so a single very large frame is judged a dead link~~: solved by message fragmentation in section 10.
- With the uplink down but data still flowing downlink, the client waits up to 300 s; Head disconnects within about 60 s in this case.
- ~~D3 iOS background/foreground, D4 multiple devices~~: see section 11. Not done: T3 netem packet-level loss/reordering and the 8 h soak, the web client, protocol-level chaos with the TS mock app.
- ~~Head's `better-sqlite3` 11.x hits a native assertion crash when finalizing statements on newer Node 24 (24.20/24.21, on both macOS and Linux)~~: Head was upgraded to 13.0.3 in the section 10 changes (matching the `tests` package; ships linux/darwin prebuilt binaries, requires Node ≥ 22).
- coinfra's push release fails because crypto/payments have no trusted publishing configured (pre-existing); `@coinfra/pulse` 0.5.1 was published through a newly added separate release entry point.

### CI

- PR: `Network resilience (fast)`, about 10 scenarios plus a service-stack smoke test, triggered by the `resilience` scope (Swift client, Head, Tentacle, crypto, protocol, tests, scripts/chaos).
- Nightly and manual: `network-resilience.yml` runs all 21 scenarios plus random chaos (50 rounds by default, seeded with the run number, reproducible).


## 10. Large-message fragmentation (2026-09-29)

Problem: a native WebSocket exposes no "currently receiving" byte progress, so a large message must be received whole. At 0.32 Mbit/s a message of about 1 MB takes more than 45 s, while the client judges the link dead at 22 s and reconnects, then starts over, and it never finishes.

Baseline (main 65f64cd): G1 1 MB downlink not delivered within 120 s, 4 ping-timeout reconnects; G2 uploading an image of about 700 KB made the test process exit abnormally. Raw output in `network-resilience-results/fragments-baseline-main.txt`.

Approach (only one small Head change, no new Pulse version needed):
- **Fragmentation** (`fragments.ts` in `@kraki/protocol`, `PayloadFragments.swift` on the Swift side): ASCII payloads over 64 KB are split into 32 KB fragments, each an independent Pulse message; the receiver reassembles by id with bounded memory (48 MB, 10 minute expiry), cleared when the peer restarts. Head forwards them transparently as usual.
- **Negotiation**: Tentacle declares `fragments` in its greeting, and the app replies with `client_features` to say it can reassemble. Tentacle only sends fragments to apps that declared it (others still get whole messages); the app likewise only sends fragments to Tentacles that declared `fragments`. Large coalescable messages are fragmented too, but fragments carry no coalescing key.
- **Upload flow control**: fragmentation alone is not enough, because the system send buffer is large and the app's own ping would queue behind the whole upload. So the app keeps at most 100 KB unacknowledged by the relay at a time; later messages stay in order in the queue.
- **Timely relay acknowledgement**: a Pulse receiver normally acknowledges only when it sends data itself or on the 15 s idle heartbeat. Head now replies with a heartbeat frame carrying the current cursor for every 64 KB received, and declares `pulseAckBytes` in `auth_ok`. Only devices that declared `pulseProgressAck` at authentication receive these heartbeats: older Pulse versions resend everything when they see a lagging cursor. The app only enables flow control when Head declares the capability; with an old Head it still sends all fragments at once.

Result: G1 zero reconnects, delivered in about 87 s (close to the link limit); G2 zero reconnects, round trip about 86 s; all 23 scenarios pass (seed 777, 20 rounds of random chaos): `network-resilience-results/fragments-full-matrix-seed777.txt`.

Also: the Head test process repeatedly crashed on exit in CI (a finalization bug in better-sqlite3 11.x + Node 24.21; the crash site varies with the in-process object layout). Head's `better-sqlite3` was upgraded to 13.0.3, which also removes a production risk. When the new Head is deployed, the server uses the bundled prebuilt binary.

Known limitation: head-of-line blocking on a single TCP connection. At 0.32 Mbit/s, chat echoes sent during a large message transfer only arrive after that message (about 87 s in G1). Improving this needs the relay to prioritize the live stream over bulk data when sending; future work.


## 11. Multiple devices and background/foreground (2026-09-29)

New scenarios (a second app link `app2`, controlled by its own fault proxy):
- **D3 Background/foreground**: go to the background right after sending (deliberately closing the connection), the agent keeps replying meanwhile, and return to the foreground after 20 s.
  - Baseline: reconnected in 0.05 s, but the UI still flashed "Reconnecting". The cause: during the deliberate background disconnect, the 2 s debounce timer still fired. This is very likely one source of users seeing "Reconnecting every so often": iOS flashed it every time it returned to the foreground.
  - Fix: no "Reconnecting" while `AppState.isInBackground`, and the 2 s timer restarts on returning to the foreground. After the fix it no longer flashes, messages are delivered exactly once, catch-up < 0.01 s.
- **D4 One device offline**: B is offline for 30 s while A keeps chatting, zero reconnects, echo p95 0.17 s. Within 1.0 s after recovering, B catches up on A's messages and the agent's replies, with no duplicate rows.
- **D4 Both send, one link flapping repeatedly**: all input from both devices is delivered exactly once, and both devices end with identical conversations.

The Simulator / Mac test host covers the app's own background/foreground logic. Real-device behavior such as long system suspension and background push wake-ups cannot be tested here and still needs on-device spot checks.

## 12. Web client (2026-09-29)

How it runs: the real built web client (headless Chromium, Playwright), against the same local fault stack (Head, real Tentacle, fault proxy).
- Script: `scripts/chaos/run-web.sh`
- Config: `playwright.resilience.config.ts`
- Specs: `e2e/resilience/network.spec.ts`
- CI: a new Linux job "Network resilience (web)", run when web, protocol, Tentacle, Head or the fault stack change, about 5 minutes.

Scenarios and results below. "Before" is the behavior of main 4e6ca01; raw data in `network-resilience-results/web-baseline-vs-fix.md`.

| Scenario | Before | After |
|---|---|---|
| W0 Healthy | Pass | Pass |
| W1 Blip (1 RST) | Flashed "Reconnecting…" | Recovered in 0.8 s, no flash |
| W2 60 s outage | Gave up after 5 reconnects (about 31 s) and showed a full-screen "Disconnected / Connect now" that required a manual click | Reconnects automatically forever, delivered within 3–5 s after recovery, no modal |
| W3 Half-open connection | Dead link detected only after 35–52 s; the message was wrongly marked "Not delivered" though it was actually delivered | Dead link detected at 23.5 s; no false mark |
| W4 1 MB message, 0.32 Mbit/s | Echo queued behind the large message, falsely marked "Not delivered" at 20 s | 0 reconnects; delivered in 87 s; no false mark |
| W5 Page reload with unconfirmed messages | After reload the message was marked failed, never delivered, manual retry only | Resent automatically (same clientId), delivered exactly once |

Fixes (web client only; protocol and server unchanged):
- **Transport (`transport.ts`)**
  - Never give up reconnecting. Backoff matches native: doubling from 0.5 s for the first 2 minutes, capped at 4 s; every 15 s until 5 minutes; every 30 s after that; ±20% jitter.
  - Backoff resets only after successful authentication, so a relay that accepts and immediately drops connections is not hammered every 0.5 s.
  - Reconnect immediately when the browser fires `online` or the page returns to the foreground.
  - An authenticated connection that receives no frame for 22 s is judged dead and dropped (a ping is sent every 10 s).
  - 10 s handshake timeout.
- **UI**
  - "Reconnecting…" only after more than 2 s disconnected (`useShowsReconnecting`).
  - After connecting once, the full-screen blocking modal never appears again. "Connect now" is still shown when the first connection fails.
- **Large-message fragmentation**: the web client can reassemble `kfrag` fragments and replies with `client_features` when Tentacle declares `fragments`. Frames then keep arriving on slow links, so the 22 s dead-link check does not fire falsely.
- **Pending messages (outbox)**
  - The confirmation timer only counts time when "the link is alive and genuinely stalled", capped at 30 s. It does not count while the link seems dead (no frame for 12 s) or while data is still arriving (the echo may be queued behind it). (Note: the first implementation in #334 did not actually achieve this; see the soak findings in §13.)
  - Messages restored after a page reload, and messages still unconfirmed when Tentacle sends a new greeting, are marked for resending.
    - Tentacle declares `idempotent_input`: resent automatically with the same clientId (Tentacle deduplicates).
    - Older Tentacles: messages restored after reload are marked "Not delivered" and left to the user; messages still in flight wait for their echo as usual and are not marked failed just because Tentacle greeted again.

Not yet covered:
- Private browsing, Safari and Firefox.
- A Service Worker offline page.
- Mobile browsers being suspended by the system.

## 13. Packet-level faults and long soaks (CI, 2026-09-29)

- No sudo locally. Packet-level faults run only on GitHub's Linux runner: `scripts/chaos/netem.sh` applies `tc netem` to the loopback interface, filtered by port so only the corresponding fault links are affected (App link, Tentacle link, both directions).
- To make loss closer to real networks, the MTU is set to 1500 and TSO/GSO/GRO are disabled; otherwise one "packet" is a whole WebSocket frame.
- Specs live in `e2e/resilience/netem.spec.ts`. The PR web job runs W0–W5, N1–N4 and one 5-minute soak. The nightly `network-resilience.yml` job (web-soak) runs a 30-minute soak.

| Scenario | Fault | Result (CI) |
|---|---|---|
| N1 Mobile network | 60 ms ±30 ms latency, 3% loss, 5% reordering | Echo p95 0.35 s, 0 reconnects |
| N2 Loss burst | 30% loss for 40 s while sending continues | Everything delivered exactly once, p95 17 s, no false marks |
| N3 Loss on both links plus a 300 KB reply | App: 100 ms, 2%; Tentacle: 150 ms, 2% | 0 reconnects, no false marks; p50 fluctuates between 0.7–22 s (see below) |
| N4 Very poor link | 300 ms ±100 ms latency, 10% loss | p95 1.8 s, 0 reconnects |
| S1 Seeded random soak | Link resets, 5–35 s blackholes, 5–60 s outages, throttling, netem profiles, large agent messages, page reloads | 5 minutes: all 69 messages delivered exactly once, never falsely marked, JS heap bounded |

Notes:
- The kernel does not allow `duplicate` with multiple netems in the tree. TCP drops duplicate segments before the application layer, so coverage is unaffected.
- N3's fluctuation comes from the known head-of-line blocking: the echo queues behind the 300 KB reply, which crawls through TCP retransmission over two lossy links. It causes no misjudgments or lost messages, only slower confirmation. Later we could route large agent output over the bulk stream so it does not block chat echoes.
- The soak is seeded (`CHAOS_SEED`, defaulting to the run number) so failures can be reproduced: `KRAKI_SOAK_MINUTES=30 CHAOS_SEED=<n>`. Without netem locally, only proxy-level faults are injected.

### 13.1 Problems found by the soak and fixed

The first few 5-minute soaks (seeds 1300, 2001, 2003) produced false "Not delivered" marks, and one of them **actually lost 9 messages**. After locating each one, the fixes are below, each with a red-then-green test:

1. **The web confirmation timer "checked at the deadline" instead of accumulating** (seed 1300)
   - Symptom: a message was sent into a 26 s blackhole; 3 s after reconnecting the backlog was still catching up when the 30 s deadline hit, and the link "happened" to look healthy, so it was marked failed.
   - Fix: like native, accumulate "stall time" second by second, counting only while the link is alive, the device is online and no data is arriving. Each step counts at most 2 s, so a throttled background-tab timer cannot jump a whole minute at once. At the halfway point, resend once silently to Tentacles that support `idempotent_input`.
   - Tests: 4 new cases in `outbox.test.ts`, including the exact timing of seed 1300; 3 of them fail on the old implementation.
2. **The web "link busy" window was 3 s, native's is 30 s**
   - Symptom: on lossy links, TCP retransmission backoff alone creates gaps of a few seconds, so the web timer started accumulating much earlier than native.
   - Fix: web uses 30 s too. Two things were also separated: "busy" only pauses the failure timer and no longer delays resending. Otherwise messages restored after a reload waited 30 s before being sent, regressing W5 from 0.3 s to 30 s; after separating them W5 is back to 0.26 s.
3. **Tentacle's broadcast greeting after reconnecting lacked `features`** (seed 2003: 9 lost). This was the root cause.
   - Symptom: Tentacle has two greetings. The unicast greeting when an app joins carried `features`, but the broadcast greeting after each Tentacle reconnect did not. On receiving the broadcast, clients concluded the Tentacle neither deduplicated nor supported fragments, so:
     - unconfirmed messages were no longer resent automatically;
     - messages restored after a reload were judged failed and never sent;
     - a Tentacle reconnect cleared the features each app had declared, and clients only re-declare when they see `fragments`, so fragments were no longer sent afterwards.
   - Fix:
     - Tentacle: both greetings share the same payload.
     - Web and native: when a greeting has no `features` field, keep the features already known (only a device never seen with features is treated as old). When a Tentacle device rejoins, web also re-declares `client_features` (native already did).
   - Tests:
     - New scenario W6 (reload with unconfirmed messages, followed by a Tentacle reconnect). Reliably reproduced message loss on main; passes with only the web fix and Tentacle behaving like the released version; passes with both fixed.
     - One unit test each for Tentacle, web and native, all failing on the old code.
   - Release status: the Tentacle problem had already shipped in CLI v0.33.4, but no released client reads `features` yet, so no users are currently affected. This fix must ship before any native or web release with the #329/#334 client changes.
4. **A problem in the test script itself**: when a fault action could not run (another fault already in progress), it fell through to a "large agent message", so large messages took about 15% of the steps (about 6 MB in 5 minutes) instead of the designed ~3%. Actions are now chosen by weight, idling when not applicable.

After the fixes, all 6 new seeds (2000–2005) pass: no false marks, exactly-once delivery, JS heap ≤ 12 MB. Median echo about 0.3 s; the p95 comes mostly from messages sent during outages and blackholes.

New scenario N5: 15% loss on the Tentacle link while the agent outputs about 1.2 MB. Regression only: it also passes with the old 3 s window, because data keeps arriving intermittently.

### 13.2 Findings from the first 30-minute nightly soak (2026-09-29)

1. **Test script deadlock (test-only change)**
   - Symptom: during an outage the page never saw the turn end, so the composer stayed in "Steer the agent…" mode, while the script only looked for the "Send a message…" composer and waited forever, never reaching the "restore network" step.
   - A side problem before the fix: in the 5-minute soaks every send actually waited for the agent to go idle, so the "steer while a reply is in progress" path was never tested.
   - Fix: the script types into the composer in any mode, with a wait cap.
   - New scenario W7: steering while the agent is replying.
2. **Web input messages lacked the sender `deviceId`** (with trace data: 4 in seed 4245, 14 in the first 30-minute soak)
   - Background: Head forwards end-to-end encrypted payloads as-is, so Tentacle can only learn the sender from inside the payload. Native clients write their own `deviceId` into every message; web only did so in a few message types.
   - Symptom: when the link recovered, the withheld input and the close of the old connection arrived at the same time. Tentacle ran the input, but the page was considered offline then, so the echo was not sent to it. The page then resent, Tentacle correctly recognized the duplicate but could not echo it, because the sender was `undefined`, so it returned silently. These inputs stayed "unconfirmed" and were finally marked "Not delivered" during a quiet period, although the agent had received them long before.
   - Fix:
     - Web: `sendEncrypted` always writes its own `deviceId`. This also works with released Tentacles.
     - Tentacle: every early return in `reechoInput` logs its reason (e.g. `no_consumer_key`) instead of failing silently. That log is what located this problem.
   - Tests:
     - Unit test: every consumer message carries the sender; fails on the old code.
     - W9 (echo lost on the way back): asserts every input recognized as a duplicate is echoed successfully. The old code failed both runs (2 echo failures each); 0 after the fix.
     - W8: input sent while the link is dead, with Tentacle reconnecting at the same time.
3. **Diagnostics**
   - The soak enables web input-chain tracing and fetches it periodically; Tentacle's input trace (`KRAKI_TRACE_PULSE`) and logs are uploaded as CI artifacts.
   - The nightly job can set the soak duration and repeat count, and can replay the same seed with `soak_seed_step=0`.

Results after the fixes:
- 30-minute soak (seed 4242): all 407 messages delivered exactly once, never falsely marked. Median echo 0.18 s, p95 1.7 s; JS heap 8 → 12 MB; 103 duplicate-input echoes, 0 failures.
- 4 more 10-minute seeds (5000–5003): all pass, 105 echoes, 0 failures.


### 13.3 Removing web network resilience tests (2026-09-30)
The web client is now legacy and gets no more resources: removed the "Network resilience (web)" PR check, the nightly web-soak job, `scripts/chaos/run-web.sh`, `netem.sh` and `e2e/resilience/`. Web keeps only unit tests and the build check. The fixes already merged in §12–13.2 remain in effect; of these, Tentacle greetings carrying `features` and native "keep known features when the field is missing" are still required by the native clients.
