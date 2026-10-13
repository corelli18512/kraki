/**
 * Transition test helper: the PRE-device-trust Tentacle (this worktree is
 * origin/main b2cf03da) on a computer directory shared with the new one.
 *   tsx old-tentacle.ts <relayUrl> <root> <deviceId> <ledger.json>
 * Writes the scripted agent's received inputs to <ledger.json>.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SessionManager, RelayClient, KeyManager } from '@kraki/tentacle';
import { ScriptedAdapter } from './scripted-adapter.js';

const [relayUrl, root, deviceId, ledger] = process.argv.slice(2);
if (!relayUrl || !root || !deviceId || !ledger) throw new Error('usage: old-tentacle <relayUrl> <root> <deviceId> <ledger>');
const adapter = new ScriptedAdapter();
const relay = new RelayClient(adapter.asAdapter(), new SessionManager(join(root, 'sessions')), {
  relayUrl,
  device: { name: 'Chaos Tentacle', role: 'tentacle', kind: 'desktop', deviceId },
  authMethod: 'open',
  localLink: false,
}, new KeyManager(join(root, 'keys')));
relay.onAuthenticated = (info) => console.log(JSON.stringify({ oldTentacle: 'authenticated', deviceId: info.deviceId }));
relay.connect();
const dump = () => writeFileSync(ledger, JSON.stringify(Object.fromEntries(
  [...adapter.received].map(([sid, m]) => [sid, Object.fromEntries(m)]),
)));
setInterval(dump, 200);
const stop = () => { relay.disconnect(); dump(); process.exit(0); };
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
