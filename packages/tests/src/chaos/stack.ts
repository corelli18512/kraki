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
import { SessionManager, RelayClient, KeyManager, AttachmentStore } from '@kraki/tentacle';
import { randomBytes } from 'node:crypto';
import { WebSocket } from 'ws';
import { ChaosProxy, type FaultProfile } from './proxy.js';
import { ScriptedAdapter } from './scripted-adapter.js';
import { connectApp, type MockApp } from '../helpers.js';

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
    }, this.keys, this.attachments);
    this.relay.onStateChange = (state) => this.log('tentacle_state', { state });
    this.relay.onAuthenticated = (info) => {
      if (!this.tentacleDeviceId) this.tentacleDeviceId = info.deviceId;
      device.deviceId = this.tentacleDeviceId;
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

  get tentacleId(): string { return this.relay.getAuthInfo()?.deviceId ?? ''; }

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
    const received = Object.fromEntries(this.adapter.received.get(sessionId) ?? []);
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
        case 'POST /session': out = { sessionId: await this.createSession() }; break;
        case 'POST /pairing-token': out = { token: await this.pairingToken() }; break;
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
            e2e: this.relay?.e2eStats,
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

  info(): Record<string, unknown> {
    return {
      controlPort: this.controlPort, appPort: this.appProxy.port, app2Port: this.app2Proxy.port, headPort: this.headPort,
      tentaclePort: this.tentacleProxy.port, sessionId: this.sessionId, tentacleId: this.tentacleId,
    };
  }

  async stop(): Promise<void> {
    this.relay?.disconnect();
    this.admin?.close();
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
