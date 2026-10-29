/**
 * Log audit 2026-10-22 (e): startup did not log the version, dotenv printed
 * an ad line, and shutdown closed the database under HTTP requests still in
 * flight. Runs the real CLI (tsx) on a free port with a throwaway database.
 */
import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { createServer, request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { InflightRequests } from '../http-drain.js';

const packageDir = resolve(__dirname, '..', '..');
const version = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')).version as string;

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((r) => server.close(() => r()));
  return port;
}

describe('InflightRequests', () => {
  it('drain waits for open responses and reports the ones still open at the deadline', async () => {
    const inflight = new InflightRequests();
    // Wait on the server actually receiving each request instead of a fixed
    // sleep (CI under load: a 20 ms sleep sometimes ran before the request
    // arrived, so nothing was in flight yet).
    const arrived: Record<string, () => void> = {};
    const arrival = (path: string) => new Promise<void>((r) => { arrived[path] = r; });
    let finishSlow: (() => void) | undefined;
    const server = createServer((req, res) => {
      inflight.track(res);
      if (req.url === '/slow') finishSlow = () => res.end('ok');
      // '/hang' never answers.
      arrived[req.url ?? '']?.();
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address() as AddressInfo;
    const slowArrived = arrival('/slow');
    const slow = fetch(`http://127.0.0.1:${port}/slow`).then((r) => r.text());
    await slowArrived;
    expect(inflight.size).toBe(1);
    const drained = inflight.drain(5_000);
    finishSlow!();
    expect(await drained).toBe(0);
    expect(await slow).toBe('ok');

    const hangArrived = arrival('/hang');
    const hung = request({ host: '127.0.0.1', port, path: '/hang' });
    hung.on('error', () => {});
    hung.end();
    await hangArrived;
    expect(await inflight.drain(50)).toBe(1);
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  });
});

describe('kraki-relay start / stop', () => {
  it('logs its version at start, no dotenv ad, and waits for in-flight requests on SIGTERM', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kraki-cli-'));
    const port = await freePort();
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/cli.ts'], {
      cwd: packageDir,
      env: { ...process.env, HOME: dir, PORT: String(port), DB_PATH: join(dir, 'head.db'), AUTH_MODE: 'open', LOG_PATH: '', PUSH_PROVIDERS: '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (d) => { output += d; });
    child.stderr.on('data', (d) => { output += d; });
    const exited = new Promise<number | null>((r) => child.on('exit', (code) => r(code)));
    try {
      for (let i = 0; i < 200 && !output.includes('listening on port'); i++) await new Promise((r) => setTimeout(r, 50));
      expect(output).toContain('listening on port');
      expect(output).toMatch(new RegExp(`Kraki Head starting\\.\\.\\. \\{"version":"${version.replace(/\./g, '\\.')}","node":"v`));
      expect(output).not.toContain('injected env');
      expect(output).not.toContain('dotenvx');

      // A request whose body never completes stays in flight.
      const hung = request({ host: '127.0.0.1', port, path: '/api/login/resolve', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': '100' } });
      hung.on('error', () => {});
      hung.write('{"auth":');
      await new Promise((r) => setTimeout(r, 100));

      const stopAt = Date.now();
      child.kill('SIGTERM');
      expect(await exited).toBe(0);
      expect(Date.now() - stopAt).toBeGreaterThanOrEqual(1_900);
      expect(output).toMatch(/Shutting down\.\.\. \{"signal":"SIGTERM","version":"[^"]+","upSec":\d+,"conns":0,"inflightHttp":1\}/);
      expect(output).toContain('Shutdown cut off HTTP requests still in flight {"dropped":1');
    } finally {
      child.kill('SIGKILL');
    }
  }, 20_000);
});
