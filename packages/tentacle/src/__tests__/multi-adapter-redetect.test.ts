/**
 * Log audit 2026-10-22: when startup detection found no coding agent, the
 * daemon logged "Multi-agent adapter failed to start" and stayed agent-less
 * until the user restarted it. Detection is now retried in the background.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  execSync: vi.fn(() => Buffer.from('/opt/bin/pi\n')),
}));

const piStarts = vi.hoisted(() => ({ count: 0 }));
vi.mock('../adapters/pi.js', async () => {
  const { AgentAdapter } = await import('../adapters/base.js');
  class FakePiAdapter extends (AgentAdapter as unknown as new () => object) {
    constructor(readonly opts: unknown) { super(); }
    async start() { piStarts.count++; }
    async stop() {}
    async listModelDetails() { return []; }
  }
  return { PiAdapter: FakePiAdapter };
});

import { MultiAgentAdapter } from '../adapters/multi.js';

afterEach(() => { vi.useRealTimers(); piStarts.count = 0; });

describe('MultiAgentAdapter startup detection', () => {
  it('re-detects agents in the background when none were found at startup', async () => {
    vi.useFakeTimers();
    const detectAgents = vi.fn<() => Promise<Array<'pi'>>>()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValue(['pi']);
    const multi = new MultiAgentAdapter({ detectAgents });
    const changed = vi.fn();
    multi.onCapabilitiesChanged = changed;

    await expect(multi.start()).resolves.toBeUndefined();
    expect(detectAgents).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(detectAgents).toHaveBeenCalledTimes(2);
    expect(changed).not.toHaveBeenCalled();

    // Backs off (60 s → 120 s) and then brings the agent up.
    await vi.advanceTimersByTimeAsync(120_000);
    expect(detectAgents).toHaveBeenCalledTimes(3);
    expect(piStarts.count).toBe(1);
    expect(changed).toHaveBeenCalledTimes(1);

    // Found: no further detection.
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(detectAgents).toHaveBeenCalledTimes(3);
    await multi.stop();
  });

  it('stop() cancels background re-detection', async () => {
    vi.useFakeTimers();
    const detectAgents = vi.fn<() => Promise<Array<'pi'>>>().mockResolvedValue([]);
    const multi = new MultiAgentAdapter({ detectAgents });
    await multi.start();
    await multi.stop();
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(detectAgents).toHaveBeenCalledTimes(1);
  });
});
