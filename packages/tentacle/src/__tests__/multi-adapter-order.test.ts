/**
 * K-293: the default agent and the picker order follow detection order, not
 * which agent happened to finish starting first.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  execSync: vi.fn((cmd: string) => Buffer.from(`/opt/bin/${String(cmd).split(' ').pop()}\n`)),
}));

function fakeAdapter(startMs: number) {
  return async () => {
    const { AgentAdapter } = await import('../adapters/base.js');
    class Fake extends (AgentAdapter as unknown as new () => object) {
      constructor(readonly opts: unknown) { super(); }
      async start() { await new Promise((r) => setTimeout(r, startMs)); }
      async stop() {}
      async listModelDetails() { return []; }
      async createSession(config: { sessionId?: string }) { return { sessionId: config.sessionId ?? 'x' }; }
    }
    return Fake;
  };
}
vi.mock('../adapters/pi.js', async () => ({ PiAdapter: await fakeAdapter(80)() }));
vi.mock('../adapters/codex.js', async () => ({ CodexAdapter: await fakeAdapter(0)() }));

import { MultiAgentAdapter } from '../adapters/multi.js';

describe('MultiAgentAdapter agent order (K-293)', () => {
  it('keeps detection order when a later agent starts faster', async () => {
    const multi = new MultiAgentAdapter({ agentIds: ['pi', 'codex'] });
    await multi.start();
    expect((await multi.getAgentCapabilities()).map((c) => c.id)).toEqual(['pi', 'codex']);
    const created = await multi.createSession({ sessionId: 's1' });
    expect(created.sessionId).toBe('s1');
    expect((multi as unknown as { sessionAgent: Map<string, string> }).sessionAgent.get('s1')).toBe('pi');
    await multi.stop();
  });
});
