import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';
import type { AddressInfo } from 'node:net';
import { probeRegions } from '../region-probe.js';

const servers: WebSocketServer[] = [];

/** A local relay stand-in that answers pings after `delayMs`. */
async function relay(delayMs: number): Promise<string> {
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1', autoPong: false });
  wss.on('connection', (ws) => ws.on('ping', (data) => setTimeout(() => ws.pong(data), delayMs)));
  await new Promise<void>((r) => wss.once('listening', () => r()));
  servers.push(wss);
  return `ws://127.0.0.1:${(wss.address() as AddressInfo).port}`;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
});

describe('probeRegions', () => {
  it('picks the region with the lowest round trip from the list the server returns', async () => {
    const slow = await relay(80);
    const fast = await relay(5);
    const result = await probeRegions('https://main.example', {
      direct: true,
      pings: 3,
      intervalMs: 5,
      fetchRegions: async () => ({ version: 7, regions: [
        { code: 'us', relayUrl: slow },
        { code: 'china', relayUrl: fast },
      ] }),
    });
    expect(result.best).toBe('china');
    expect(result.listVersion).toBe(7);
    const byCode = Object.fromEntries(result.measurements.map((m) => [m.code, m]));
    expect(byCode.china.samplesMs).toHaveLength(3);
    expect(byCode.us.medianRttMs!).toBeGreaterThan(byCode.china.medianRttMs!);
  });

  it('skips unreachable regions and keeps the server order on a near tie', async () => {
    const a = await relay(20);
    const b = await relay(19);
    const result = await probeRegions('https://main.example', {
      direct: true, pings: 3, intervalMs: 5, timeoutMs: 1_500,
      fetchRegions: async () => ({ regions: [
        { code: 'first', relayUrl: a },
        { code: 'second', relayUrl: b },
        { code: 'down', relayUrl: 'ws://127.0.0.1:1' },
      ] }),
    });
    expect(result.best).toBe('first');
    expect(result.measurements.find((m) => m.code === 'down')?.error).toBeTruthy();
  });

  it('has no answer when nothing is reachable', async () => {
    const result = await probeRegions('https://main.example', {
      direct: true, timeoutMs: 500,
      fetchRegions: async () => ({ regions: [{ code: 'down', relayUrl: 'ws://127.0.0.1:1' }] }),
    });
    expect(result.best).toBeUndefined();
  });
});
