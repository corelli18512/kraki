import { describe, expect, it } from 'vitest';
import { AttachmentPacer, type AttachmentPacerClock } from '../attachment-pacer.js';

function fakeClock() {
  let now = 0;
  const timers: Array<{ at: number; fn: () => void; id: number }> = [];
  let nextId = 1;
  const clock: AttachmentPacerClock = {
    now: () => now,
    setTimeout: (fn, ms) => { const id = nextId++; timers.push({ at: now + ms, fn, id }); return id; },
    clearTimeout: (h) => { const i = timers.findIndex(t => t.id === h); if (i >= 0) timers.splice(i, 1); },
  };
  const advance = (ms: number) => {
    const end = now + ms;
    for (;;) {
      timers.sort((a, b) => a.at - b.at);
      const t = timers[0];
      if (!t || t.at > end) break;
      timers.shift();
      now = t.at;
      t.fn();
    }
    now = end;
  };
  return { clock, advance };
}

function setup(online = new Set(['a', 'b'])) {
  const { clock, advance } = fakeClock();
  const sent: Array<{ device: string; id: string; index: number; at: number }> = [];
  const pacer = new AttachmentPacer({
    chunkBytes: 100,
    bytesPerSecond: 1000,
    clock,
    isOnline: (d) => online.has(d),
    sendChunk: (job, index, _total, slice) => {
      sent.push({ device: job.deviceId, id: job.id, index, at: clock.now() });
      return slice.length; // 100 wire bytes → 100 ms at 1000 B/s
    },
  });
  return { pacer, sent, advance, online, clock };
}

const job = (deviceId: string, id: string, size: number) => ({ deviceId, sessionId: 's', id, bytes: Buffer.alloc(size), mimeType: 'text/plain' });

describe('AttachmentPacer', () => {
  it('sends legacy chunks at the configured rate, round-robin across jobs', () => {
    const { pacer, sent, advance } = setup();
    pacer.enqueue(job('a', 'big', 300));
    pacer.enqueue(job('b', 'small', 100));
    advance(1000);
    expect(sent.map(s => `${s.id}#${s.index}@${s.at}`)).toEqual(['big#0@0', 'small#0@100', 'big#1@200', 'big#2@300']);
  });

  it('charges paced chunks to the same budget so legacy traffic backs off', () => {
    const { pacer, sent, advance } = setup();
    pacer.charge(500);
    pacer.enqueue(job('a', 'x', 100));
    advance(400);
    expect(sent).toHaveLength(0);
    advance(200);
    expect(sent.map(s => s.at)).toEqual([500]);
  });

  it('keeps many small jobs and bounds memory by queued bytes', () => {
    const { pacer } = setup(new Set());
    for (let i = 0; i < 100; i++) pacer.enqueue(job('a', `small-${i}`, 10));
    expect(pacer.pendingJobs).toBe(100);
    pacer.enqueue(job('a', 'huge', AttachmentPacer.MAX_QUEUED_BYTES));
    expect(pacer.pendingJobs).toBe(1);
  });

  it('waits for an offline requester and drops a removed device', () => {
    const { pacer, sent, advance, online } = setup(new Set());
    pacer.enqueue(job('a', 'x', 100));
    pacer.enqueue(job('b', 'y', 100));
    advance(5000);
    expect(sent).toHaveLength(0);
    pacer.drop('b');
    online.add('a'); online.add('b');
    pacer.notifyOnline('a');
    advance(1000);
    expect(sent.map(s => s.id)).toEqual(['x']);
  });

  it('expires stale jobs', () => {
    const { pacer, sent, advance, online } = setup(new Set());
    pacer.enqueue(job('a', 'x', 100));
    advance(AttachmentPacer.JOB_TTL_MS + 1);
    online.add('a');
    pacer.notifyOnline('a');
    advance(1000);
    expect(sent).toHaveLength(0);
    expect(pacer.pendingJobs).toBe(0);
  });
});
