import { expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { diagSigningText } from '../diag-api.js';

it.each(['source', 'built'])('standalone collector (%s) preserves wire/storage identity, reads live WAL keys and survives restart without writing Head DB', async mode => {
  const root = await mkdtemp(join(tmpdir(), 'kraki-monitor-'));
  const dbPath = join(root, 'head.db');
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode=WAL; CREATE TABLE devices(id TEXT PRIMARY KEY,user_id TEXT,role TEXT,public_key TEXT)');
  const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pub = keys.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  db.prepare('INSERT INTO devices VALUES (?,?,?,?)').run('test-device', 'test-user', 'app', pub);
  const beforeDB = await readFile(dbPath), beforeWAL = await readFile(dbPath + '-wal');
  const reservation = createServer();
  await new Promise<void>(r => reservation.listen(0, '127.0.0.1', r));
  const port = (reservation.address() as { port: number }).port;
  await new Promise<void>(r => reservation.close(() => r()));
  let args = ['--import', 'tsx', fileURLToPath(new URL('../cli.ts', import.meta.url))];
  if (mode === 'built') {
    // Exactly the deployable payload, outside the workspace: no Head dist or node_modules.
    const runtime = join(root, 'runtime');
    await mkdir(runtime);
    for (const name of ['cli.js', 'diag-api.js', 'device-keys.js']) {
      await copyFile(fileURLToPath(new URL(`../../dist/${name}`, import.meta.url)), join(runtime, name));
    }
    await writeFile(join(runtime, 'package.json'), '{"type":"module"}');
    args = [join(runtime, 'cli.js')];
  }
  let child: ChildProcess | undefined;
  const stop = async () => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise<void>(r => child!.once('exit', () => r()));
    child.kill('SIGTERM');
    await exited;
  };
  const start = async () => {
    child = spawn(process.execPath, args, {
      env: { ...process.env, KRAKI_DIAG_DB: dbPath, KRAKI_DIAG_DIR: join(root, 'logs'), KRAKI_DIAG_PORT: String(port) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    await new Promise<void>((r, reject) => {
      const timer = setTimeout(() => reject(new Error('collector start timeout')), 10000);
      child!.stdout!.on('data', data => { if (String(data).includes('ready')) { clearTimeout(timer); r(); } });
      child!.once('error', error => { clearTimeout(timer); reject(error); });
      child!.once('exit', code => { clearTimeout(timer); reject(new Error(`collector exited: ${code}`)); });
    });
  };
  try {
    await start();
    const base = `http://127.0.0.1:${port}`;
    expect((await (await fetch(base + '/health')).json()).service).toBe('kraki-diag');
    expect((await fetch(base + '/api/account')).status).toBe(404);
    expect((await fetch(base + '/api/diag/v1/config', { headers: { authorization: 'Bearer not-an-app-credential' } })).status).toBe(401);
    const id = randomUUID();
    const batch = { schema: 1, batchId: id, processId: randomUUID(), platform: 'test', version: '1', build: '1',
      events: [{ ev: 'ws.state', seq: 1, t: Date.now(), m: 10, d: { source: 'pulse_progress_timeout', count: 3 } }] };
    const body = gzipSync(JSON.stringify(batch));
    const request = (deviceId = 'test-device', method = 'POST', privateKey = keys.privateKey) => {
      const path = `/api/diag/v1/${method === 'POST' ? 'batch' : 'config'}`;
      const timestamp = String(Date.now());
      const data = method === 'POST' ? body : Buffer.alloc(0);
      const signature = sign('sha256', Buffer.from(diagSigningText(method, path, deviceId, timestamp, id, data)), privateKey).toString('base64');
      return fetch(base + path, { method, body: method === 'POST' ? new Uint8Array(body) : undefined, headers: {
        'content-type': 'application/json', 'content-encoding': 'gzip', 'x-kraki-device': deviceId,
        'x-kraki-time': timestamp, 'x-kraki-request': id, 'x-kraki-signature': signature,
      } });
    };
    expect((await request()).status).toBe(204);
    await stop(); await start();
    expect((await request()).status).toBe(204); // prior batch/ACK-loss retry survives service restart
    const owners = await readdir(join(root, 'logs'));
    expect(owners).toHaveLength(1);
    expect(await readdir(join(root, 'logs', owners[0]))).toEqual([`${id}.json.gz`]);
    expect(await readFile(join(root, 'logs', owners[0], `${id}.json.gz`))).toEqual(body);
    expect(await readFile(dbPath)).toEqual(beforeDB);
    expect(await readFile(dbPath + '-wal')).toEqual(beforeWAL);
    // Registration, role changes, key rotation and revocation are visible without collector restart.
    db.prepare('INSERT INTO devices VALUES (?,?,?,?)').run('new-device', 'test-user', 'app', pub);
    expect((await request('new-device', 'GET')).status).toBe(200);
    db.prepare('UPDATE devices SET role=? WHERE id=?').run('tentacle', 'new-device');
    expect((await request('new-device', 'GET')).status).toBe(401);
    const rotated = generateKeyPairSync('rsa', { modulusLength: 2048 });
    db.prepare('UPDATE devices SET public_key=? WHERE id=?').run(rotated.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'), 'test-device');
    expect((await request('test-device', 'GET')).status).toBe(401);
    expect((await request('test-device', 'GET', rotated.privateKey)).status).toBe(200);
    db.prepare('DELETE FROM devices WHERE id=?').run('test-device');
    expect((await request('test-device', 'GET', rotated.privateKey)).status).toBe(401);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()).toEqual([{ name: 'devices' }]);
  } finally {
    await stop(); db.close(); await rm(root, { recursive: true, force: true });
  }
}, 30000);
