import { describe, expect, it } from 'vitest';
import { PayloadAssembler, fragmentPayload, isPayloadFragment, PAYLOAD_FRAGMENT_THRESHOLD } from '@kraki/protocol';

const big = (n: number) => JSON.stringify({ blob: 'b'.repeat(n), keys: { d: 'k' } });

describe('payload fragments', () => {
  it('leaves small or non-ASCII payloads whole', () => {
    expect(fragmentPayload(big(1000), 'a')).toBeNull();
    expect(fragmentPayload('é'.repeat(PAYLOAD_FRAGMENT_THRESHOLD + 10), 'a')).toBeNull();
  });

  it('round-trips in order and out of order, interleaved across payloads', () => {
    const one = big(200_000), two = big(150_000);
    const a = fragmentPayload(one, 'one')!, b = fragmentPayload(two, 'two')!;
    expect(a.length).toBe(Math.ceil(one.length / (32 * 1024)));
    const asm = new PayloadAssembler();
    const got: string[] = [];
    const order = [...a.map((p, i) => [p, i] as const), ...b.map((p, i) => [p, i + 100] as const)]
      .sort((x, y) => (x[1] % 3) - (y[1] % 3) || x[1] - y[1]);
    for (const [part] of order) {
      const parsed = JSON.parse(part);
      expect(isPayloadFragment(parsed)).toBe(true);
      const whole = asm.accept(parsed);
      if (whole) got.push(whole);
    }
    expect(got.sort()).toEqual([one, two].sort());
    expect(asm.pendingPayloads).toBe(0);
  });

  it('ignores duplicates and rejects malformed fragments', () => {
    const parts = fragmentPayload(big(100_000), 'dup')!.map((p) => JSON.parse(p));
    const asm = new PayloadAssembler();
    expect(asm.accept(parts[0])).toBeNull();
    expect(asm.accept(parts[0])).toBeNull();
    let whole: string | null = null;
    for (const p of parts.slice(1)) whole = asm.accept(p);
    expect(whole).toBe(big(100_000));
    expect(isPayloadFragment({ kfrag: 1, id: 'x', i: 3, n: 3, d: '' })).toBe(false);
    expect(isPayloadFragment({ kfrag: 2, id: 'x', i: 0, n: 1, d: '' })).toBe(false);
  });

  it('bounds memory and expires stale partial payloads', () => {
    let now = 0;
    const asm = new PayloadAssembler(100_000, 4096, 1_000, () => now);
    const p1 = fragmentPayload(big(90_000), 'p1')!.map((p) => JSON.parse(p));
    const p2 = fragmentPayload(big(90_000), 'p2')!.map((p) => JSON.parse(p));
    asm.accept(p1[0]); asm.accept(p1[1]);
    asm.accept(p2[0]); asm.accept(p2[1]);
    expect(asm.pendingPayloads).toBe(1); // p1 evicted over the byte budget
    now = 5_000;
    asm.accept(p1[0]);
    expect(asm.pendingPayloads).toBe(1); // p2 expired; p1 restarted
  });

  it('rejects parts larger than a fragment and payloads larger than the budget', () => {
    const asm = new PayloadAssembler(100_000);
    expect(asm.accept({ kfrag: 1, id: 'x', i: 0, n: 2, d: 'a'.repeat(200_000) })).toBeNull();
    expect(asm.pendingPayloads).toBe(0);
    expect(asm.accept({ kfrag: 1, id: 'y', i: 0, n: 1000, d: 'a' })).toBeNull();
    expect(asm.pendingPayloads).toBe(0);
  });
});
