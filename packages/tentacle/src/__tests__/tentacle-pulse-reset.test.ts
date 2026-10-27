/**
 * Pulse reset-inbound logging (log audit 2026-10-22): the warning carried
 * only `fromSeq`, so a Head restart that may have dropped app→Tentacle
 * messages could not be told from the expected positioning on every cold
 * Tentacle start (which logged the same warning twice).
 */
import { encodeFrame, type Frame } from '@kraki/pulse';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const logged = vi.hoisted(() => ({ info: [] as unknown[][], warn: [] as unknown[][] }));
vi.mock('../logger.js', () => ({
  createLogger: () => ({
    info: (...a: unknown[]) => logged.info.push(a),
    warn: (...a: unknown[]) => logged.warn.push(a),
    debug: () => {},
    error: () => {},
  }),
}));

import { TentaclePulse } from '../tentacle-pulse.js';

const b64 = (f: Frame, stream = 0) => Buffer.from(encodeFrame(f, stream)).toString('base64');
const hello = (epoch: string): Frame => ({ t: 'hello', epoch, recvEpoch: '', recvCursor: 0n, durableSupported: false, maxRetentionMs: 0n });
const data = (seq: bigint): Frame => ({ t: 'data', seq, ack: 0n, payload: new TextEncoder().encode('{}'), durable: false });
const resets = (list: unknown[][]) => list.filter((a) => String(a[1]).startsWith('pulse reset-inbound')).map((a) => a[0]);

function tentacle(): TentaclePulse {
  const pulse = new TentaclePulse({ now: () => 0, sendPulseFrame: () => {}, onDelivered: () => {} }, 'tentacle');
  pulse.onConnected();
  return pulse;
}

describe('TentaclePulse reset-inbound log', () => {
  beforeEach(() => { logged.info.length = 0; logged.warn.length = 0; });

  it('logs the cold-start positioning at info, per stream', () => {
    const pulse = tentacle();
    for (const stream of [0, 1]) {
      pulse.onFrame(b64(hello(`H1:${stream}`), stream));
      pulse.onFrame(b64({ t: 'reset', epoch: `H1:${stream}`, oldest: 123051n }, stream));
    }
    expect(resets(logged.warn)).toEqual([]);
    expect(resets(logged.info)).toEqual([
      expect.objectContaining({ stream: 'live', cause: 'first-contact', fromSeq: '123051', cursorBefore: '0' }),
      expect.objectContaining({ stream: 'bulk', cause: 'first-contact', fromSeq: '123051', cursorBefore: '0' }),
    ]);
  });

  it('warns with the stream and the cursor it had when the relay stream restarts', () => {
    const pulse = tentacle();
    pulse.onFrame(b64(hello('H1:live')));
    pulse.onFrame(b64({ t: 'reset', epoch: 'H1:live', oldest: 122189n }));
    pulse.onFrame(b64(data(122189n)));
    pulse.onFrame(b64(data(122190n)));
    logged.info.length = 0;

    pulse.onFrame(b64(hello('H2:live')));
    expect(resets(logged.warn)).toEqual([expect.objectContaining({
      stream: 'live', peerEpoch: 'H2:live', fromSeq: '1', cursorBefore: '122190', cause: 'relay-stream-restarted',
    })]);
  });

  it('warns with the gap size when the relay skips ahead on the same stream', () => {
    const pulse = tentacle();
    pulse.onFrame(b64(hello('H1:live')));
    pulse.onFrame(b64({ t: 'reset', epoch: 'H1:live', oldest: 10n }));
    pulse.onFrame(b64(data(10n)));
    pulse.onFrame(b64({ t: 'reset', epoch: 'H1:live', oldest: 15n }));
    expect(resets(logged.warn)).toEqual([expect.objectContaining({ cause: 'relay-skipped-ahead', cursorBefore: '10', gap: '4' })]);
  });
});
