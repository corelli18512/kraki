/**
 * Runs the real cli.ts with TEST_ACCOUNTS: a malformed list stops the relay
 * at start, a valid one serves POST /api/test-login without logging tokens.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const HEAD_DIR = resolve(__dirname, '..', '..');
const TSX = join(HEAD_DIR, 'node_modules', '.bin', 'tsx');
const CLI = join(HEAD_DIR, 'src', 'cli.ts');

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

async function startHead(env: Record<string, string>) {
  const port = await freePort();
  const dir = mkdtempSync(join(tmpdir(), 'kraki-head-test-accounts-'));
  tmpDirs.push(dir);
  const cleanEnv: NodeJS.ProcessEnv = { ...process.env };
  for (const key of ['HOST', 'KRAKI_HOST', 'OPEN_SHARED_KEY', 'AUTH_MODE', 'API_KEY', 'HEAD_MODE', 'MODE', 'ACCOUNT_URL',
    'SERVICE_KEY', 'PUSH_PROVIDERS', 'VOICE_LEASE_ENABLED', 'REGION', 'PUBLIC_RELAY_URL', 'TEST_ACCOUNTS',
    'DEFAULT_SIGNUP_REGION', 'TEST_LOGIN_APP_URL']) {
    // Empty rather than deleted: cli.ts loads packages/head/.env, and dotenv fills only unset keys.
    cleanEnv[key] = '';
  }
  const child = spawn(TSX, [CLI, '--port', String(port), '--db', join(dir, 'head.db')], {
    cwd: dir,
    env: { ...cleanEnv, LOG_LEVEL: 'debug', VOICE_LEASE_DIR: dir, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  running.push(child);
  let out = '';
  child.stdout?.on('data', (d) => { out += d.toString(); });
  child.stderr?.on('data', (d) => { out += d.toString(); });
  const exited = new Promise<number | null>((resolveExit) => child.once('exit', (code) => resolveExit(code)));
  return { child, port, output: () => out, exited };
}

async function waitForListening(head: Awaited<ReturnType<typeof startHead>>): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (head.output().includes('Kraki Head listening')) return;
    if (head.child.exitCode !== null) throw new Error(`head exited early:\n${head.output()}`);
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`head did not start:\n${head.output()}`);
}

describe('kraki-relay TEST_ACCOUNTS (cli.ts)', () => {
  it('refuses to start with a test account login that is not qa-', async () => {
    const head = await startHead({
      AUTH_MODE: 'github',
      TEST_ACCOUNTS: JSON.stringify([{ login: 'octocat', region: 'us', tokenSha256: 'a'.repeat(64) }]),
    });
    expect(await head.exited).toBe(1);
    expect(head.output()).toMatch(/TEST_ACCOUNTS\[0\]\.login must start with "qa-"/);
  }, 30_000);

  it('serves /api/test-login for the configured account, without logging the token', async () => {
    const token = randomBytes(32).toString('base64url');
    const head = await startHead({
      AUTH_MODE: 'github',
      REGION: 'us',
      PUBLIC_RELAY_URL: 'wss://relay.example.com',
      TEST_ACCOUNTS: JSON.stringify([
        { login: 'qa-us', region: 'us', tokenSha256: createHash('sha256').update(token).digest('hex') },
      ]),
      TEST_LOGIN_APP_URL: 'https://app.example.com',
    });
    await waitForListening(head);

    const post = (body: unknown) => fetch(`http://127.0.0.1:${head.port}/api/test-login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    expect((await post({ token: 'not-the-token' })).status).toBe(401);
    const res = await post({ token });
    expect(res.status).toBe(200);
    const data = await res.json() as Record<string, unknown>;
    expect(data).toMatchObject({ userId: 'test:qa-us', region: 'us', relayUrl: 'wss://relay.example.com' });
    expect(String(data.pairingUrl)).toMatch(/^https:\/\/app\.example\.com\?relay=wss%3A%2F%2Frelay\.example\.com&token=pt_/);

    // auth_info does not offer the test accounts to anyone.
    const config = await (await fetch(`http://127.0.0.1:${head.port}/api/config`)).json() as { methods: string[] };
    expect(config.methods).not.toContain('apikey');

    await new Promise((r) => setTimeout(r, 100));
    expect(head.output()).toContain('Test accounts enabled');
    expect(head.output()).not.toContain(token);
    expect(head.output()).not.toContain('not-the-token');
  }, 30_000);
});
