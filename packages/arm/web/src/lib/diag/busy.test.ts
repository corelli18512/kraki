import { afterEach, describe, expect, it, vi } from 'vitest';
import { BusyTracker } from './busy';

afterEach(() => vi.unstubAllGlobals());

describe('BusyTracker (DiagRunLoop equivalent)', () => {
  function harness() {
    let callback: PerformanceObserverCallback;
    const observe = vi.fn(), disconnect = vi.fn(), out = vi.fn();
    vi.stubGlobal('PerformanceObserver', class {
      static supportedEntryTypes = ['longtask'];
      constructor(cb: PerformanceObserverCallback) { callback = cb; }
      observe = observe;
      disconnect = disconnect;
    });
    let enabled = true, now = 0;
    const t = new BusyTracker();
    t.now = () => now;
    t.onBusy = out;
    t.start(() => enabled);
    const feed = (duration: number, startTime = now) => callback({ getEntries: () => [{ duration, startTime }] } as PerformanceObserverEntryList, {} as PerformanceObserver);
    return { t, out, observe, disconnect, feed, time: (n: number) => { now = n; }, enable: (value: boolean) => { enabled = value; } };
  }
  it('observes once and emits only completed tasks of at least 50 ms, never task attribution', () => {
    const h = harness();
    h.t.start(() => true);
    expect(h.observe).toHaveBeenCalledExactlyOnceWith({ type: 'longtask' });
    h.feed(49.9); h.feed(50); h.feed(120);
    expect(h.out.mock.calls).toEqual([[50], [120]]);
  });
  it('ignores hidden/disabled intervals and tasks that cross a foreground transition', () => {
    const h = harness();
    h.t.setActive(false); h.feed(100);
    h.time(200); h.t.setActive(true); h.feed(100, 150); h.feed(60, 200);
    h.enable(false); h.feed(100); h.enable(true); h.feed(80);
    expect(h.out.mock.calls).toEqual([[60], [80]]);
  });
  it('does nothing when longtask observation is not supported', () => {
    vi.stubGlobal('PerformanceObserver', undefined);
    expect(() => new BusyTracker().start(() => true)).not.toThrow();
    const observe = vi.fn();
    vi.stubGlobal('PerformanceObserver', class { static supportedEntryTypes = ['resource']; observe = observe; });
    new BusyTracker().start(() => true);
    expect(observe).not.toHaveBeenCalled();
  });
  it('an observation failure never prevents app startup', () => {
    const disconnect = vi.fn();
    vi.stubGlobal('PerformanceObserver', class {
      static supportedEntryTypes = ['longtask'];
      observe() { throw new Error('not supported'); }
      disconnect = disconnect;
    });
    expect(() => new BusyTracker().start(() => true)).not.toThrow();
    expect(disconnect).toHaveBeenCalledOnce();
  });
});
