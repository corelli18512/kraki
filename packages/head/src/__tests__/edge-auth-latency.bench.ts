// Manual benchmark (not part of the suite): sign-in latency through an edge
// whose account service is ACCOUNT_DELAY_MS away per request.
// Run: ACCOUNT_DELAY_MS=250 npx tsx src/__tests__/edge-auth-latency.bench.ts
import { createServer } from 'http';
import type { AddressInfo } from 'net';
import { WebSocket } from 'ws';
import { generateKeyPair, exportPublicKey, signChallenge } from '@kraki/crypto';
import { Storage } from '../storage.js';
import { LocalAuthBackend } from '../local-auth-backend.js';
import { RemoteAuthBackend } from '../remote-auth-backend.js';
import { AccountApi } from '../account-api.js';
import { EdgeAuthCache } from '../edge-auth-cache.js';
import { HeadServer } from '../server.js';
import { Logger, setGlobalLogger } from '../logger.js';
setGlobalLogger(new Logger({ level: 'error', stdout: false }));
const DELAY = Number(process.env.ACCOUNT_DELAY_MS ?? 250);
const keys = generateKeyPair();
const account = new Storage(':memory:');
account.upsertUser('u1', 'alice', 'open');
account.upsertDevice('phone', 'u1', 'iPhone', 'app', 'ios', exportPublicKey(keys.publicKey), 'enc-1');
const api = new AccountApi({ authBackend: new LocalAuthBackend({ storage: account, authProviders: new Map() }), serviceKey: 'k' });
const accountHttp = createServer(async (req, res) => { await new Promise((r) => setTimeout(r, DELAY)); if (!(await api.handleRequest(req, res))) { res.writeHead(404); res.end(); } });
await new Promise<void>((r) => accountHttp.listen(0, r));
async function run(local: boolean) {
  const remote = new RemoteAuthBackend({ accountUrl: `http://localhost:${(accountHttp.address() as AddressInfo).port}`, serviceKey: 'k' });
  const edgeStorage = new Storage(':memory:');
  if (local) await remote.enableLocalChallenge(new EdgeAuthCache(edgeStorage.rawDb), undefined, 60_000);
  const edge = new HeadServer(edgeStorage, { authBackend: remote });
  const http = createServer(); edge.attach(http); await new Promise<void>((r) => http.listen(0, r));
  const port = (http.address() as AddressInfo).port;
  const times: number[] = [];
  for (let i = 0; i < 6; i++) {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    await new Promise((r) => ws.on('open', r));
    const t = performance.now();
    await new Promise<void>((resolve) => {
      ws.on('message', (d) => { const m = JSON.parse(d.toString());
        if (m.type === 'auth_challenge') ws.send(JSON.stringify({ type: 'auth_response', deviceId: 'phone', signature: signChallenge(m.nonce, keys.privateKey) }));
        if (m.type === 'auth_ok') resolve(); });
      ws.send(JSON.stringify({ type: 'auth', auth: { method: 'challenge', deviceId: 'phone' }, device: { name: 'iPhone', role: 'app', encryptionKey: 'enc-1' } }));
    });
    times.push(Math.round(performance.now() - t));
    ws.close(); await new Promise((r) => setTimeout(r, 100));
  }
  remote.stopLocalChallenge(); edge.close(); http.close(); edgeStorage.close();
  return times;
}
console.log(`account service ${DELAY} ms away per request`);
console.log('remote only   ', (await run(false)).join(' ms, '), 'ms');
console.log('edge-local    ', (await run(true)).join(' ms, '), 'ms');
accountHttp.close(); account.close();
