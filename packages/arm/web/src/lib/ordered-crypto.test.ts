import { describe, expect, it, vi } from 'vitest';
import { OrderedCrypto } from './ordered-crypto';

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const flush = async () => { await new Promise(r => setTimeout(r, 0)); };

describe('OrderedCrypto private completion ownership', () => {
  it('buffers only within a domain, releases rejection then successor, removes empty domain', async () => {
    const order: Array<string | null> = [];
    const queue = new OrderedCrypto();
    const first = deferred<string>();
    queue.run('peer:bulk', () => first.promise, value => order.push(value));
    queue.run('peer:bulk', async () => 'second', value => order.push(value));
    queue.run('peer:live', async () => 'live', value => order.push(value));
    await flush(); expect(order).toEqual(['live']);
    first.reject(new Error('rejected crypto'));
    await flush(); expect(order).toEqual(['live', null, 'second']);
    expect((queue as any).domains.size).toBe(0);
  });

  it('cancels once, empties buffered callbacks/results, detaches old completion from replacement', async () => {
    const queue = new OrderedCrypto(), first = deferred<object>();
    const deliver = vi.fn(), cancel = vi.fn();
    queue.run('peer', () => first.promise, deliver, cancel);
    queue.run('peer', async () => ({ buffered: true }), deliver, cancel);
    await flush();
    const entries = [...(queue as any).domains.get('peer')];
    queue.clear(); queue.clear();
    expect(cancel).toHaveBeenCalledTimes(2);
    for (const entry of entries) expect(entry).toMatchObject({ value: undefined, deliver: undefined, cancel: undefined });
    const fresh = vi.fn();
    queue.run('peer', async () => 'fresh', fresh);
    await flush(); expect(fresh).toHaveBeenCalledExactlyOnceWith('fresh');
    first.resolve({ stale: true }); await flush();
    expect(deliver).not.toHaveBeenCalled();
    expect((queue as any).domains.size).toBe(0);
  });

  it('cancellation owns only the old admission, not synchronous replacement work', async () => {
    const queue = new OrderedCrypto(), held = deferred<string>(), fresh = vi.fn();
    queue.run('peer', () => held.promise, vi.fn(), () => {
      queue.run('peer', async () => 'replacement', fresh);
    });
    queue.clear();
    await flush();
    expect(fresh).toHaveBeenCalledExactlyOnceWith('replacement');
    held.resolve('old'); await flush();
    expect(fresh).toHaveBeenCalledTimes(1);
  });

  it('advances synchronous throw and duplicate completion without wedging or double delivery', async () => {
    const queue = new OrderedCrypto(), delivered = vi.fn();
    queue.run('peer', () => { throw new Error('sync failure'); }, delivered);
    const complete = queue.admit('peer', delivered);
    complete('once'); complete('twice');
    queue.run('peer', async () => 'successor', delivered);
    await flush();
    expect(delivered.mock.calls).toEqual([[null], ['once'], ['successor']]);
  });
});
