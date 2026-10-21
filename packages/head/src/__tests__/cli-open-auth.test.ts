/**
 * Runs the real cli.ts to check how a self-hosted Head binds and how `open`
 * auth honours OPEN_SHARED_KEY on both the auth and the pairing paths.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import { networkInterfaces, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { WebSocket } from 'ws';

const HEAD_DIR = resolve(__dirname, '..', '..');
const TSX = join(HEAD_DIR, 'node_modules', '.bin', 'tsx');
const CLI = join(HEAD_DIR, 'src', 'cli.ts');

interface RunningHead {
  child: ChildProcess;
  port: number;
  output: () => string;
  exited: Promise<number | null>;
}

const running: ChildProcess[] = [];
const tmpDirs: string[] = [];

afterEach(() => {
  for (const child of running.splice(0)) child.kill('SIGKILL');
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as AddressInfo;
      srv.close(() => resolvePort(port));
    });
  });
}

async function startHead(args: string[], env: Record<string, string> = {}): Promise<RunningHead> {
  const port = await freePort();
  const dir = mkdtempSync(join(tmpdir(), 'kraki-head-cli-'));
  tmpDirs.push(dir);
  const cleanEnv: NodeJS.ProcessEnv = { ...process.env };
  for (const key of ['HOST', 'OPEN_SHARED_KEY', 'AUTH_MODE', 'API_KEY', 'HEAD_MODE', 'MODE', 'ACCOUNT_URL', 'SERVICE_KEY', 'PUSH_PROVIDERS', 'VOICE_LEASE_ENABLED', 'REGION', 'PUBLIC_RELAY_URL']) {
    // Empty rather than deleted: cli.ts loads packages/head/.env, and dotenv fills only unset keys.
    cleanEnv[key] = '';
  }
  const child = spawn(TSX, [CLI, '--port', String(port), '--db', join(dir, 'head.db'), ...args], {
    cwd: dir,
    env: { ...cleanEnv, LOG_LEVEL: 'info', VOICE_LEASE_DIR: dir, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  running.push(child);
  let out = '';
  child.stdout?.on('data', (d) => { out += d.toString(); });
  child.stderr?.on('data', (d) => { out += d.toString(); });
  const exited = new Promise<number | null>((resolveExit) => child.once('exit', (code) => resolveExit(code)));
  return { child, port, output: () => out, exited };
}

async function waitForListening(head: RunningHead): Promise<string> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const line = head.output().split('\n').find((l) => l.includes('Kraki Head listening'));
    if (line) return line;
    if (head.child.exitCode !== null) throw new Error(`head exited early:\n${head.output()}`);
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`head did not start:\n${head.output()}`);
}

/** Send one message on a fresh connection and return the first reply. */
async function exchange(host: string, port: number, msg: unknown): Promise<Record<string, unknown>> {
  return new Promise((resolveMsg, reject) => {
    const ws = new WebSocket(`ws://${host}:${port}`);
    const timer = setTimeout(() => { ws.terminate(); reject(new Error('no reply')); }, 5_000);
    ws.on('open', () => ws.send(JSON.stringify(msg)));
    ws.on('message', (data) => {
      const parsed = JSON.parse(data.toString()) as Record<string, unknown>;
      // Skip pulse traffic; the first plain reply is the answer.
      if (typeof parsed.pulse === 'string') return;
      clearTimeout(timer);
      ws.close();
      resolveMsg(parsed);
    });
    ws.on('error', (err) => { clearTimeout(timer); reject(err); });
  });
}

function openAuth(sharedKey?: string) {
  return {
    type: 'auth',
    auth: sharedKey === undefined ? { method: 'open' } : { method: 'open', sharedKey },
    device: { name: 'Test computer', role: 'tentacle' },
  };
}

function lanAddress(): string | undefined {
  for (const list of Object.values(networkInterfaces())) {
    for (const addr of list ?? []) {
      if (addr.family === 'IPv4' && !addr.internal) return addr.address;
    }
  }
  return undefined;
}

async function connectRefused(host: string, port: number): Promise<boolean> {
  return new Promise((resolveRefused) => {
    const ws = new WebSocket(`ws://${host}:${port}`);
    ws.on('open', () => { ws.close(); resolveRefused(false); });
    ws.on('error', () => resolveRefused(true));
  });
}

describe('kraki-relay bind and open auth (cli.ts)', () => {
  it('listens on 127.0.0.1 by default in open mode without a shared key', async () => {
    const head = await startHead([]);
    const line = await waitForListening(head);
    expect(line).toContain('127.0.0.1');
    // Old tentacles in the default setup still connect over loopback without a key.
    expect((await exchange('127.0.0.1', head.port, openAuth())).type).toBe('auth_ok');
    expect((await exchange('127.0.0.1', head.port, { type: 'request_pairing_token', token: 'dev' })).type).toBe('pairing_token_created');
    const lan = lanAddress();
    if (lan) expect(await connectRefused(lan, head.port)).toBe(true);
  }, 30_000);

  it.each([
    ['--host flag', ['--host', '0.0.0.0'], {}],
    ['HOST env', [], { HOST: '0.0.0.0' }],
  ])('refuses a non-loopback host in open mode without a shared key (%s)', async (_label, args, env) => {
    const head = await startHead(args as string[], env as Record<string, string>);
    expect(await head.exited).toBe(1);
    expect(head.output()).toContain('Refusing to listen on 0.0.0.0');
    expect(head.output()).toContain('OPEN_SHARED_KEY');
  }, 30_000);

  it('enforces OPEN_SHARED_KEY on open auth and on pairing requests', async () => {
    const head = await startHead(['--host', '0.0.0.0'], { OPEN_SHARED_KEY: 'correct-horse-battery' });
    await waitForListening(head);

    expect((await exchange('127.0.0.1', head.port, openAuth())).type).toBe('auth_error');
    expect((await exchange('127.0.0.1', head.port, openAuth('wrong'))).type).toBe('auth_error');
    expect((await exchange('127.0.0.1', head.port, openAuth('correct-horse-battery'))).type).toBe('auth_ok');

    expect((await exchange('127.0.0.1', head.port, { type: 'request_pairing_token', token: 'dev' })).type).toBe('auth_error');
    const paired = await exchange('127.0.0.1', head.port, { type: 'request_pairing_token', token: 'correct-horse-battery' });
    expect(paired.type).toBe('pairing_token_created');
  }, 30_000);

  it('keeps the all-interfaces bind for non-open auth modes', async () => {
    const head = await startHead(['--auth', 'apikey'], { API_KEY: 'k' });
    const line = await waitForListening(head);
    expect(line).toContain('(all interfaces)');
  }, 30_000);
});
