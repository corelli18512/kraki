/**
 * Mock local development orchestrator.
 *
 * One command to start:
 *   1. Head relay (open auth, port 4000)
 *   2. Mock tentacle with interactive REPL
 *   3. Vite web app pointed at local relay
 *   4. Auto-opens Chrome
 *
 * Usage: pnpm dev:demo
 */

import { spawn, execSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, createWriteStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { createServer as createHttpServer } from 'node:http';
import { WebSocket } from 'ws';

import { RelayClient } from '../packages/tentacle/src/relay-client.js';
import { SessionManager } from '../packages/tentacle/src/session-manager.js';
import { AgentAdapter } from '../packages/tentacle/src/adapters/base.js';
import type {
  CreateSessionConfig,
  SessionInfo,
  SessionContext,
  PermissionDecision,
} from '../packages/tentacle/src/adapters/base.js';

// ── Mock adapter ────────────────────────────────────────

class MockAdapter extends AgentAdapter {
  private sessionCounter = 0;
  private sessions = new Map<string, { ended: boolean }>();

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

  async sendMessage(_sid: string, _text: string) {}
  async respondToPermission(_sid: string, _pid: string, _d: PermissionDecision) {}
  async respondToQuestion(_sid: string, _qid: string, _a: string, _f: boolean) {}

  async killSession(sessionId: string) {
    const s = this.sessions.get(sessionId);
    if (s) s.ended = true;
    this.onSessionEnded?.(sessionId, { reason: 'stopped' });
  }

  async listSessions(): Promise<SessionInfo[]> {
    return Array.from(this.sessions.entries()).map(([id, s]) => ({
      id, state: s.ended ? 'ended' as const : 'active' as const,
    }));
  }

  async listModels(): Promise<string[]> { return ['mock-v1']; }

  // Simulation helpers
  msg(sid: string, content: string) { this.onMessage?.(sid, { content }); }
  delta(sid: string, content: string) { this.onMessageDelta?.(sid, { content }); }
  perm(sid: string, id: string, tool: string, desc: string) {
    this.onPermissionRequest?.(sid, { id, toolArgs: { toolName: tool, args: {} }, description: desc });
  }
  question(sid: string, id: string, q: string, choices?: string[]) {
    this.onQuestionRequest?.(sid, { id, question: q, choices, allowFreeform: true });
  }
  toolStart(sid: string, tool: string, args: Record<string, unknown> = {}) {
    this.onToolStart?.(sid, { toolName: tool, args });
  }
  toolEnd(sid: string, tool: string, result: string) {
    this.onToolComplete?.(sid, { toolName: tool, result });
  }
  idle(sid: string) { this.onIdle?.(sid); }
  error(sid: string, message: string) { this.onError?.(sid, { message }); }
}

// ── Helpers ─────────────────────────────────────────────

const RELAY_PORT = 4000;
const RELAY_URL = `ws://localhost:${RELAY_PORT}`;
const children: ChildProcess[] = [];

function cleanup() {
  for (const child of children) {
    try { child.kill('SIGTERM'); } catch {}
  }
}

process.on('SIGINT', () => { cleanup(); process.exit(0); });
process.on('SIGTERM', () => { cleanup(); process.exit(0); });

function waitForRelay(url: string, timeout = 15_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error('Relay did not start in time')), timeout);
    const attempt = () => {
      const ws = new WebSocket(url);
      ws.on('open', () => { ws.close(); clearTimeout(deadline); resolve(); });
      ws.on('error', () => { setTimeout(attempt, 500); });
    };
    attempt();
  });
}

function requestPairingToken(relayUrl: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(relayUrl);
    const timeout = setTimeout(() => { ws.close(); reject(new Error('Pairing token request timed out')); }, 10_000);
    ws.on('open', () => { ws.send(JSON.stringify({ type: 'request_pairing_token', token: 'dev' })); });
    ws.on('message', (data) => {
      let msg: any;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      if (msg.type === 'pairing_token_created') { clearTimeout(timeout); resolve(msg.token); ws.close(); }
      if (msg.type === 'auth_error' || msg.type === 'server_error') { clearTimeout(timeout); reject(new Error(msg.message)); ws.close(); }
    });
    ws.on('error', (err) => { clearTimeout(timeout); reject(err); });
  });
}

// ── Main ────────────────────────────────────────────────

async function main(): Promise<void> {
  // 1. Build prerequisites
  console.log('🔨 Building protocol + crypto...');
  execSync('pnpm --filter @kraki/protocol build && pnpm --filter @kraki/crypto build', {
    stdio: 'inherit', cwd: process.cwd(),
  });

  // 2. Start head relay (open auth, no GitHub token needed)
  //    Logs go to a file to keep the REPL clean.
  const logPath = join(tmpdir(), 'kraki-dev-head.log');
  console.log(`🦑 Starting local relay on port ${RELAY_PORT} (logs → ${logPath})`);
  const head = spawn('pnpm', ['exec', 'tsx', 'packages/head/src/cli.ts', '--port', String(RELAY_PORT)], {
    stdio: ['ignore', 'pipe', 'pipe'],
    cwd: process.cwd(),
    env: { ...process.env, AUTH_MODE: 'open', E2E_MODE: 'false', PAIRING_ENABLED: 'true', LOG_LEVEL: 'info' },
  });
  children.push(head);
  const logStream = createWriteStream(logPath);
  head.stdout!.pipe(logStream);
  head.stderr!.pipe(logStream);

  await waitForRelay(RELAY_URL);
  console.log('✅ Relay is up\n');

  // 3. Connect mock tentacle
  console.log('🐙 Connecting mock tentacle...');
  const adapter = new MockAdapter();
  const sessDir = mkdtempSync(join(tmpdir(), 'kraki-mock-'));
  const sm = new SessionManager(sessDir);
  const relay = new RelayClient(adapter as unknown as AgentAdapter, sm, {
    relayUrl: RELAY_URL,
    device: { name: 'Mock Tentacle', role: 'tentacle', kind: 'desktop' },
  });

  await new Promise<void>((resolve, reject) => {
    relay.onAuthenticated = () => resolve();
    relay.onFatalError = (msg: string) => reject(new Error(`Auth failed: ${msg}`));
    relay.connect();
  });
  console.log('✅ Mock tentacle connected\n');

  // 4. Create a default session
  const { sessionId } = await adapter.createSession({ sessionId: 'demo' });
  console.log(`📋 Session created: ${sessionId}`);

  // Send a welcome message
  adapter.msg(sessionId, 'Mock tentacle connected. Waiting for input from REPL...');
  adapter.idle(sessionId);

  // 5. Start auth redirect server (must be before Vite so env var is ready)
  //    Every visit gets a fresh pairing token so page refresh always works.
  const REDIRECT_PORT = 3100;
  const redirectServer = createHttpServer(async (_req, res) => {
    try {
      const token = await requestPairingToken(RELAY_URL);
      const params = new URLSearchParams({ relay: RELAY_URL, token });
      res.writeHead(302, { Location: `http://localhost:${vitePort}?${params.toString()}` });
      res.end();
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end(`Failed to get pairing token: ${(err as Error).message}`);
    }
  });
  await new Promise<void>(resolve => redirectServer.listen(REDIRECT_PORT, resolve));

  // 6. Start Vite web app (with dev redirect middleware)
  let vitePort = '3000';
  console.log('\n🌐 Starting web dev server...');
  const vite = spawn('pnpm', ['--filter', '@kraki/arm-web', 'dev'], {
    stdio: ['ignore', 'pipe', 'inherit'],
    cwd: process.cwd(),
    env: { ...process.env, VITE_WS_URL: RELAY_URL, KRAKI_DEV_AUTH_PORT: String(REDIRECT_PORT) },
  });
  children.push(vite);

  // Detect Vite port
  await new Promise<void>((resolve) => {
    vite.stdout!.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      process.stdout.write(text);
      const match = text.match(/Local:\s+http:\/\/localhost:(\d+)/);
      if (match) { vitePort = match[1]; resolve(); }
    });
  });

  const entryUrl = `http://localhost:${REDIRECT_PORT}`;
  console.log(`\n🔑 Dev entry point: ${entryUrl} (generates fresh token on every visit/refresh)`);
  console.log(`   Vite direct: http://localhost:${vitePort}\n`);
  try { execSync(`open -a "Google Chrome" "${entryUrl}"`); } catch { execSync(`open "${entryUrl}"`); }

  // 6. Interactive REPL
  console.log('\n─── Mock Tentacle REPL ───────────────────────');
  console.log('Commands:');
  console.log('  <text>                Send agent message');
  console.log('  /delta <text>         Send streaming delta');
  console.log('  /perm <tool> <desc>   Send permission request');
  console.log('  /question <text>      Send question');
  console.log('  /tool <name>          Simulate tool start');
  console.log('  /toolend <name> <res> Simulate tool complete');
  console.log('  /idle                 Signal idle');
  console.log('  /error <text>         Send error');
  console.log('  /session              Create new session');
  console.log('  /logs                 Tail relay logs');
  console.log('  /quit                 Exit');
  console.log('──────────────────────────────────────────────\n');

  let currentSession = sessionId;
  let permCounter = 0;
  let questionCounter = 0;

  const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: 'mock> ' });
  rl.prompt();

  rl.on('line', async (line) => {
    const input = line.trim();
    if (!input) { rl.prompt(); return; }

    try {
      if (input === '/quit') {
        cleanup();
        relay.disconnect();
        process.exit(0);
      } else if (input === '/logs') {
        try {
          const tail = execSync(`tail -30 "${logPath}"`, { encoding: 'utf8' });
          console.log(`\n── Last 30 lines of relay log (${logPath}) ──\n${tail}──────────────────────────────────────────────`);
        } catch { console.log('  ✗ Could not read log file'); }
      } else if (input === '/idle') {
        adapter.idle(currentSession);
        console.log('  → idle');
      } else if (input.startsWith('/error ')) {
        adapter.error(currentSession, input.slice(7));
        console.log('  → error sent');
      } else if (input.startsWith('/delta ')) {
        adapter.delta(currentSession, input.slice(7));
        console.log('  → delta sent');
      } else if (input.startsWith('/perm ')) {
        const parts = input.slice(6).split(' ');
        const tool = parts[0];
        const desc = parts.slice(1).join(' ') || `Run ${tool}?`;
        adapter.perm(currentSession, `perm_${++permCounter}`, tool, desc);
        console.log(`  → permission request: ${tool}`);
      } else if (input.startsWith('/question ')) {
        adapter.question(currentSession, `q_${++questionCounter}`, input.slice(10));
        console.log('  → question sent');
      } else if (input.startsWith('/tool ')) {
        adapter.toolStart(currentSession, input.slice(6));
        console.log(`  → tool start: ${input.slice(6)}`);
      } else if (input.startsWith('/toolend ')) {
        const parts = input.slice(9).split(' ');
        adapter.toolEnd(currentSession, parts[0], parts.slice(1).join(' ') || 'done');
        console.log(`  → tool complete: ${parts[0]}`);
      } else if (input === '/session') {
        const s = await adapter.createSession();
        currentSession = s.sessionId;
        adapter.msg(currentSession, 'New session started.');
        adapter.idle(currentSession);
        console.log(`  → new session: ${currentSession}`);
      } else {
        // Plain text → agent message
        adapter.msg(currentSession, input);
        adapter.idle(currentSession);
      }
    } catch (err) {
      console.error(`  ✗ ${(err as Error).message}`);
    }
    rl.prompt();
  });

  rl.on('close', () => { cleanup(); relay.disconnect(); process.exit(0); });
}

main().catch((err) => {
  console.error(`❌ ${err.message}`);
  cleanup();
  process.exit(1);
});
