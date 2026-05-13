/**
 * Unit tests for the attachment state machine.
 *
 * Cover the four key paths:
 *   - live push: ref arrives → markAwaitingPush → chunks → ready
 *   - replay pull: ref arrives → markFetching → chunks → ready
 *   - error chunk: state transitions to error
 *   - safety timeout: ref arrives → no chunks → fallback fetch fires
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  __resetForTests,
  getState,
  ingestChunk,
  markAwaitingPush,
  markFetching,
  subscribe,
} from './attachments';

// Tiny PNG bytes for assembly tests
const PNG_HEX = '89504e470d0a1a0a';
const PNG_BYTES = new Uint8Array(PNG_HEX.match(/.{2}/g)!.map((h) => parseInt(h, 16)));
const PNG_B64 = btoa(String.fromCharCode(...PNG_BYTES));

describe('attachment state machine', () => {
  let pulls: string[];

  beforeEach(() => {
    vi.useFakeTimers();
    pulls = [];
    __resetForTests();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('markAwaitingPush sets awaiting state', () => {
    markAwaitingPush('id1', (id) => pulls.push(id));
    expect(getState('id1')?.kind).toBe('awaiting-chunks');
  });

  it('ingestChunk single chunk transitions to ready', async () => {
    markAwaitingPush('id1', (id) => pulls.push(id));
    await ingestChunk('id1', 0, 1, 'image/png', PNG_B64);
    const s = getState('id1');
    expect(s?.kind).toBe('ready');
    if (s?.kind === 'ready') {
      expect(s.mimeType).toBe('image/png');
      expect(s.blob.size).toBe(PNG_BYTES.length);
    }
  });

  it('ingestChunk reassembles multiple chunks regardless of order', async () => {
    markAwaitingPush('id2', (id) => pulls.push(id));
    // Two halves of the bytes, sent out of order
    const first = PNG_B64.slice(0, 4);
    const second = PNG_B64.slice(4);
    await ingestChunk('id2', 1, 2, 'image/png', second);
    expect(getState('id2')?.kind).toBe('awaiting-chunks');
    await ingestChunk('id2', 0, 2, 'image/png', first);
    expect(getState('id2')?.kind).toBe('ready');
  });

  it('ingestChunk with error transitions to error state', async () => {
    markAwaitingPush('id3', (id) => pulls.push(id));
    await ingestChunk('id3', 0, 0, '', '', 'not_found');
    const s = getState('id3');
    expect(s?.kind).toBe('error');
    if (s?.kind === 'error') {
      expect(s.reason).toBe('not_found');
    }
  });

  it('safety timeout fires fallback pull when no chunks arrive', () => {
    markAwaitingPush('id4', (id) => pulls.push(id));
    expect(pulls).toEqual([]);
    vi.advanceTimersByTime(10_001);
    expect(pulls).toEqual(['id4']);
  });

  it('safety timeout does not fire if a chunk arrived first', async () => {
    markAwaitingPush('id5', (id) => pulls.push(id));
    await ingestChunk('id5', 0, 1, 'image/png', PNG_B64);
    vi.advanceTimersByTime(15_000);
    expect(pulls).toEqual([]);
  });

  it('markFetching is used by the pull path', () => {
    markFetching('id6');
    expect(getState('id6')?.kind).toBe('fetching');
  });

  it('chunks arriving during fetch state still complete', async () => {
    markFetching('id7');
    await ingestChunk('id7', 0, 1, 'image/png', PNG_B64);
    expect(getState('id7')?.kind).toBe('ready');
  });

  it('subscribers are notified on state changes', async () => {
    const seen: string[] = [];
    const unsub = subscribe('id8', () => seen.push(getState('id8')?.kind ?? '-'));
    markAwaitingPush('id8', () => {});
    await ingestChunk('id8', 0, 1, 'image/png', PNG_B64);
    expect(seen).toContain('awaiting-chunks');
    expect(seen).toContain('ready');
    unsub();
  });
});
