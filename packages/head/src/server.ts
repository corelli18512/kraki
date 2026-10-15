import { WebSocketServer, WebSocket } from 'ws';
import { metrics } from './metrics.js';
import type { IncomingMessage as HttpIncomingMessage } from 'http';
import type { Server } from 'http';
import type { AuthMessage, VoiceCapability, BlobPayload } from '@kraki/protocol';
import { HEAD_PULSE_TARGET } from '@kraki/protocol';
import { Storage } from './storage.js';
import { PulseHub } from './pulse-hub.js';
import { LocalAuthBackend } from './local-auth-backend.js';
import { getLogger } from './logger.js';
import { trace, fp } from './trace.js';
import { clientIp } from './client-ip.js';
import type { AuthBackend } from './auth-backend.js';
import { handleControlMessage, firePushPreview } from './server/account-control.js';
import { handleAuth, handleChallengeResponse, handleCreatePairingToken, handleRequestPairingToken } from './server/auth-flow.js';
import { broadcastDeviceJoined, broadcastDeviceLeft, broadcastDevicePending } from './server/presence.js';
import { handleRequestVoiceLease } from './server/voice-lease.js';
import { type ClientState, type HeadServerOptions, DEFAULT_MAX_PAYLOAD, DEFAULT_AUTH_TIMEOUT_MS, DEFAULT_LOGIN_SCREEN_AUTH_TIMEOUT_MS, MAX_MULTICAST_TARGETS, MAX_WS_BUFFERED_BYTES, LIVENESS_SWEEP_INTERVAL_MS, PONG_GRACE_MS, isValidMessage, isValidAuth } from './server/shared.js';
export type { HeadServerOptions } from './server/shared.js';

export class HeadServer {
  private wss: WebSocketServer;
  storage: Storage;
  options: HeadServerOptions;

  private static readonly PING_INTERVAL = 30_000;

  // In-memory state
  connections = new Map<string, WebSocket>();
  authBackend: AuthBackend;
  userByDevice = new Map<string, string>();
  clients = new Map<WebSocket, ClientState>();
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private livenessTimer: ReturnType<typeof setInterval> | null = null;
  /** Per-hop pulse hub — the reliable-delivery layer for every connection. */
  pulseHub!: PulseHub;
  private pulseTickTimer: ReturnType<typeof setInterval> | null = null;

  constructor(storage: Storage, options: HeadServerOptions) {
    this.storage = storage;
    this.options = options;
    // One auth implementation for every deployment: without an explicit
    // backend (standalone tests, self-hosted defaults) the server builds the
    // same LocalAuthBackend production uses from its providers.
    this.authBackend = options.authBackend ?? new LocalAuthBackend({
      storage,
      // A single `authProvider` answers every token method, as it always has.
      authProviders: options.authProviders
        ?? (options.authProvider
          ? new Map(['open', 'apikey', 'github'].map((method) => [method, options.authProvider!]))
          : new Map()),
      pairingEnabled: options.pairingEnabled,
      pairingTtl: options.pairingTtl,
      pushManager: options.pushManager,
      region: options.region,
    });
    this.wss = new WebSocketServer({
      noServer: true,
      maxPayload: options.maxPayload ?? DEFAULT_MAX_PAYLOAD,
    });
    this.wss.on('connection', (ws, req) => this.onConnection(ws, req));
    this.startPingInterval();
    this.startLivenessSweep();

    // Pulse per-hop reliable delivery. Shares the Storage SQLite file.
    this.pulseHub = new PulseHub(this.storage.rawDb, {
      now: () => Date.now(),
      sendPulseTo: (deviceId, pulseB64) => this.sendPulseFrameTo(deviceId, pulseB64),
      acceptsProgressAck: (deviceId) => {
        const ws = this.connections.get(deviceId);
        return ws ? this.clients.get(ws)?.pulseProgressAck === true : false;
      },
      broadcastTargets: (fromDevice) => this.pulseBroadcastTargets(fromDevice),
      onDeliverToSelf: (fromDevice, payload) => this.deliverPulseToSelf(fromDevice, payload),
    });
    this.pulseHub.recoverOnBoot();
    // Drive pulse heartbeat/liveness/durable-expiry every 5s.
    this.pulseTickTimer = setInterval(() => this.pulseHub.tick(), 5_000);
  }

  private startPingInterval(): void {
    this.pingTimer = setInterval(() => {
      const now = Date.now();
      for (const [deviceId, ws] of this.connections) {
        const state = this.clients.get(ws);
        if (state && !state.isAlive && this.linkProgressing(ws, state)) {
          // The pong is queued behind our own backlog (a congested downlink)
          // or the client is actively sending: slow, not dead.
          getLogger().debug('Pong late but link is progressing', { deviceId, bufferedAmount: ws.bufferedAmount });
          state.isAlive = true;
        }
        if (state && !state.isAlive) {
          // Missed last pong — connection is dead. Log diagnostic timing so
          // post-mortems can tell network drop from event-loop block.
          metrics().inc('conn.pongTimeout');
          getLogger().info('Terminating stale connection (no pong)', {
            deviceId,
            msSincePingSent: state.lastPingSentAt ? now - state.lastPingSentAt : null,
            msSinceLastPong: state.lastPongRecvAt ? now - state.lastPongRecvAt : null,
            wsReadyState: ws.readyState,
          });
          this.removeConnection(deviceId);
          continue;
        }
        if (state) state.isAlive = false;
        try {
          if (ws.readyState === WebSocket.OPEN) {
            ws.ping(); // protocol-level ping (browsers auto-respond)
            // JSON ping for proxy keepalive.
            ws.send(JSON.stringify({ type: 'ping' }));
            if (state) {
              state.pongOverdueAt = now + PONG_GRACE_MS;
              state.pendingLivenessBroadcast = false;
              state.lastPingSentAt = now;
              state.bufferedAtPing = ws.bufferedAmount;
            }
            getLogger().debug('Sent ping', {
              deviceId,
              msSinceLastPong: state?.lastPongRecvAt ? now - state.lastPongRecvAt : null,
            });
          }
        } catch (err) {
          getLogger().warn('Ping send failed', {
            deviceId,
            error: (err as Error)?.message,
          });
          this.removeConnection(deviceId);
        }
      }

      // Sweep expired pairing tokens
      this.authBackend.sweepPairingTokens?.();
      try { this.storage.pruneForegroundActivity(); }
      catch { logger.warn('Failed to prune foreground usage counters'); }

      // Periodic health snapshot — ALWAYS on (not trace-gated). Cheap (one line
      // / 30s) and is the canary for the OOM / event-loop-stall class of bugs
      // that recurred across the pulse PRs. rss/heap from process.memoryUsage;
      // endpointCount + durable-row total reflect the pulse-hub memory state.
      const mem = process.memoryUsage();
      let durableRows = 0;
      try {
        durableRows = (this.storage.rawDb.prepare('SELECT COUNT(*) AS n FROM pulse_outbox').get() as { n: number }).n;
      } catch { /* table may not exist yet */ }
      const metricsNow = metrics();
      metricsNow.lastHealthAt = Date.now();
      const loop = metricsNow.takeLoopDelay();
      getLogger().info('health', {
        conns: this.connections.size,
        endpoints: this.pulseHub.endpointCount(),
        durableRows,
        rssMb: Math.round(mem.rss / 1048576),
        heapUsedMb: Math.round(mem.heapUsed / 1048576),
        heapTotalMb: Math.round(mem.heapTotal / 1048576),
        evlLagMs: loop?.p99Ms,
        evlMaxMs: loop?.maxMs,
      });
    }, HeadServer.PING_INTERVAL);
  }

  // ── Liveness sweep ───────────────────────────────────────

  /** Run the liveness sweep at a fixed cadence, independent of the slower
   *  30s ping timer. Broadcasts device_pending when a peer's pong is overdue
   *  so other devices see the "maybe offline" state quickly. */
  private startLivenessSweep(): void {
    this.livenessTimer = setInterval(() => {
      this.runLivenessSweep();
    }, LIVENESS_SWEEP_INTERVAL_MS);
  }

  /** Broadcast device_pending for any authenticated connection whose pong has
   *  gone overdue (and we haven't already broadcast for this ping cycle). */
  private runLivenessSweep(): void {
    const now = Date.now();
    for (const [deviceId, ws] of this.connections) {
      const state = this.clients.get(ws);
      if (!state?.authenticated || !state.userId) continue;
      if (state.pongOverdueAt === null) continue;
      if (state.pendingLivenessBroadcast) continue;
      if (now <= state.pongOverdueAt) continue;
      if (this.linkProgressing(ws, state)) continue;

      state.pendingLivenessBroadcast = true;
      getLogger().debug('Broadcasting device_pending (pong overdue)', { deviceId });
      broadcastDevicePending(this, state.userId, deviceId);
    }
  }

  /** A missing pong alone does not prove a dead link: when the downlink is
   *  congested the pong answers a ping that is still queued behind our own
   *  backlog. The link is alive if the client sent anything since the ping,
   *  or if our send buffer is draining. */
  private linkProgressing(ws: WebSocket, state: ClientState): boolean {
    if (state.lastPingSentAt === undefined) return false;
    if ((state.lastInboundAt ?? 0) > state.lastPingSentAt) return true;
    return state.bufferedAtPing !== undefined && state.bufferedAtPing > 0 && ws.bufferedAmount < state.bufferedAtPing;
  }

  /** Test hook: force a liveness sweep without waiting for the timer. */
  forceLivenessSweep(): void {
    this.runLivenessSweep();
  }

  // ── End liveness sweep ──────────────────────────────────

  // --- Auth provider helpers ---

  getVapidPublicKey(): string | undefined {
    return this.options.pushManager?.getVapidPublicKey();
  }

  /**
   * Build the voice capability advertisement for `auth_ok` from this head's
   * config. Returns `undefined` (omit the field) when no broker URL is
   * configured for this region.
   *
   * Note: the per-region nature falls out for free in edge mode — the edge's
   * own `voiceBrokerUrl` config drives this, never main's. So Beijing edge
   * advertises Beijing's broker, and US main advertises nothing, all from a
   * single helper.
   */
  getVoiceCapability(): VoiceCapability | undefined {
    const url = this.options.voiceBrokerUrl;
    if (!url) return undefined;
    return { brokerUrl: url, resource: 'voice/doubao' };
  }

  // --- Connection management ---

  attach(server: Server): void {
    server.on('upgrade', (req, socket, head) => {
      this.wss.handleUpgrade(req, socket, head, (ws) => {
        this.wss.emit('connection', ws, req);
      });
    });
  }

  acceptConnection(ws: WebSocket): void {
    this.onConnection(ws);
  }

  /** (Re)start the deadline for this socket to authenticate (G1). */
  private armAuthTimer(ws: WebSocket, state: ClientState, ms: number): void {
    if (state.authTimer) clearTimeout(state.authTimer);
    state.authTimer = setTimeout(() => {
      state.authTimer = undefined;
      if (state.authenticated) return;
      getLogger().debug('Closing unauthenticated socket', { ip: state.ip, afterMs: ms });
      ws.close(4008, 'Authentication timeout');
    }, ms);
    state.authTimer.unref?.();
  }

  private onConnection(ws: WebSocket, req?: HttpIncomingMessage): void {
    const ip = clientIp(req);
    const state: ClientState = {
      authenticated: false,
      isAlive: true,
      ip,
      pongOverdueAt: null,
      pendingLivenessBroadcast: false,
    };
    const logger = getLogger();

    this.clients.set(ws, state);
    this.armAuthTimer(ws, state, this.options.authTimeoutMs ?? DEFAULT_AUTH_TIMEOUT_MS);
    logger.debug('WebSocket connected', { ip });

    ws.on('pong', () => { this.onPongReceived(state); });

    ws.on('message', (data) => {
      // An evicted socket stays open until its close handshake completes;
      // nothing it sends may act for the device (its Pulse stream now
      // belongs to the replacement connection).
      if (state.evicted) return;
      state.lastInboundAt = Date.now();
      try {
        const msg = JSON.parse(data.toString());
        if (!isValidMessage(msg)) {
          this.sendError(ws, 'Invalid message format');
          return;
        }
        this.onMessage(ws, state, msg).catch((err) => {
          getLogger().error('Unhandled error in message handler', { error: (err as Error).message });
          this.sendError(ws, 'Internal server error');
        });
      } catch {
        this.sendError(ws, 'Invalid JSON');
      }
    });

    metrics().inc('conn.opened');
    ws.on('close', (code: number, reason: Buffer) => {
      metrics().inc('conn.closed');
      if (state.authTimer) clearTimeout(state.authTimer);
      const reasonStr = reason?.toString?.() || '';
      if (state.deviceId) {
        const disconnectedDeviceId = state.deviceId;
        const disconnectedUserId = state.userId;

        // Only clean up if this socket is still the active connection.
        // A reconnecting device may have already replaced us in the map.
        if (this.connections.get(disconnectedDeviceId) === ws) {
          try { this.storage.touchDeviceLastSeen(disconnectedDeviceId); } catch { /* storage may be closed */ }
          this.connections.delete(disconnectedDeviceId);
          this.userByDevice.delete(disconnectedDeviceId);
          this.pulseHub.onDeviceDisconnected(disconnectedDeviceId);
          trace('DEV-DISCONNECT', { device: disconnectedDeviceId, code, reason: reasonStr });
          logger.info('Device disconnected', {
            deviceId: disconnectedDeviceId,
            closeCode: code,
            closeReason: reasonStr,
          });

          if (disconnectedUserId) {
            broadcastDeviceLeft(this, disconnectedUserId, disconnectedDeviceId);
          }
        } else {
          logger.debug('Stale socket closed (already replaced by reconnect)', {
            deviceId: disconnectedDeviceId,
            closeCode: code,
            closeReason: reasonStr,
          });
        }
      } else {
        logger.debug('WebSocket closed before auth', { ip: state.ip, closeCode: code, closeReason: reasonStr });
      }
      this.clients.delete(ws);
    });

    ws.on('error', (err: Error) => {
      logger.warn('WebSocket error', {
        deviceId: state.deviceId,
        ip: state.ip,
        error: err?.message,
        code: (err as NodeJS.ErrnoException)?.code,
      });
      ws.close();
    });
  }

  private async onMessage(ws: WebSocket, state: ClientState, msg: Record<string, unknown>): Promise<void> {
    // One-shot pairing token request — before auth
    if (msg.type === 'request_pairing_token') {
      await handleRequestPairingToken(this, ws, state, msg as { token?: string });
      return;
    }

    // Pre-auth: auth_info, auth, auth_response
    if (!state.authenticated) {
      if (msg.type === 'auth_info') {
        this.armAuthTimer(ws, state, this.options.loginScreenAuthTimeoutMs ?? DEFAULT_LOGIN_SCREEN_AUTH_TIMEOUT_MS);
        const info = this.authBackend.getAuthInfo();
        ws.send(JSON.stringify({
          type: 'auth_info_response',
          methods: info.methods,
          githubClientId: info.githubClientId,
          vapidPublicKey: info.vapidPublicKey ?? this.getVapidPublicKey(),
        }));
        return;
      }
      if (msg.type === 'auth') {
        if (!isValidAuth(msg)) {
          this.sendError(ws, 'Invalid auth message: device.name and device.role required');
          return;
        }
        await handleAuth(this, ws, state, msg as unknown as AuthMessage);
      } else if (msg.type === 'auth_response' && state.pendingNonce) {
        handleChallengeResponse(this, ws, state, msg as unknown as { deviceId: string; signature: string });
      } else {
        this.sendError(ws, 'Must authenticate first');
      }
      return;
    }

    // Authenticated messages
    if (msg.type === 'create_pairing_token') {
      await handleCreatePairingToken(this, ws, state);
      return;
    }

    if (msg.type === 'unicast') {
      // The hub (a pulse endpoint on each hop) handles reliable delivery + durable
      // store-and-forward. The envelope MUST carry a pulse frame — the head is
      // pulse-only; there is no raw-WS relay path.
      if (typeof msg.pulse === 'string' && state.deviceId) {
        // `to` MUST be a single string. An array here would reach the hub's
        // multicast branch and bypass every check the `multicast` handler makes.
        if (msg.to !== undefined && typeof msg.to !== 'string') {
          this.sendError(ws, 'unicast requires a single string target');
          return;
        }
        // An EMPTY `to` is legitimate and load-bearing: pure pulse control
        // frames (hello/ack/heartbeat/reset) carry no forward destination, so
        // both arm and tentacle emit them with `to: ''`. They ride the source
        // endpoint only and are never forwarded — nothing to authorize.
        const to = typeof msg.to === 'string' ? msg.to : '';
        // Authorize a real destination. Without this any authenticated device
        // could address ANY device id: the hub would mint an endpoint for it
        // and queue (and, for durable sends, persist to SQLite) payloads on a
        // stranger's outbox — cross-user frame injection plus an unbounded
        // endpoint/disk-growth amplifier from a single client.
        if (to !== '' && to !== HEAD_PULSE_TARGET) {
          const target = this.storage.getDevice(to);
          // Same account, and only across roles (app ⇄ tentacle): no feature
          // sends app→app or tentacle→tentacle, so such a frame is not trusted.
          const sender = this.storage.getDevice(state.deviceId);
          if (!target || target.userId !== state.userId || !sender || target.role === sender.role) {
            this.sendError(ws, 'unicast target is not reachable');
            // Still consume the frame on the sender's stream, forwarding it
            // nowhere: an unconsumed seq would never be ACKed, the sender would
            // retransmit it (with the same target) forever, and every later
            // seq on that stream would wait behind it.
            this.pulseHub.onPulseEnvelope(state.deviceId, { pulse: msg.pulse as string, to: [] });
            return;
          }
        }
        this.pulseHub.onPulseEnvelope(state.deviceId, {
          pulse: msg.pulse as string,
          to,
        });
        return;
      }
      this.sendError(ws, 'unicast requires a pulse frame');
      return;
    }

    if (msg.type === 'multicast') {
      if (typeof msg.pulse !== 'string' || !state.deviceId || !state.userId) {
        this.sendError(ws, 'multicast requires a pulse frame');
        return;
      }
      const sender = this.storage.getDevice(state.deviceId);
      if (sender?.role !== 'tentacle') {
        this.sendError(ws, 'multicast is only allowed from tentacle devices');
        return;
      }
      if (!Array.isArray(msg.to)) {
        this.sendError(ws, 'multicast requires a target array');
        return;
      }
      if (msg.to.some((target) => typeof target !== 'string' || target.length === 0)) {
        this.sendError(ws, 'multicast targets must be non-empty strings');
        return;
      }
      const requested = [...new Set(msg.to)];
      if (requested.length === 0 || requested.length > MAX_MULTICAST_TARGETS) {
        this.sendError(ws, `multicast target count must be between 1 and ${MAX_MULTICAST_TARGETS}`);
        return;
      }
      const allowed = requested.filter((targetId) => {
        const target = this.storage.getDevice(targetId);
        return targetId !== state.deviceId
          && targetId !== HEAD_PULSE_TARGET
          && !!target
          && target.userId === state.userId
          && target.role === 'app';
      });
      // Forbidden targets are dropped, not the frame: the frame must still be
      // consumed on the sender's stream (see the unicast branch), and the
      // allowed targets still get it.
      if (allowed.length < requested.length) this.sendError(ws, 'multicast contains a forbidden target');
      const onlineTargets = allowed.filter((targetId) => this.connections.has(targetId));
      this.pulseHub.onPulseEnvelope(state.deviceId, {
        pulse: msg.pulse,
        to: onlineTargets,
      });
      return;
    }

    if (msg.type === 'broadcast') {
      // Pulse broadcast frames (control: hello/ack/heartbeat) are addressed to a
      // specific hop via the hub too; a producer fans out per-device unicasts.
      if (typeof msg.pulse === 'string' && state.deviceId) {
        // A pushPreview may ride the same pulse envelope — fire it for offline
        // devices (the reliable message itself is delivered by the hub).
        // Push previews are tentacle-originated (same rule as dispatch_push).
        if (msg.pushPreview && this.storage.getDevice(state.deviceId)?.role === 'tentacle') {
          firePushPreview(this, state, msg.pushPreview as BlobPayload);
        }
        this.pulseHub.onPulseEnvelope(state.deviceId, { pulse: msg.pulse as string });
        return;
      }
      this.sendError(ws, 'broadcast requires a pulse frame');
      return;
    }

    // Relay-terminated control ops (update_preferences / remove_device /
    // (un)register_push_token). Arrive via pulse deliver-to-self (deliverPulseToSelf).
    if (handleControlMessage(this, ws, state, msg)) return;

    if (msg.type === 'request_voice_lease') {
      handleRequestVoiceLease(this, ws, state, msg);
      return;
    }

    if (msg.type === 'ping') {
      // Backward-compatible, unqueued foreground heartbeat. Never infer DAU
      // from authentication, background traffic, diagnostic opt-in or agents.
      const day = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
      if (msg.foreground === true && state.foregroundDay !== day && state.userId && state.deviceId
        && this.storage.getDevice(state.deviceId)?.role === 'app') {
        try {
          this.storage.recordForegroundActivity(state.userId);
          state.foregroundDay = day;
        } catch {
          getLogger().warn('Daily activity recording failed');
        }
      }
      ws.send(JSON.stringify({ type: 'pong' }));
      return;
    }

    if (msg.type === 'pong') {
      this.onPongReceived(state);
      return;
    }

    this.sendError(ws, `Unknown message type: ${msg.type}`);
  }

  // --- Voice lease issuance ---

  // --- Routing ---

  /** Send a pulse frame (control or forwarded data) to a device's socket, as a
   *  minimal unicast envelope carrying only the `pulse` field. Returns true if
   *  the device is online. Used by the PulseHub to reach endpoints. */
  private sendPulseFrameTo(deviceId: string, pulseB64: string): boolean {
    const ws = this.connections.get(deviceId);
    const online = !!ws && ws.readyState === WebSocket.OPEN;
    trace('HUB-TX-WS', { to: deviceId, online, pulseB64Len: pulseB64.length });
    if (!online) return false;
    // Backpressure: a connected but stalled client would otherwise grow the
    // socket's send buffer without bound. Drop the connection instead; every
    // reliable frame is still in the pulse outbox and resends on reconnect.
    if (ws.bufferedAmount > MAX_WS_BUFFERED_BYTES) {
      metrics().inc('conn.stalledClosed');
      getLogger().warn('Closing stalled connection (send buffer full)', { deviceId, bufferedBytes: ws.bufferedAmount });
      ws.terminate();
      return false;
    }
    // `to` lets the receiver's own pulse layer know which stream this is; blob
    // is empty because the payload (if any) is inside the pulse frame.
    ws.send(JSON.stringify({ type: 'unicast', to: deviceId, pulse: pulseB64, blob: '', keys: {} }));
    metrics().inc('pulse.frames.out');
    metrics().inc('pulse.bytes.out', pulseB64.length);
    return true;
  }

  /** Send a head-ORIGINATED control message to a device reliably over pulse
   *  (presence, preferences confirmation, voice responses). These are plaintext
   *  head↔device control (the head has no E2E on them), so the payload is
   *  wrapped as `{from:'@head', msg}` — the receiver's pulse layer recognizes the
   *  `@head` marker and dispatches `msg` WITHOUT decrypting. Non-durable:
   *  presence/prefs are ephemeral. */
  sendControlToDevice(deviceId: string, msg: Record<string, unknown>): void {
    const payload = Buffer.from(JSON.stringify({ from: HEAD_PULSE_TARGET, msg }), 'utf8');
    this.pulseHub.sendToDevice(deviceId, new Uint8Array(payload));
  }

  /** Presence (device_joined/left/removed/pending): the destination's next
   *  `auth_ok` device list supersedes it, so it is never replayed across a
   *  reconnect (a stale device_left would hide an online peer). */
  sendPresenceToDevice(deviceId: string, msg: Record<string, unknown>): void {
    const payload = Buffer.from(JSON.stringify({ from: HEAD_PULSE_TARGET, msg }), 'utf8');
    this.pulseHub.sendPresenceToDevice(deviceId, new Uint8Array(payload));
  }

  /** A pulse frame addressed to HEAD_PULSE_TARGET was delivered in-order by the
   *  source device's endpoint. The payload is PLAINTEXT control JSON. Resolve the
   *  originating authenticated connection and route it through the SAME control
   *  handlers the raw-WS path uses, so auth context (state.userId/deviceId) and
   *  responses (over ws) are identical. */
  private deliverPulseToSelf(fromDevice: string, payload: Uint8Array): void {
    trace('CTRL-SELF', { from: fromDevice, len: payload.length, fp: fp(payload) });
    const ws = this.connections.get(fromDevice);
    if (!ws) return; // device vanished — the control op is moot
    const state = this.clients.get(ws);
    if (!state?.authenticated) return;
    let msg: Record<string, unknown>;
    try {
      const parsed = JSON.parse(Buffer.from(payload).toString('utf8'));
      if (!isValidMessage(parsed)) return;
      msg = parsed;
    } catch {
      return; // malformed → drop
    }
    // handleControlMessage whitelists the 4 relay-terminated types and returns
    // false for anything else, so the self-channel cannot tunnel unicast/auth/etc.
    handleControlMessage(this, ws, state, msg);
  }

  /** Fan-out targets for a pulse broadcast from `fromDevice`: all OTHER
   *  ONLINE devices of the same user. Offline devices are excluded because
   *  broadcasts (user_message / agent_message / delta / active / idle /
   *  session_title_updated / session_list) are all non-durable — enqueuing
   *  them in an offline device's endpoint outbox would just grow memory +
   *  SQLite writes without delivering anything, since offline endpoints are
   *  in state=disconnected and their `send()` emits no `transmit` effect.
   *  Each forward() call also does a `saveSnapshot` SQLite write; with N
   *  registered devices of which most are offline, one broadcast becomes N
   *  serialized SQLite writes and starves the head event loop (observed:
   *  ~200ms per FORWARD × 65 devices ⇒ 13s per frame, causing the "every
   *  streaming delta arrives 16s later than the previous" bug). Reconnecting
   *  devices resync via session_messages_range instead. */
  private pulseBroadcastTargets(fromDevice: string): string[] {
    const userId = this.userByDevice.get(fromDevice);
    if (!userId) return [];
    const targets: string[] = [];
    for (const device of this.storage.getDevicesByUser(userId)) {
      if (device.id === fromDevice || device.role !== 'app') continue;
      // Only include devices currently connected — see comment above.
      if (!this.connections.has(device.id)) continue;
      targets.push(device.id);
    }
    return targets;
  }

  private removeConnection(deviceId: string): void {
    const ws = this.connections.get(deviceId);
    const userId = this.userByDevice.get(deviceId);
    this.connections.delete(deviceId);
    this.userByDevice.delete(deviceId);
    if (ws) {
      // The reason we are here is that the peer stopped answering pings, so a
      // graceful `close()` (which waits for a close handshake that will never
      // come) can leave the socket — and its ClientState — pinned for the full
      // TCP timeout. Terminate outright.
      try { ws.terminate(); } catch { /* best effort */ }
      this.clients.delete(ws);
    }
    // Tell the hub the link is down. The ws.on('close') handler cannot do it
    // for us: its reconnect-guard sees the map entry already deleted and skips
    // the whole cleanup block. Without this the device's pulse endpoint stays
    // in link=connected with disconnectedAtMs=null forever, so neither GC tier
    // can ever reclaim it and every later forward() keeps growing its outbox.
    if (ws || userId) this.pulseHub.onDeviceDisconnected(deviceId);
    // Programmatic removal — the ws.on('close') handler's reconnect-guard
    // check will fail (we already deleted from the map), so notify other
    // devices ourselves. Idempotent: if the close handler does run later it
    // sees the map empty and skips.
    if (userId) {
      try { this.storage.touchDeviceLastSeen(deviceId); } catch { /* storage may be closed */ }
      broadcastDeviceLeft(this, userId, deviceId);
    }
  }

  // --- Auth ---

  // --- Pairing tokens (in-memory) ---

  // --- Device presence notifications ---

  // --- Account deletion ---

  /** Users whose deletion is in flight (a double tap must not run it twice). */
  deletingAccounts = new Set<string>();

  // --- Push token management ---

  /** Handle pong from either protocol-level or JSON pong.
   *  Re-promotes to device_joined if we already broadcast device_pending.
   *  Guards against stale pongs from replaced connections (reconnect race). */
  private onPongReceived(state: ClientState): void {
    const now = Date.now();
    const rttMs = state.lastPingSentAt ? now - state.lastPingSentAt : null;
    state.isAlive = true;
    const wasPending = state.pendingLivenessBroadcast;
    state.pongOverdueAt = null;
    state.pendingLivenessBroadcast = false;
    state.lastPongRecvAt = now;
    if (state.deviceId) {
      getLogger().debug('Received pong', { deviceId: state.deviceId, rttMs });
    }

    if (wasPending && state.userId && state.deviceId) {
      // Only re-promote if this state still belongs to the active connection.
      // A reconnecting device may have replaced us in the connections map;
      // broadcasting from a stale socket would emit a duplicate device_joined.
      const activeWs = this.connections.get(state.deviceId);
      const activeState = activeWs ? this.clients.get(activeWs) : null;
      if (activeState === state) {
        broadcastDeviceJoined(this, state.userId, state.deviceId);
      }
    }
  }

  // --- Helpers ---

  sendError(ws: WebSocket, message: string): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'server_error', message }));
    }
  }

  /** Live gauges for `/internal/metrics` (counts only). */
  getGauges(): Record<string, number> {
    let durableRows = -1;
    try {
      durableRows = (this.storage.rawDb.prepare('SELECT COUNT(*) AS n FROM pulse_outbox').get() as { n: number }).n;
    } catch { /* table may not exist yet */ }
    const mem = process.memoryUsage();
    return {
      connections: this.connections.size,
      endpoints: this.pulseHub.endpointCount(),
      durableRows,
      rssMb: Math.round(mem.rss / 1048576),
      heapUsedMb: Math.round(mem.heapUsed / 1048576),
    };
  }

  getStats(): {
    users: { total: number; online: number };
    devices: { total: number; online: number };
    connections: Array<{
      deviceId: string;
      userId: string;
      userName?: string;
      role?: string;
      kind?: string;
      connectedAt?: string;
    }>;
    registeredUsers: Array<{
      userId: string;
      username: string;
      provider: string;
      email?: string;
      createdAt: string;
      online: boolean;
      devices: Array<{
        id: string;
        name: string;
        role: string;
        kind?: string;
        online: boolean;
        lastSeen: string;
        createdAt: string;
      }>;
    }>;
  } {
    const onlineUserIds = new Set<string>();
    const connectionList: Array<{
      deviceId: string;
      userId: string;
      userName?: string;
      role?: string;
      kind?: string;
      connectedAt?: string;
    }> = [];

    for (const [deviceId, ws] of this.connections) {
      const state = this.clients.get(ws);
      if (!state?.authenticated || !state.userId) continue;

      onlineUserIds.add(state.userId);

      const device = this.storage.getDevice(deviceId);
      const user = this.storage.getUser(state.userId);

      connectionList.push({
        deviceId,
        userId: state.userId,
        userName: user?.username,
        role: device?.role,
        kind: device?.kind ?? undefined,
        connectedAt: state.authenticatedAt
          ? new Date(state.authenticatedAt).toISOString()
          : undefined,
      });
    }

    const allUsers = this.storage.getAllUsers();
    const devicesByUser = this.storage.getAllDevicesByUser();
    const registeredUsers = allUsers.map(u => {
      const devices = devicesByUser.get(u.userId) ?? [];
      return {
        userId: u.userId,
        username: u.username,
        provider: u.provider,
        email: u.email,
        createdAt: u.createdAt,
        online: onlineUserIds.has(u.userId),
        devices: devices.map(d => ({
          id: d.id,
          name: d.name,
          role: d.role,
          kind: d.kind ?? undefined,
          online: this.connections.has(d.id),
          lastSeen: d.lastSeen,
          createdAt: d.createdAt,
        })),
      };
    });

    return {
      users: {
        total: this.storage.getUserCount(),
        online: onlineUserIds.size,
      },
      devices: {
        total: this.storage.getDeviceCount(),
        online: this.connections.size,
      },
      connections: connectionList,
      registeredUsers,
    };
  }

  /** Test hook: run the ping pass (set isAlive=false, send ping, start grace timer). */
  forcePingPass(): void {
    for (const [deviceId, ws] of this.connections) {
      const state = this.clients.get(ws);
      if (state && !state.isAlive && this.linkProgressing(ws, state)) state.isAlive = true;
      if (state && !state.isAlive) {
        getLogger().info('Terminating stale connection (no pong)', { deviceId });
        this.removeConnection(deviceId);
        continue;
      }
      if (state) state.isAlive = false;
      try {
        if (ws.readyState === WebSocket.OPEN) {
          ws.ping();
          ws.send(JSON.stringify({ type: 'ping' }));
          if (state) {
            state.pongOverdueAt = Date.now() + PONG_GRACE_MS;
            state.pendingLivenessBroadcast = false;
            state.lastPingSentAt = Date.now();
            state.bufferedAtPing = ws.bufferedAmount;
          }
        }
      } catch {
        this.removeConnection(deviceId);
      }
    }
  }

  /** Test hook: simulate the effect of a ping pass on a single device without
   *  actually sending a protocol-level ws.ping() (which triggers an auto-pong
   *  from the ws library client, making it impossible to test overdue scenarios).
   *  Sets isAlive=false and starts the grace timer. */
  simulatePingSent(deviceId: string): void {
    const ws = this.connections.get(deviceId);
    if (!ws) return;
    const state = this.clients.get(ws);
    if (!state) return;
    state.isAlive = false;
    state.pongOverdueAt = Date.now() + PONG_GRACE_MS;
    state.pendingLivenessBroadcast = false;
    state.lastPingSentAt = Date.now();
    state.bufferedAtPing = ws.bufferedAmount;
  }

  /** Test hook: expire the pong grace timer for a specific device so the next
   *  liveness sweep will broadcast device_pending immediately. */
  expirePongGrace(deviceId: string): void {
    const ws = this.connections.get(deviceId);
    if (!ws) return;
    const state = this.clients.get(ws);
    if (!state) return;
    if (state.pongOverdueAt !== null) {
      state.pongOverdueAt = Date.now() - 1;
    }
  }

  close(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    if (this.livenessTimer) {
      clearInterval(this.livenessTimer);
      this.livenessTimer = null;
    }
    if (this.pulseTickTimer) {
      clearInterval(this.pulseTickTimer);
      this.pulseTickTimer = null;
    }
    // Stop Pulse before closing sockets. WebSocket close callbacks are async
    // and may otherwise persist capability state after Storage has closed.
    this.pulseHub.close();
    for (const ws of this.clients.keys()) {
      ws.close();
    }
    this.wss.close();
    this.options.pushManager?.close();
  }
}
