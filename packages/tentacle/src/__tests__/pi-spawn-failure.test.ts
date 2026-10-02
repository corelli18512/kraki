import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('Pi spawn failure', () => {
  it('a missing pi binary evicts the session instead of crashing the daemon', async () => {
    process.env.KRAKI_HOME = mkdtempSync(join(tmpdir(), 'kraki-pi-spawn-'));
    const { PiAdapter } = await import('../adapters/pi.js');
    const uncaught = vi.fn();
    process.on('uncaughtException', uncaught);
    try {
      const adapter = new PiAdapter({ cliPath: join(tmpdir(), 'definitely-not-pi-binary') });
      const evicted = vi.fn();
      adapter.onSessionEvicted = evicted;
      await adapter.createSession({ sessionId: 'pi-missing', model: 'anthropic/claude', cwd: tmpdir() });
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(uncaught).not.toHaveBeenCalled();
      expect(evicted).toHaveBeenCalledWith('pi-missing');
      await adapter.stop();
    } finally {
      process.off('uncaughtException', uncaught);
    }
  });
});
