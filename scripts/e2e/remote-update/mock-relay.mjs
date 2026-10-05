// Minimal relay for the remote-update e2e: accepts any device (auth_ok),
// answers pings, and on request sends the connected tentacle an
// `update_device` (plaintext — the tentacle accepts that without E2E keys).
//   <dir>/mode        "hang" → don't answer new auths (a new version that
//                     never comes online); anything else → normal
//   <dir>/send.json   payload for update_device; sent once, then deleted
import { createRequire } from 'node:module';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
const require = createRequire(new URL('../../../packages/tentacle/package.json', import.meta.url));
const { WebSocketServer } = require('ws');
const dir = process.argv[2];
const log = (...a) => console.log(new Date().toISOString(), ...a);
let current = null;
const wss = new WebSocketServer({ port: Number(process.env.PORT || 4000) });
wss.on('connection', (ws) => {
  ws.on('message', (raw) => {
    let m; try { m = JSON.parse(String(raw)); } catch { return; }
    if (m.type === 'auth') {
      const mode = existsSync(join(dir, 'mode')) ? readFileSync(join(dir, 'mode'), 'utf8').trim() : 'normal';
      const id = m.device?.deviceId || 'dev_e2e';
      log('auth', id, 'mode', mode);
      if (mode === 'hang') return;
      ws.send(JSON.stringify({ type: 'auth_ok', deviceId: id, authMethod: 'open', user: { id: 'u_e2e', login: 'e2e' }, devices: [] }));
      current = ws;
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
