/**
 * Connects mock tentacle devices to the local head relay.
 * Run after `pnpm dev` and before refreshing the web app.
 * Usage: npx tsx scripts/mock-devices.ts
 */
import WebSocket from 'ws';

const RELAY_URL = 'ws://localhost:4000';

const mockDevices = [
  { name: 'CI Server', role: 'tentacle', kind: 'server', models: ['claude-sonnet-4', 'gpt-4.1'] },
  { name: 'Linux Dev VM', role: 'tentacle', kind: 'vm', models: ['claude-sonnet-4', 'gpt-4.1', 'o3'] },
  { name: 'Work Laptop', role: 'tentacle', kind: 'desktop', models: ['gpt-4o'] },
];

for (const dev of mockDevices) {
  const ws = new WebSocket(RELAY_URL);

  ws.on('open', () => {
    ws.send(JSON.stringify({
      type: 'auth',
      device: { name: dev.name, role: dev.role, kind: dev.kind },
      auth: { method: 'open' },
    }));
  });

  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());

    if (msg.type === 'auth_ok') {
      console.log(`✓ ${dev.name} connected as ${msg.deviceId}`);
      // Send greeting to all currently online app devices
      if (Array.isArray(msg.devices)) {
        for (const d of msg.devices) {
          if (d.role === 'app' && d.online) {
            sendGreeting(ws, d.id, dev, msg.deviceId);
          }
        }
      }
    }

    // When a new app device joins later, send greeting to it too
    if (msg.type === 'device_joined' && msg.device?.role === 'app') {
      sendGreeting(ws, msg.device.id, dev, '');
    }
  });

  ws.on('error', (err: Error) => console.error(`✗ ${dev.name}: ${err.message}`));
  ws.on('close', () => console.log(`  ${dev.name} disconnected`));
}

function sendGreeting(ws: WebSocket, targetDeviceId: string, dev: typeof mockDevices[0], myDeviceId: string) {
  ws.send(JSON.stringify({
    type: 'device_greeting',
    targetDeviceId,
    deviceId: myDeviceId,
    seq: 1,
    timestamp: new Date().toISOString(),
    payload: { name: dev.name, kind: dev.kind, models: dev.models },
  }));
}

console.log(`Connecting ${mockDevices.length} mock devices to ${RELAY_URL}...`);
console.log('Press Ctrl+C to disconnect all');
