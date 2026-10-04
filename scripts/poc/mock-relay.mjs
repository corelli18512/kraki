// Minimal relay for the POC on runners that cannot build the real head:
// accepts any device, answers auth with auth_ok and app-level pings with pong.
import { createRequire } from 'node:module';
const require = createRequire(new URL('../../packages/tentacle/package.json', import.meta.url));
const { WebSocketServer } = require('ws');
const wss = new WebSocketServer({ port: Number(process.env.PORT || 4000) });
wss.on('connection', (ws) => {
  ws.on('message', (raw) => {
    let m; try { m = JSON.parse(String(raw)); } catch { return; }
    if (m.type === 'auth') {
      const id = m.device?.deviceId || m.device?.id || 'dev_poc';
      console.log(new Date().toISOString(), 'auth', id, m.device?.name);
      ws.send(JSON.stringify({ type: 'auth_ok', deviceId: id, authMethod: 'open', user: { id: 'u_poc', login: 'poc' }, devices: [] }));
    } else if (m.type === 'ping') {
      ws.send(JSON.stringify({ type: 'pong' }));
    }
  });
  ws.on('close', () => console.log(new Date().toISOString(), 'closed'));
});
console.log('mock relay on', wss.options.port);
