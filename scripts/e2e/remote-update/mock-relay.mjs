// Minimal relay for the remote-update e2e: accepts any device (auth_ok),
// answers pings, and on request sends the connected tentacle an
// `update_device` (plaintext — the tentacle accepts that without E2E keys).
//   <dir>/mode        "hang" → don't answer new auths (a new version that
//                     never comes online); anything else → normal
//   <dir>/send.json   payload for update_device; sent once, then deleted
import { createRequire } from 'node:module';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { createVerify, randomBytes } from 'node:crypto';
import { join } from 'node:path';
const require = createRequire(new URL('../../../packages/tentacle/package.json', import.meta.url));
const { WebSocketServer } = require('ws');
const dir = process.argv[2];
const log = (...a) => console.log(new Date().toISOString(), ...a);
let current = null;
const keys = new Map();      // deviceId → compact public key
const pending = new Map();   // ws → { id, nonce }
const ok = (ws, id) => {
  ws.send(JSON.stringify({ type: 'auth_ok', deviceId: id, authMethod: 'open', user: { id: 'u_e2e', login: 'e2e' }, devices: [] }));
  current = ws;
};
const wss = new WebSocketServer({ port: Number(process.env.PORT || 4000) });
wss.on('connection', (ws) => {
  ws.on('message', (raw) => {
    let m; try { m = JSON.parse(String(raw)); } catch { return; }
    if (m.type === 'auth') {
      const mode = existsSync(join(dir, 'mode')) ? readFileSync(join(dir, 'mode'), 'utf8').trim() : 'normal';
      const id = m.device?.deviceId || 'dev_e2e';
      log('auth', id, m.auth?.method, 'mode', mode);
      if (mode === 'hang') return;
      // Like the real relay: a known device must prove it holds the key it
      // registered (challenge); an unknown one signs in fully and registers.
      if (m.auth?.method === 'challenge') {
        if (!keys.has(id)) { ws.send(JSON.stringify({ type: 'auth_error', code: 'unknown_device', message: 'Unknown device' })); return; }
        const nonce = randomBytes(16).toString('hex');
        pending.set(ws, { id, nonce });
        ws.send(JSON.stringify({ type: 'auth_challenge', nonce }));
        return;
      }
      if (m.device?.publicKey) keys.set(id, m.device.publicKey);
      ok(ws, id);
    } else if (m.type === 'auth_response') {
      const p = pending.get(ws); pending.delete(ws);
      if (!p) return;
      const pem = `-----BEGIN PUBLIC KEY-----\n${keys.get(p.id).match(/.{1,64}/g).join('\n')}\n-----END PUBLIC KEY-----\n`;
      const v = createVerify('SHA256'); v.update(p.nonce);
      if (!v.verify(pem, m.signature, 'base64')) {
        log('INVALID SIGNATURE', p.id);
        ws.send(JSON.stringify({ type: 'auth_error', code: 'invalid_signature', message: 'Invalid signature' }));
        return;
      }
      log('challenge ok', p.id);
      ok(ws, p.id);
    } else if (m.type === 'ping') {
      ws.send(JSON.stringify({ type: 'pong' }));
    }
  });
  ws.on('close', () => { if (current === ws) current = null; log('closed'); });
});
setInterval(() => {
  const f = join(dir, 'send.json');
  if (!existsSync(f) || !current) return;
  const payload = JSON.parse(readFileSync(f, 'utf8'));
  rmSync(f);
  current.send(JSON.stringify({ type: 'update_device', deviceId: 'app_e2e', payload }));
  log('sent update_device', JSON.stringify(payload));
}, 500);
log('mock relay on', wss.options.port);
