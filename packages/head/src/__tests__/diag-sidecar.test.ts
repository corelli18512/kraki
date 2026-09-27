import { expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { diagSigningText } from '../diag-api.js';

it('independent sidecar reads current device keys from WAL without mutating Head DB', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kraki-sidecar-'));
  const dbPath = join(root, 'head.db');
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode=WAL; CREATE TABLE devices(id TEXT PRIMARY KEY,user_id TEXT,role TEXT,public_key TEXT)');
  const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pub = keys.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  db.prepare('INSERT INTO devices VALUES (?,?,?,?)').run('test-device', 'test-user', 'app', pub);
  const reservation = createServer();
  await new Promise<void>(r => reservation.listen(0, '127.0.0.1', r));
  const port = (reservation.address() as { port: number }).port;
  await new Promise<void>(r => reservation.close(() => r()));
  const child = spawn(process.execPath, ['--import', 'tsx', resolve('src/diag-sidecar.ts')], {
    env: { ...process.env, KRAKI_DIAG_DB: dbPath, KRAKI_DIAG_DIR: join(root, 'logs'), KRAKI_DIAG_PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    await new Promise<void>((r, reject) => {
      const timer = setTimeout(() => reject(new Error('sidecar start timeout')), 10000);
      child.stdout.on('data', data => { if (String(data).includes('ready')) { clearTimeout(timer); r(); } });
      child.on('exit', () => { clearTimeout(timer); reject(new Error('sidecar exited')); });
    });
    const base = `http://127.0.0.1:${port}`;
    expect((await (await fetch(base + '/health')).json()).service).toBe('kraki-diag');
    const id = randomUUID(), timestamp = String(Date.now());
    const batch = { schema: 1, batchId: id, processId: randomUUID(), platform: 'test', version: '1', build: '1',
      events: [{ ev: 'user.marker', seq: 1, t: Date.now(), m: 10, d: {} }] };
    const body = gzipSync(JSON.stringify(batch));
    const path = '/api/diag/v1/batch';
    const signature = sign('sha256', Buffer.from(diagSigningText('POST', path, 'test-device', timestamp, id, body)), keys.privateKey).toString('base64');
    const response = await fetch(base + path, { method: 'POST', body: new Uint8Array(body), headers: {
      'content-type': 'application/json', 'content-encoding': 'gzip', 'x-kraki-device': 'test-device',
      'x-kraki-time': timestamp, 'x-kraki-request': id, 'x-kraki-signature': signature,
    } });
    expect(response.status).toBe(204);
    expect(await readdir(join(root, 'logs'))).toHaveLength(1);
    expect(db.prepare('SELECT count(*) AS n FROM devices').get()?.n).toBe(1);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()).toHaveLength(1);
  } finally {
    child.kill('SIGTERM');
    await new Promise<void>(r => { if (child.exitCode !== null) r(); else child.once('exit', () => r()); });
    db.close();
    await rm(root, { recursive: true, force: true });
  }
}, 20000);
