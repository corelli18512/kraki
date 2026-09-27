/** Real Swift signature + URLSession -> ephemeral loopback @kraki/monitor collector.
 * No production app, relay, credentials, database, Keychain or model calls.
 * Run on macOS: pnpm exec tsx scripts/diag/local-e2e.ts
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { DiagApi, validateDiagBatch } from '../../packages/monitor/src/diag-api.js';

async function main() {
  const root = await mkdtemp(join(tmpdir(), 'kraki-diag-e2e-'));
  const pub = join(root, 'public-key');
  const dataDir = join(root, 'collector');
  const api = new DiagApi({ directory: dataDir, getDevice: id =>
    id === 'native-e2e-device' && existsSync(pub) ? {
      id, userId: 'ephemeral-test-user', role: 'app', publicKey: readFileSync(pub, 'utf8'),
    } : undefined,
  });
  let failNextPost = true;
  const server = createServer(async (req, res) => {
    if (req.method === 'POST' && failNextPost) {
      failNextPost = false; req.resume(); res.writeHead(503); res.end(); return;
    }
    if (!await api.handleRequest(req, res)) { res.writeHead(404); res.end(); }
  });
  try {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    const script = resolve(dirname(fileURLToPath(import.meta.url)), 'run-native-tests.sh');
    const child = spawn('bash', [script], { stdio: 'inherit', env: {
      ...process.env, KRAKI_DIAG_E2E_RELAY: `ws://127.0.0.1:${port}`, KRAKI_DIAG_E2E_PUBLIC_KEY: pub,
    } });
    const code = await new Promise<number | null>((resolve, reject) => { child.on('exit', resolve); child.on('error', reject); });
    if (code !== 0) throw new Error(`Native test exited ${code}`);
    const owners = await readdir(dataDir);
    if (owners.length !== 1) throw new Error('Expected exactly one owner');
    const files = await readdir(join(dataDir, owners[0]));
    if (files.length !== 1) throw new Error('Expected one accepted batch after retry');
    const batch = JSON.parse(gunzipSync(await readFile(join(dataDir, owners[0], files[0]))).toString('utf8'));
    if (!validateDiagBatch(batch, batch.batchId) || batch.events[0].ev !== 'cmd.answer') throw new Error('Stored batch mismatch');
    console.log('PASS: one valid batch durably received over real local HTTP; no duplicate on retry');
  } finally {
    api.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
