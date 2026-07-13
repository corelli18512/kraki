#!/usr/bin/env node
/**
 * Real-stack pulse verification server (test-only, one-shot).
 *
 * A programmatic, headless version of `dev-demo.ts`: boots a REAL head relay +
 * an embedded RealtimeClient (tentacle) driving a MockAdapter, plus a Vite
 * preview of the built web arm — then exposes a tiny HTTP control plane so a
 * Playwright spec can drive the tentacle (emit agent messages, permissions,
 * disconnect/reconnect the relay) while asserting the REAL browser arm's UI.
 *
 * This is the only place that runs `real browser arm ⇄ real head hub ⇄ real
 * tentacle` with pulse frames end-to-end.
 *
 * Isolation: uses a dedicated port block (relay 4700, web 3700, control 4710)
 * far from the other session's stack (3400/4400/3300/5174/5179). Spawns no
 * external daemon and scans no sibling worktrees — it never touches another
 * session's processes. Pre-flights the ports and aborts (does NOT kill) if
 * occupied.
 *
 * Lifecycle: prints `REALSTACK_READY <json>` on stdout once up, then runs until
 * it receives SIGTERM (or a POST /shutdown). The Playwright config starts it as
 * a webServer and tears it down at the end.
 */

import { execSync, spawn, type ChildProcess } from 'node:child_process';
import { createServer as createHttpServer } from 'node:http';
import { mkdtempSync, createWriteStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';

// Import the COMPILED tentacle (dist), not src: tsx's tsconfig-paths resolver
// mishandles the ESM-only `@coinfra/pulse` exports when walking TS source, but
// node resolves it cleanly from the built output (verified). dist is rebuilt in
// main() before this matters.
import { RelayClient, SessionManager, AgentAdapter, KeyManager, AttachmentStore } from '../packages/tentacle/dist/index.js';
import type {
  CreateSessionConfig, SessionInfo, SessionContext, PermissionDecision,
} from '../packages/tentacle/dist/index.js';

// ── Ports (isolated from the other session) ─────────────
const RELAY_PORT = Number(process.env.REALSTACK_RELAY_PORT ?? 4700);
const WEB_PORT = Number(process.env.REALSTACK_WEB_PORT ?? 3700);
const CONTROL_PORT = Number(process.env.REALSTACK_CONTROL_PORT ?? 4710);
const RELAY_URL = `ws://localhost:${RELAY_PORT}`;

/** Pre-seeded session id, created before the browser connects. */
const SEED_SESSION_ID = 'realstack-1';
/** Pre-seeded session with >50 messages (for the range-backfill test). */
const HISTORY_SESSION_ID = 'realstack-history';

// ── Mock adapter (mirrors dev-demo.ts) ──────────────────
class MockAdapter extends AgentAdapter {
  private sessionCounter = 0;
  private sessions = new Map<string, { ended: boolean }>();
  /** Records lifecycle calls so the control plane can assert them. */
  readonly killed: string[] = [];
  /** Records inbound-from-browser calls (over pulse) so the spec can prove the
   *  browser's reliable sends actually reached the tentacle adapter. */
  readonly receivedMessages: Array<{ sid: string; text: string }> = [];
  readonly permissionResponses: Array<{ sid: string; pid: string; decision: string }> = [];
  readonly questionAnswers: Array<{ sid: string; qid: string; answer: string; freeform: boolean }> = [];

  async start() {}
  async stop() {}

  async createSession(config?: CreateSessionConfig): Promise<{ sessionId: string }> {
    const sessionId = config?.sessionId ?? `mock_sess_${++this.sessionCounter}`;
    this.sessions.set(sessionId, { ended: false });
    this.onSessionCreated?.({ sessionId, agent: 'mock-agent', model: 'mock-v1' });
    return { sessionId };
  }
  async resumeSession(sessionId: string, _context?: SessionContext): Promise<{ sessionId: string }> {
    this.sessions.set(sessionId, { ended: false });
    this.onSessionCreated?.({ sessionId, agent: 'mock-agent', model: 'mock-v1' });
    return { sessionId };
  }
  async sendMessage(sid: string, text: string) { this.receivedMessages.push({ sid, text }); }
  async respondToPermission(sid: string, pid: string, d: PermissionDecision) { this.permissionResponses.push({ sid, pid, decision: d }); }
  async respondToQuestion(sid: string, qid: string, answer: string, freeform: boolean) { this.questionAnswers.push({ sid, qid, answer, freeform }); }
  async killSession(sessionId: string) {
    const s = this.sessions.get(sessionId);
    if (s) s.ended = true;
    this.killed.push(sessionId);
    this.onSessionEnded?.(sessionId, { reason: 'stopped' });
  }
  async listSessions(): Promise<SessionInfo[]> {
    return Array.from(this.sessions.entries()).map(([id, s]) => ({
      id, state: s.ended ? 'ended' as const : 'active' as const,
    }));
  }
  async listModels(): Promise<string[]> { return ['mock-v1']; }

  // Simulation helpers (control plane calls these to drive the agent side)
  msg(sid: string, content: string) { this.onMessage?.(sid, { content }); }
  delta(sid: string, content: string) { this.onMessageDelta?.(sid, { content }); }
  perm(sid: string, id: string, tool: string, desc: string) {
    this.onPermissionRequest?.(sid, { id, toolArgs: { toolName: tool, args: {} }, description: desc });
  }
  question(sid: string, id: string, q: string, choices?: string[]) {
    this.onQuestionRequest?.(sid, { id, question: q, choices, allowFreeform: true });
  }
  toolStart(sid: string, tool: string, args: Record<string, unknown> = {}, toolCallId?: string) {
    this.onToolStart?.(sid, { toolName: tool, args, ...(toolCallId && { toolCallId }) });
  }
  toolComplete(sid: string, tool: string, result: string, toolCallId?: string) {
    this.onToolComplete?.(sid, { toolName: tool, result, ...(toolCallId && { toolCallId }) });
  }
  idle(sid: string) { this.onIdle?.(sid); }
  error(sid: string, message: string) { this.onError?.(sid, { message }); }
}

const children: ChildProcess[] = [];
let relay: RelayClient | null = null;
// Second tentacle (same open-auth user) — connected on demand by the presence
// tests to prove device_joined/left/removed reach the browser over pulse.
let relay2: RelayClient | null = null;
let relay2Connected = false;

function fail(msg: string): never {
  console.error(`❌ ${msg}`);
  cleanup();
  process.exit(1);
}

function cleanup() {
  try { relay?.disconnect(); } catch { /* ignore */ }
  try { relay2?.disconnect(); } catch { /* ignore */ }
  for (const c of children) { try { c.kill('SIGTERM'); } catch { /* ignore */ } }
}
process.on('SIGINT', () => { cleanup(); process.exit(0); });
process.on('SIGTERM', () => { cleanup(); process.exit(0); });

/** Abort (do NOT kill) if any of our ports are already taken. */
function preflightPorts(): void {
  for (const p of [RELAY_PORT, WEB_PORT, CONTROL_PORT]) {
    try {
      const out = execSync(`lsof -tiTCP:${p} -sTCP:LISTEN 2>/dev/null`, { encoding: 'utf8' }).trim();
      if (out) fail(`port ${p} is already in use (pid ${out}). Refusing to kill it — free it or change REALSTACK_*_PORT.`);
    } catch { /* lsof non-zero = nothing listening = good */ }
  }
}

function waitForRelay(url: string, timeout = 20_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error('relay did not start in time')), timeout);
    const attempt = () => {
      const ws = new WebSocket(url);
      ws.on('open', () => { ws.close(); clearTimeout(deadline); resolve(); });
      ws.on('error', () => { setTimeout(attempt, 400); });
    };
    attempt();
  });
}

function requestPairingToken(relayUrl: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(relayUrl);
    const t = setTimeout(() => { ws.close(); reject(new Error('pairing token timed out')); }, 10_000);
    ws.on('open', () => ws.send(JSON.stringify({ type: 'request_pairing_token', token: 'dev' })));
    ws.on('message', (data) => {
      let m: { type?: string; token?: string; message?: string };
      try { m = JSON.parse(data.toString()); } catch { return; }
      if (m.type === 'pairing_token_created') { clearTimeout(t); resolve(m.token!); ws.close(); }
      if (m.type === 'auth_error' || m.type === 'server_error') { clearTimeout(t); reject(new Error(m.message)); ws.close(); }
    });
    ws.on('error', (err) => { clearTimeout(t); reject(err); });
  });
}

/** Bring up a SECOND tentacle (same open-auth user `local`). The head then
 *  broadcasts `device_joined` to the already-connected browser over pulse — the
 *  live presence path that the arm regression broke. Lazily constructed on first
 *  connect; reconnects reuse the same RelayClient so the deviceId is stable
 *  (a real tentacle persists its id; this keeps device_left/removed coherent). */
async function connectTentacle2(): Promise<void> {
  if (relay2Connected) return;
  if (!relay2) {
    const adapter2 = new MockAdapter();
    const sm2 = new SessionManager(mkdtempSync(join(tmpdir(), 'kraki-realstack-sess2-')));
    const km2 = new KeyManager(mkdtempSync(join(tmpdir(), 'kraki-realstack-keys2-')));
    relay2 = new RelayClient(adapter2 as unknown as AgentAdapter, sm2, {
      relayUrl: RELAY_URL,
      // Stable deviceId so reconnects reuse the SAME device row (open-auth honors
      // a supplied deviceId, server.ts:1228). Without this, each reconnect mints a
      // fresh dev_<random> and the browser accumulates stale offline duplicates.
      device: { deviceId: 'realstack-tentacle-2', name: 'RealStack Tentacle 2', role: 'tentacle', kind: 'desktop' },
    }, km2);
  }
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('tentacle2 auth timed out')), 15_000);
    relay2!.onAuthenticated = () => { clearTimeout(t); relay2Connected = true; resolve(); };
    relay2!.onFatalError = (m: string) => { clearTimeout(t); reject(new Error(`tentacle2 auth failed: ${m}`)); };
    relay2!.connect();
  });
}

/** Drop the second tentacle's link → head broadcasts `device_left` to the browser. */
function disconnectTentacle2(): void {
  try { relay2?.disconnect(); } catch { /* ignore */ }
  relay2Connected = false;
}

async function main(): Promise<void> {
  preflightPorts();

  console.log('🔨 Building protocol + crypto + arm...');
  execSync('pnpm --filter @kraki/protocol build && pnpm --filter @kraki/crypto build', { stdio: 'inherit', cwd: process.cwd() });
  execSync('pnpm --filter @kraki/arm-web build', { stdio: 'inherit', cwd: process.cwd() });

  // 1. Real head relay
  const headLog = createWriteStream(join(tmpdir(), 'kraki-realstack-head.log'), { flags: 'w' });
  const head = spawn('pnpm', ['exec', 'tsx', 'packages/head/src/cli.ts', '--port', String(RELAY_PORT), '--db', join(mkdtempSync(join(tmpdir(), 'kraki-realstack-db-')), 'head.db')], {
    cwd: process.cwd(),
    env: { ...process.env, AUTH_MODE: 'open', E2E_MODE: 'true', PAIRING_ENABLED: 'true', LOG_LEVEL: 'info' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  head.stdout!.pipe(headLog); head.stderr!.pipe(headLog);
  children.push(head);
  await waitForRelay(RELAY_URL);

  // 2. Embedded tentacle (MockAdapter + RelayClient)
  const adapter = new MockAdapter();
  const sm = new SessionManager(mkdtempSync(join(tmpdir(), 'kraki-realstack-sess-')));
  // A real KeyManager is REQUIRED: without it RelayClient.sendUnicastTo()
  // early-returns, so the tentacle silently never sends session_list / greeting
  // / replay to apps — the browser would pair but see no sessions. dev-demo gets
  // away without one only because a human never relies on that sync path.
  const keyManager = new KeyManager(mkdtempSync(join(tmpdir(), 'kraki-realstack-keys-')));
  // AttachmentStore: with it, the tentacle offloads tool results (and any large
  // args) to a ContentRef the browser pulls on demand — this is what exercises
  // the request_attachment pulse path in the browser (Stage 4).
  const attachmentStore = new AttachmentStore(mkdtempSync(join(tmpdir(), 'kraki-realstack-att-')));
  relay = new RelayClient(adapter as unknown as AgentAdapter, sm, {
    relayUrl: RELAY_URL,
    device: { name: 'RealStack Tentacle', role: 'tentacle', kind: 'desktop' },
  }, keyManager, attachmentStore);
  await new Promise<void>((resolve, reject) => {
    relay!.onAuthenticated = () => resolve();
    relay!.onFatalError = (m: string) => reject(new Error(`tentacle auth failed: ${m}`));
    relay!.connect();
  });

  // 2b. Pre-seed the session BEFORE the browser connects (mirrors dev-demo).
  //     When the browser later pairs, the tentacle's device_joined handler
  //     sends it the session_list, so the session is reliably present — no
  //     race with a live session_created broadcast. A welcome message + idle
  //     make it look like a real, ready session.
  await adapter.createSession({ sessionId: SEED_SESSION_ID });
  adapter.msg(SEED_SESSION_ID, 'Session ready. Ask me anything.');
  adapter.idle(SEED_SESSION_ID);

  // 2c. Pre-seed a HISTORY session with >50 messages BEFORE the browser connects.
  //     The browser learns of it via session_list (lastSeq), but has none of the
  //     bodies cached — so opening it fires request_session_messages_range over
  //     pulse to backfill the last 50. (Seeded pre-pair so the bodies never arrive
  //     live; the ONLY way the browser gets them is the range request.)
  await adapter.createSession({ sessionId: HISTORY_SESSION_ID });
  for (let i = 1; i <= 60; i++) adapter.msg(HISTORY_SESSION_ID, `history line ${i} of 60`);
  adapter.idle(HISTORY_SESSION_ID);

  // 3. Built arm served via vite preview
  const web = spawn('pnpm', ['--filter', '@kraki/arm-web', 'preview', '--port', String(WEB_PORT), '--strictPort'], {
    cwd: process.cwd(),
    env: { ...process.env, VITE_WS_URL: RELAY_URL },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(web);
  await new Promise<void>((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error('vite preview did not start')), 30_000);
    web.stdout!.on('data', (c: Buffer) => { if (c.toString().includes(String(WEB_PORT))) { clearTimeout(deadline); resolve(); } });
  });

  // 4. HTTP control plane for the spec
  const control = createHttpServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://localhost:${CONTROL_PORT}`);
    const q = url.searchParams;
    const json = (code: number, body: unknown) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    try {
      switch (url.pathname) {
        case '/token': return json(200, { token: await requestPairingToken(RELAY_URL), relay: RELAY_URL, web: `http://localhost:${WEB_PORT}`, sessionId: SEED_SESSION_ID });
        case '/createSession': { const { sessionId } = await adapter.createSession({ sessionId: q.get('id') ?? undefined }); return json(200, { sessionId }); }
        // ── agent-side simulation (inbound to browser, over pulse) ──
        case '/msg': adapter.msg(q.get('sid')!, q.get('text') ?? 'hello'); return json(200, { ok: true });
        case '/delta': adapter.delta(q.get('sid')!, q.get('text') ?? '...'); return json(200, { ok: true });
        case '/perm': adapter.perm(q.get('sid')!, q.get('id') ?? 'perm-1', q.get('tool') ?? 'shell', q.get('desc') ?? 'run a command'); return json(200, { ok: true });
        case '/question': adapter.question(q.get('sid')!, q.get('id') ?? 'q-1', q.get('text') ?? 'which one?', q.get('choices') ? q.get('choices')!.split('|') : undefined); return json(200, { ok: true });
        case '/toolStart': adapter.toolStart(q.get('sid')!, q.get('tool') ?? 'bash', q.get('cmd') ? { command: q.get('cmd')! } : {}); return json(200, { ok: true });
        case '/toolComplete': adapter.toolComplete(q.get('sid')!, q.get('tool') ?? 'bash', q.get('result') ?? 'done'); return json(200, { ok: true });
        case '/idle': adapter.idle(q.get('sid')!); return json(200, { ok: true });
        case '/error': adapter.error(q.get('sid')!, q.get('message') ?? 'error'); return json(200, { ok: true });
        // Legacy-history compatibility: inject the old durable Abort message
        // through RelayClient's real persistence + pulse broadcast path. The UI
        // must normalize it to the modern frozen LiveAgentBubble renderer.
        case '/legacyInterrupted': {
          const sid = q.get('sid')!;
          const interruptedAt = new Date().toISOString();
          const reason = q.get('reason') === 'process_lost' ? 'process_lost' : 'user_aborted';
          (relay as unknown as { send: (msg: Record<string, unknown>) => void }).send({
            type: 'interrupted_turn',
            sessionId: sid,
            payload: {
              reason,
              draft: q.get('draft') ?? 'Legacy streamed draft',
              action: {
                type: 'tool_start',
                payload: { toolName: 'bash', headline: 'npm test', toolCallId: 'legacy-tool-1' },
              },
              interruptedAt,
              cancelled: true,
              steps: 1,
            },
          });
          return json(200, { ok: true });
        }
        // ── debug: what does the tentacle see? ──
        case '/debug': {
          const r = relay as unknown as { consumerKeys?: Map<string, string>; onlineConsumers?: Set<string> };
          return json(200, {
            sessions: sm.getSessionList(),
            consumerKeys: r.consumerKeys ? Array.from(r.consumerKeys.keys()) : 'n/a',
            onlineConsumers: r.onlineConsumers ? Array.from(r.onlineConsumers) : 'n/a',
          });
        }
        // ── tentacle link control ──
        case '/tentacle/disconnect': relay!.disconnect(); return json(200, { ok: true });
        case '/tentacle/connect': relay!.connect(); return json(200, { ok: true });
        // ── seed a session as READ on the tentacle (readSeq = lastSeq), so a
        //    subsequent UI "Mark unread" produces an observable readSeq rollback. ──
        case '/read': {
          const sid = q.get('sid')!;
          const meta = sm.getMeta(sid);
          if (meta) sm.markRead(sid, meta.lastSeq);
          return json(200, { ok: true, readSeq: sm.getMeta(sid)?.readSeq, lastSeq: meta?.lastSeq });
        }
        // ── second tentacle (presence: device_joined/left over pulse) ──
        case '/tentacle2/connect': await connectTentacle2(); return json(200, { ok: true, name: 'RealStack Tentacle 2' });
        case '/tentacle2/disconnect': disconnectTentacle2(); return json(200, { ok: true });
        // ── seed a long agent_message history so opening the session leaves
        //    older messages uncached → the browser fires request_session_messages_range ──
        case '/seedHistory': {
          const sid = q.get('sid')!;
          const n = Number(q.get('n') ?? '60');
          for (let i = 1; i <= n; i++) adapter.msg(sid, `history line ${i} of ${n}`);
          adapter.idle(sid);
          return json(200, { ok: true, seeded: n });
        }
        // ── drive a tool_complete whose result is offloaded to a ContentRef the
        //    browser pulls (request_attachment). The AttachmentStore is wired, so
        //    offloadResult() creates the ref automatically from a long result. ──
        case '/toolRef': {
          const sid = q.get('sid')!;
          const tool = q.get('tool') ?? 'bash';
          const result = q.get('result') ?? ('X'.repeat(4096)); // large → offloaded
          // A stable toolCallId lets the tentacle stash args at tool_start and reuse
          // them (headline + argsRef) at tool_complete — matching a real agent.
          const tcid = `tc-${q.get('sid')}-${q.get('cmd') ?? 'x'}`;
          adapter.toolStart(sid, tool, q.get('cmd') ? { command: q.get('cmd')! } : {}, tcid);
          adapter.toolComplete(sid, tool, result, tcid);
          adapter.idle(sid);
          // Diagnostic: confirm the tentacle offloaded the result to the store.
          let stored = 0;
          try {
            const { readdirSync } = await import('node:fs');
            const dir = join(attachmentStore['sessionsDir'] as string, sid, 'attachments');
            stored = readdirSync(dir).filter((f) => f.endsWith('.json')).length;
          } catch { /* dir may not exist */ }
          return json(200, { ok: true, stored });
        }
        case '/debug2': {
          const r2 = relay2 as unknown as { authInfo?: { deviceId?: string } } | null;
          return json(200, { connected: relay2Connected, deviceId: r2?.authInfo?.deviceId ?? null });
        }
        // ── read-back (outbound-from-browser proof + lifecycle) ──
        case '/received': return json(200, { messages: adapter.receivedMessages });
        case '/permResponses': return json(200, { responses: adapter.permissionResponses });
        case '/answers': return json(200, { answers: adapter.questionAnswers });
        case '/killed': return json(200, { killed: adapter.killed });
        case '/shutdown': json(200, { ok: true }); cleanup(); process.exit(0); return;
        default: return json(404, { error: 'unknown control endpoint' });
      }
    } catch (err) { json(500, { error: (err as Error).message }); }
  });
  await new Promise<void>((resolve) => control.listen(CONTROL_PORT, resolve));

  // 5. Signal ready (Playwright's webServer waits for this port)
  console.log(`REALSTACK_READY ${JSON.stringify({ relay: RELAY_URL, web: `http://localhost:${WEB_PORT}`, control: `http://localhost:${CONTROL_PORT}` })}`);
}

main().catch((err) => fail((err as Error).message));
