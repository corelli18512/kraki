/**
 * Isolated local Kraki stack for network-resilience tests.
 *
 *   App ──► proxy[app] ──► Head ◄── proxy[tentacle] ◄── Tentacle(ScriptedAdapter)
 *
 * Everything runs on 127.0.0.1 with a temporary Head database, session
 * directory and Tentacle keys. Nothing touches production relays, accounts,
 * the Keychain or ~/.kraki. A localhost HTTP control plane lets a test
 * (Swift or TS) inject faults, drive the agent and read the agent-side ledger.
 *
 *   pnpm --filter @kraki/tests exec tsx src/chaos/stack.ts [--control-port 4777]
 *   → prints one JSON line {controlPort, appPort, headPort, sessionId, tentacleId}
 */
import { createServer as createHttpServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Storage, HeadServer, OpenAuthProvider } from '@kraki/head';
import { SessionManager, RelayClient, KeyManager, AttachmentStore, createPairingSecret, writeTrustPolicy, buildPushPreview } from '@kraki/tentacle';
import { writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { WebSocket } from 'ws';
import { ChaosProxy, type FaultProfile } from './proxy.js';
import { ScriptedAdapter } from './scripted-adapter.js';
import { connectTrustedApp } from './trusted-app.js';
import { connectApp, sendToTentacle, type MockApp } from '../helpers.js';

export interface StackOptions { controlPort?: number; headPort?: number }

export class ChaosStack {
  readonly root = mkdtempSync(join(tmpdir(), 'kraki-chaos-'));
  readonly adapter = new ScriptedAdapter();
  readonly appProxy = new ChaosProxy('app', () => this.headPort);
  /** A second app link, so two devices can be faulted independently. */
  readonly app2Proxy = new ChaosProxy('app2', () => this.headPort);
  readonly tentacleProxy = new ChaosProxy('tentacle', () => this.headPort);
  headPort = 0;
  sessionId = '';
  private storage!: Storage;
  private head!: HeadServer;
  private headHttp!: Server;
  private sessions!: SessionManager;
  private keys!: KeyManager;
  private attachments!: AttachmentStore;
  private legacyApps: MockApp[] = [];
  relay!: RelayClient;
  private tentacleDeviceId = '';
  private control: Server | null = null;
  private admin: MockApp | null = null;
  /** A second, unproxied app device ("the Mac") that talks in the session. */
  private peer: MockApp | null = null;
  /** Device trust mode of the Tentacle (CHAOS_DEVICE_TRUST=enforce). The
   *  first session is always created before enforcing (by an unpaired admin). */
  trustMode: 'enforce' | 'compatible' | 'default' = process.env.CHAOS_DEVICE_TRUST === 'default' ? 'default' : 'compatible';
  /** Transition tests: the pre-device-trust Tentacle (CHAOS_OLD_WORKTREE). */
  private oldTentacle: ChildProcess | null = null;
  private get oldLedgerPath(): string { return join(this.root, 'old-ledger.json'); }
  /** Unpaired device that tries to command the computer (device-trust tests). */
  private rogue: MockApp | null = null;
  private secondComputer: { root: string; keys: KeyManager; relay: RelayClient } | null = null;
  private trustedApps: Awaited<ReturnType<typeof connectTrustedApp>>[] = [];
  /** Drop the next N `session_messages_batch` replies (sent, never delivered). */
  dropBatches = 0;
  readonly events: Array<{ t: number; event: string; detail?: Record<string, unknown> }> = [];

  private log(event: string, detail?: Record<string, unknown>): void {
    this.events.push({ t: Date.now(), event, ...(detail && { detail }) });
  }

  async start(options: StackOptions = {}): Promise<void> {
    await this.startHead(options.headPort ?? 0);
    await this.appProxy.listen();
    await this.app2Proxy.listen();
    await this.tentacleProxy.listen();
    this.sessions = new SessionManager(join(this.root, 'sessions'));
    this.keys = new KeyManager(join(this.root, 'keys'));
    this.attachments = new AttachmentStore(join(this.root, 'sessions'));
    await this.startTentacle();
    this.sessionId = await this.createSession();
    if (process.env.CHAOS_DEVICE_TRUST === 'enforce') {
      // Through the policy file, like `kraki devices enforce on`, so a paired
      // app can change it.
      this.trustMode = 'enforce';
      writeTrustPolicy(join(this.root, 'trust'), { enforce: true });
      await this.restartTentacle();
    }
    if (options.controlPort !== undefined) await this.startControl(options.controlPort);
  }

  private async startHead(port: number): Promise<void> {
    this.storage = new Storage(join(this.root, 'head.db'));
    this.head = new HeadServer(this.storage, { authProvider: new OpenAuthProvider() });
    this.headHttp = createHttpServer();
    this.head.attach(this.headHttp);
    await new Promise<void>((resolve) => this.headHttp.listen(port, '127.0.0.1', resolve));
    this.headPort = (this.headHttp.address() as { port: number }).port;
    this.log('head_started', { port: this.headPort });
  }

  private async stopHead(): Promise<void> {
    this.head.close();
    this.headHttp.closeAllConnections?.();
    await new Promise<void>((resolve) => this.headHttp.close(() => resolve()));
    this.storage.close();
    this.log('head_stopped');
  }

  async restartHead(downMs = 0): Promise<void> {
    const port = this.headPort;
    await this.stopHead();
    if (downMs > 0) await new Promise((r) => setTimeout(r, downMs));
    await this.startHead(port);
  }

  private async startTentacle(): Promise<void> {
    // Like the production daemon: a persisted device id, so every reconnect is
    // challenge auth as the same device (open auth would mint a new device).
    const device: { name: string; role: 'tentacle'; kind: 'desktop'; deviceId?: string } =
      { name: 'Chaos Tentacle', role: 'tentacle', kind: 'desktop', ...(this.tentacleDeviceId && { deviceId: this.tentacleDeviceId }) };
    this.relay = new RelayClient(this.adapter.asAdapter(), this.sessions, {
      relayUrl: `ws://127.0.0.1:${this.tentacleProxy.port}`,
      device,
      authMethod: 'open',
      // 'default': exactly what a user gets (policy file / install defaults).
      ...(this.trustMode === 'compatible' ? { deviceTrust: 'compatible' as const } : {}),
      // These scenarios test the relay path. A local link would let the Mac
      // test App bypass the fault proxy, and would publish its discovery file
      // in the real ~/.kraki (KRAKI_HOME is unset here).
      localLink: false,
    }, this.keys, this.attachments);
    this.relay.onStateChange = (state) => this.log('tentacle_state', { state });
    const relayAny = this.relay as unknown as { sendReliableUnicastTo: (...a: unknown[]) => void };
    const original = relayAny.sendReliableUnicastTo.bind(this.relay);
    relayAny.sendReliableUnicastTo = (target: unknown, key: unknown, msg: unknown, ...rest: unknown[]) => {
      const type = (msg as { type?: string }).type;
      if (type === 'session_messages_batch' && this.dropBatches > 0) {
        this.dropBatches--;
        this.log('batch_dropped', { target });
        return;
      }
      if (type === 'session_messages_batch') this.log('batch_sent', { target });
      original(target, key, msg, ...rest);
    };
    this.relay.onAuthenticated = (info) => {
      if (!this.tentacleDeviceId) this.tentacleDeviceId = info.deviceId;
      device.deviceId = this.tentacleDeviceId;
      // Like ~/.kraki/device-id: lets a same-Mac test App find this computer.
      writeFileSync(join(this.root, 'device-id'), this.tentacleDeviceId);
      this.log('tentacle_authenticated', { deviceId: info.deviceId });
    };
    this.relay.connect();
    await this.waitFor(() => this.relay.getAuthInfo() !== null, 10_000, 'tentacle auth');
  }

  async restartTentacle(downMs = 0): Promise<void> {
    this.relay.disconnect();
    this.log('tentacle_stopped');
    if (downMs > 0) await new Promise((r) => setTimeout(r, downMs));
    await this.startTentacle();
  }

  get tentacleId(): string { return this.relay.getAuthInfo()?.deviceId ?? this.tentacleDeviceId; }

  // ── Version transition (new ⇄ old Tentacle on one computer directory) ──

  async stopNewTentacle(): Promise<void> {
    this.relay.disconnect();
    this.relay.deviceTrust?.store.flushReplay();
    this.log('new_tentacle_stopped');
  }

  /** What a computer looked like before device trust: RSA keys, sessions,
   *  device id — no trust store, no identity/X25519 keys. */
  makeOldInstall(): void {
    rmSync(join(this.root, 'trust'), { recursive: true, force: true });
    for (const f of ['identity-ed25519.key', 'e2e-x25519.key', 'public-identity.json']) {
      rmSync(join(this.root, 'keys', f), { force: true });
    }
    this.log('old_install');
  }

  async startOldTentacle(): Promise<void> {
    const worktree = process.env.CHAOS_OLD_WORKTREE;
    if (!worktree) throw new Error('CHAOS_OLD_WORKTREE not set');
    rmSync(this.oldLedgerPath, { force: true });
    const env: NodeJS.ProcessEnv = { ...process.env, KRAKI_HOME: this.root };
    delete env.NODE_ENV;
    const child = spawn('npx', ['tsx', 'src/chaos/old-tentacle.ts', `ws://127.0.0.1:${this.tentacleProxy.port}`, this.root, this.tentacleDeviceId, this.oldLedgerPath],
      { cwd: join(worktree, 'packages', 'tests'), env, stdio: ['ignore', 'pipe', 'inherit'] });
    this.oldTentacle = child;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('old tentacle did not authenticate')), 30_000);
      child.stdout!.on('data', (d: Buffer) => {
        if (d.toString().includes('"oldTentacle":"authenticated"')) { clearTimeout(timer); resolve(); }
      });
      child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`old tentacle exited ${code}`)); });
    });
    this.log('old_tentacle_started');
  }

  async stopOldTentacle(): Promise<void> {
    const child = this.oldTentacle;
    if (!child) return;
    this.oldTentacle = null;
    await new Promise<void>((resolve) => { child.once('exit', () => resolve()); child.kill('SIGTERM'); });
    this.log('old_tentacle_stopped');
  }

  async startNewTentacle(): Promise<void> {
    // A fresh process: keys and trust state come from disk.
    this.keys = new KeyManager(join(this.root, 'keys'));
    await this.startTentacle();
    this.log('new_tentacle_started');
  }

  /** Creates a session through a direct (unproxied) admin app connection. */
  async createSession(): Promise<string> {
    this.admin?.close();
    this.admin = await connectApp(this.headPort, 'Chaos Admin');
    this.admin.sendUnicast(this.tentacleId, {
      type: 'create_session',
      payload: { requestId: `chaos_${Date.now()}`, model: 'scripted-v1' },
    }, this.keys.getCompactPublicKey());
    const created = await this.admin.waitFor('session_created', 10_000);
    const sessionId = created.sessionId as string;
    this.admin.close();
    this.admin = null;
    this.log('session_created', { sessionId });
    return sessionId;
  }

  /** One-time pairing token (open auth relay), as scripts/dev-local.ts does. */
  pairingToken(): Promise<string> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${this.headPort}`);
      const timer = setTimeout(() => { ws.close(); reject(new Error('pairing token timeout')); }, 10_000);
      ws.on('open', () => ws.send(JSON.stringify({ type: 'request_pairing_token', token: 'dev' })));
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString()) as { type?: string; token?: string };
        if (msg.type === 'pairing_token_created' && msg.token) { clearTimeout(timer); ws.close(); resolve(msg.token); }
      });
      ws.on('error', (err) => { clearTimeout(timer); reject(err); });
    });
  }

  /** Store an incompressible attachment in the Tentacle (like a big report). */
  putAttachment(bytes: number, sessionId = this.sessionId): Record<string, unknown> {
    return this.attachments.put(sessionId, randomBytes(bytes), 'application/octet-stream', { name: 'blob.bin' }) as unknown as Record<string, unknown>;
  }

  /** An older client (whole-file requests) pulls `id` through the app link. */
  async legacyPull(id: string, sessionId = this.sessionId): Promise<void> {
    const app = await connectApp(this.appProxy.port, 'Legacy Client');
    this.legacyApps.push(app);
    app.sendUnicast(this.tentacleId, {
      type: 'request_attachment', sessionId, payload: { id, sessionId },
    }, this.keys.getCompactPublicKey());
  }

  proxy(link: string): ChaosProxy {
    if (link === 'tentacle') return this.tentacleProxy;
    if (link === 'app2') return this.app2Proxy;
    return this.appProxy;
  }

  ledger(sessionId = this.sessionId): Record<string, unknown> {
    const received: Record<string, number> = Object.fromEntries(this.adapter.received.get(sessionId) ?? []);
    if (existsSync(this.oldLedgerPath)) {
      try {
        const old = JSON.parse(readFileSync(this.oldLedgerPath, 'utf8')) as Record<string, Record<string, number>>;
        for (const [text, n] of Object.entries(old[sessionId] ?? {})) received[text] = (received[text] ?? 0) + n;
      } catch { /* being written */ }
    }
    const spine = this.sessions.getMessagesAfterSeq(sessionId, 0).map((m) => ({ seq: m.seq, type: m.type }));
    return { sessionId, received, emitted: this.adapter.emitted.get(sessionId) ?? [], spine };
  }

  timeline(): unknown[] {
    return [...this.events, ...this.appProxy.timeline, ...this.app2Proxy.timeline, ...this.tentacleProxy.timeline].sort((a, b) => a.t - b.t);
  }

  private async waitFor(check: () => boolean, ms: number, what: string): Promise<void> {
    const end = Date.now() + ms;
    while (!check()) {
      if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  // ── Control plane ─────────────────────────────────────────────────────────

  private async startControl(port: number): Promise<void> {
    this.control = createHttpServer((req, res) => { void this.route(req, res); });
    await new Promise<void>((resolve) => this.control!.listen(port, '127.0.0.1', resolve));
  }

  get controlPort(): number { return (this.control?.address() as { port: number } | null)?.port ?? 0; }

  private async route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://x');
    let body: Record<string, unknown> = {};
    if (req.method === 'POST') {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      if (chunks.length) body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    }
    const link = String(body.link ?? url.searchParams.get('link') ?? 'app');
    try {
      let out: unknown = { ok: true };
      switch (`${req.method} ${url.pathname}`) {
        case 'GET /info': out = this.info(); break;
        case 'POST /fault': {
          const { link: _l, ...patch } = body;
          this.proxy(link).set(patch as Partial<FaultProfile>);
          break;
        }
        case 'POST /heal':
          if (body.link) this.proxy(link).heal(); else { this.appProxy.heal(); this.app2Proxy.heal(); this.tentacleProxy.heal(); }
          break;
        case 'POST /reset': this.proxy(link).reset(); break;
        case 'POST /agent/burst':
          this.adapter.burst(String(body.sessionId ?? this.sessionId), Number(body.count ?? 1), String(body.prefix ?? 'burst'), Number(body.bytes ?? 0));
          break;
        case 'POST /agent/options': Object.assign(this.adapter.options, body); break;
        case 'POST /tentacle/drop-batches': this.dropBatches = Number(body.count ?? 1); break;
        case 'GET /events': out = this.events.slice(-Number(url.searchParams.get('n') ?? 50)); break;
        case 'POST /peer/input': out = await this.peerInput(String(body.text ?? 'ok'), String(body.sessionId ?? this.sessionId)); break;
        case 'POST /session': out = { sessionId: await this.createSession() }; break;
        case 'POST /pairing-token': out = { token: await this.pairingToken() }; break;
        case 'POST /trust/pairing-link': out = { url: await this.trustPairingLink(Number(body.ageMs ?? 0)) }; break;
        case 'POST /trust/second-app': {
          const app = await connectTrustedApp(this.headPort, String(body.url ?? await this.trustPairingLink()));
          this.trustedApps.push(app);
          out = { deviceId: app.id, result: app.messages.find((m) => m.type === 'pair_result') };
          break;
        }
        case 'POST /trust/second-app-input': {
          const app = this.trustedApps.at(-1);
          if (!app) throw new Error('second app not started');
          app.send('send_input', { text: String(body.text), clientId: `second-${Date.now()}` }, this.sessionId);
          break;
        }
        case 'POST /trust/second-computer': {
          if (!this.secondComputer) {
            const root = mkdtempSync(join(tmpdir(), 'kraki-chaos-second-'));
            const keys = new KeyManager(join(root, 'keys'));
            writeTrustPolicy(join(root, 'trust'), { enforce: true });
            const relay = new RelayClient(new ScriptedAdapter().asAdapter(), new SessionManager(join(root, 'sessions')), {
              relayUrl: `ws://127.0.0.1:${this.headPort}`, authMethod: 'open',
              device: { name: 'Second Computer', role: 'tentacle', kind: 'desktop' }, localLink: false,
            }, keys);
            this.secondComputer = { root, keys, relay };
            relay.connect();
            await this.waitFor(() => relay.getAuthInfo() !== null, 10_000, 'second computer auth');
          }
          const { root, keys, relay } = this.secondComputer;
          const id = relay.getAuthInfo()!.deviceId;
          const identity = keys.getPublicIdentity();
          const params = new URLSearchParams({ relay: `ws://127.0.0.1:${this.appProxy.port}`, token: await this.pairingToken(),
            tid: id, ik: identity.identityKey, xk: identity.encryptionKey, ps: createPairingSecret(root) });
          out = { tentacleId: id, url: `https://app.kraki.chat/?${params}` };
          break;
        }
        case 'POST /trust/policy':
          writeTrustPolicy(join(this.root, 'trust'), { enforce: body.enforce === true });
          break;
        case 'POST /trust/preview': {
          const preview = buildPushPreview(this.relay, {
            type: 'agent_message', sessionId: this.sessionId,
            payload: { question: { id: 'q_usability', text: 'Allow the usability test? ✓' } },
          } as unknown as Parameters<typeof buildPushPreview>[1]);
          out = preview?.trusted ?? preview?.encrypted ?? {};
          break;
        }
        case 'POST /trust/screenshot': {
          // Opt-in only; never select or boot another lane's simulator.
          const simulator = process.env.CHAOS_TRUST_SIMULATOR;
          const name = String(body.name ?? '');
          if (!simulator || !/^[A-Fa-f0-9-]{36}$/.test(simulator) || !/^ios-[a-z0-9-]+$/.test(name)) {
            throw new Error('explicit test simulator and safe screenshot name required');
          }
          execFileSync('xcrun', ['simctl', 'io', simulator, 'screenshot', `/tmp/kraki-trust-review/shots/${name}.png`]);
          break;
        }
        case 'POST /transition/stop-new': await this.stopNewTentacle(); break;
        case 'POST /transition/old-install': this.makeOldInstall(); break;
        case 'POST /transition/start-old': await this.startOldTentacle(); break;
        case 'POST /transition/stop-old': await this.stopOldTentacle(); break;
        case 'POST /transition/start-new': await this.startNewTentacle(); break;
        case 'POST /trust/rogue-input': out = await this.rogueInput(String(body.text ?? 'rogue'), String(body.sessionId ?? this.sessionId)); break;
        case 'GET /trust/state': out = {
          mode: this.trustMode,
          policyFile: existsSync(join(this.root, 'trust', 'policy.json')) ? JSON.parse(readFileSync(join(this.root, 'trust', 'policy.json'), 'utf8')) : null,
          enforced: this.relay.deviceTrust?.enforced ?? false,
          root: this.root,
          trusted: this.relay.deviceTrust?.store.ids() ?? [],
          stats: this.relay.deviceTrust?.stats ?? null,
        }; break;
        case 'POST /attachment': out = this.putAttachment(Number(body.bytes ?? 1_000_000), String(body.sessionId ?? this.sessionId)); break;
        case 'POST /legacy-pull': await this.legacyPull(String(body.id), String(body.sessionId ?? this.sessionId)); break;
        case 'POST /legacy-close': this.legacyApps.forEach((a) => a.close()); this.legacyApps = []; break;
        case 'POST /restart/head': await this.restartHead(Number(body.downMs ?? 0)); break;
        case 'POST /restart/tentacle': await this.restartTentacle(Number(body.downMs ?? 0)); break;
        case 'GET /ledger': out = this.ledger(url.searchParams.get('sessionId') ?? this.sessionId); break;
        case 'GET /timeline': out = this.timeline(); break;
        case 'GET /stats':
          out = {
            app: { live: this.appProxy.liveConnections, total: this.appProxy.totalConnections, bytes: this.appProxy.bytesForwarded },
            app2: { live: this.app2Proxy.liveConnections, total: this.app2Proxy.totalConnections },
            tentacle: { live: this.tentacleProxy.liveConnections, total: this.tentacleProxy.totalConnections },
            onlineConsumers: [...((this.relay as unknown as { onlineConsumers: Set<string> }).onlineConsumers ?? [])],
          };
          break;
        default: res.writeHead(404); res.end(); return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(out));
    } catch (err) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: (err as Error).message }));
    }
  }

  /** A pairing QR link for this computer, as `kraki pair` renders it. */
  async trustPairingLink(ageMs = 0): Promise<string> {
    const token = await this.pairingToken();
    const identity = this.keys.getPublicIdentity();
    const params = new URLSearchParams({
      relay: `ws://127.0.0.1:${this.appProxy.port}`, token,
      tid: this.tentacleId, ik: identity.identityKey, xk: identity.encryptionKey,
      ps: createPairingSecret(this.root, Date.now() - Math.max(0, ageMs)),
    });
    return `https://app.kraki.chat/?${params.toString()}`;
  }

  /** A device on the account that never paired (what a compromised Head
   *  can always add) sends a command. */
  async rogueInput(text: string, sessionId: string): Promise<Record<string, unknown>> {
    if (!this.rogue) this.rogue = await connectApp(this.headPort, 'Rogue');
    const clientId = `rogue_${Date.now()}`;
    sendToTentacle(this.rogue, { type: 'send_input', sessionId, deviceId: this.rogue.deviceId, seq: 0,
      timestamp: new Date().toISOString(), payload: { text, clientId } });
    this.log('rogue_input', { sessionId, text });
    return { clientId, rogueId: this.rogue.deviceId };
  }

  /** Another device sends input (like replying from the Mac). */
  async peerInput(text: string, sessionId: string): Promise<Record<string, unknown>> {
    if (!this.peer) this.peer = await connectApp(this.headPort, 'Chaos Mac');
    const clientId = `peer_${Date.now()}`;
    sendToTentacle(this.peer, { type: 'send_input', sessionId, deviceId: this.peer.deviceId, seq: 0,
      timestamp: new Date().toISOString(), payload: { text, clientId } });
    this.log('peer_input', { sessionId, text });
    return { clientId };
  }

  info(): Record<string, unknown> {
    return {
      controlPort: this.controlPort, appPort: this.appProxy.port, app2Port: this.app2Proxy.port, headPort: this.headPort,
      tentaclePort: this.tentacleProxy.port, sessionId: this.sessionId, tentacleId: this.tentacleId,
    };
  }

  async stop(): Promise<void> {
    this.relay?.disconnect();
    await this.stopOldTentacle().catch(() => {});
    this.trustedApps.forEach((app) => app.close());
    this.secondComputer?.relay.disconnect();
    if (this.secondComputer) rmSync(this.secondComputer.root, { recursive: true, force: true });
    this.admin?.close();
    this.peer?.close();
    this.rogue?.close();
    this.legacyApps.forEach((a) => a.close());
    await this.appProxy.close();
    await this.app2Proxy.close();
    await this.tentacleProxy.close();
    await this.stopHead().catch(() => {});
    await new Promise<void>((resolve) => this.control ? this.control.close(() => resolve()) : resolve());
    rmSync(this.root, { recursive: true, force: true });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const i = process.argv.indexOf('--control-port');
  const stack = new ChaosStack();
  await stack.start({ controlPort: i > 0 ? Number(process.argv[i + 1]) : 0 });
  console.log(JSON.stringify(stack.info()));
  const shutdown = async () => { await stack.stop(); process.exit(0); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  setInterval(() => {}, 1 << 30);
}
