import Database from 'better-sqlite3';
import { Endpoint } from '@coinfra/pulse';
import { PulseHub, type PulseHubHost } from '../packages/head/src/pulse-hub.js';

const b64 = (u: Uint8Array): string => Buffer.from(u).toString('base64');

function run(targetCount: number, sends: number): { targets: number; sends: number; hubTransmits: number; endpointCount: number } {
  const db = new Database(':memory:');
  let now = 0;
  let hubTransmits = 0;
  const sourceId = 'tentacle';
  const targetIds = Array.from({ length: targetCount }, (_, i) => `app-${i}`);
  const source = new Endpoint({ epoch: `source-${targetCount}` });
  const targets = new Map(targetIds.map((id) => [id, new Endpoint({ epoch: id })]));
  let hub!: PulseHub;

  const pumpSource = (effects: ReturnType<Endpoint['onTick']>) => {
    for (const e of effects) {
      if (e.t === 'transmit') hub.onPulseEnvelope(sourceId, { pulse: b64(e.bytes) });
    }
  };
  const pumpTarget = (id: string, effects: ReturnType<Endpoint['onTick']>) => {
    for (const e of effects) {
      if (e.t === 'transmit') hub.onPulseEnvelope(id, { pulse: b64(e.bytes), to: sourceId });
    }
  };

  const host: PulseHubHost = {
    now: () => now,
    broadcastTargets: () => targetIds,
    onDeliverToSelf: () => {},
    sendPulseTo: (id, pulse) => {
      hubTransmits++;
      if (id === sourceId) {
        pumpSource(source.onBytes(new Uint8Array(Buffer.from(pulse, 'base64')), now));
        return true;
      }
      const target = targets.get(id);
      if (!target) return false;
      pumpTarget(id, target.onBytes(new Uint8Array(Buffer.from(pulse, 'base64')), now));
      return true;
    },
  };
  hub = new PulseHub(db, host, { intervalMs: 0 });
  hub.onDeviceConnected(sourceId);
  pumpSource(source.onConnected(now));
  for (const [id, target] of targets) {
    hub.onDeviceConnected(id);
    pumpTarget(id, target.onConnected(now));
  }

  for (let i = 0; i < sends; i++) {
    pumpSource(source.send(new TextEncoder().encode(`delta-${i}`), {
      durable: false,
      coalesceKey: 'agent_message_delta:s1',
    }).effects);
    now += 10;
    pumpSource(source.onTick(now));
    for (const [id, target] of targets) pumpTarget(id, target.onTick(now));
    hub.tick();
  }
  for (let i = 0; i < 20; i++) {
    now += 1000;
    pumpSource(source.onTick(now));
    for (const [id, target] of targets) pumpTarget(id, target.onTick(now));
    hub.tick();
  }

  const result = { targets: targetCount, sends, hubTransmits, endpointCount: hub.endpointCount() };
  hub.close();
  db.close();
  return result;
}

for (const targets of [1, 2, 4, 8, 16, 32]) {
  console.log(JSON.stringify(run(targets, 100)));
}
