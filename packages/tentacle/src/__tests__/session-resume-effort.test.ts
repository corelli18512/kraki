/**
 * K-133: a lazy resume (after a daemon restart or idle eviction) restores the
 * user's model AND reasoning effort. Restoring the model alone made Pi fall
 * back to its default thinking level while the apps still showed the choice.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SessionManager } from '../session-manager.js';
import { RelayClient } from '../relay-client.js';
import { ensureSessionResumed } from '../relay/session-resume.js';
import type { AgentAdapter } from '../adapters/base.js';

vi.mock('../logger.js', () => ({
  createLogger: vi.fn(() => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() })),
}));

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'kraki-resume-effort-')); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('K-133: lazy resume restores the reasoning effort', () => {
  it('passes the persisted effort with the persisted model', async () => {
    const adapter = {
      registerSessionAgent: vi.fn(),
      resumeSession: vi.fn(async () => ({ sessionId: 's' })),
      setSessionMode: vi.fn(),
      setSessionModel: vi.fn(async () => {}),
      setSessionUsage: vi.fn(),
    };
    const sm = new SessionManager(dir);
    const { sessionId } = sm.createSession('pi', 'deepseek/flash', undefined, 'max');
    sm.markDisconnected(sessionId);
    const client = new RelayClient(adapter as unknown as AgentAdapter, sm, {
      relayUrl: 'ws://unused', authMethod: 'open', device: { name: 'Test', role: 'tentacle' },
    });

    await expect(ensureSessionResumed(client, sessionId)).resolves.toBe(true);
    expect(adapter.setSessionModel).toHaveBeenCalledWith(sessionId, 'deepseek/flash', 'max');
  });
});
