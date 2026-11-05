/**
 * create_session folder (K-134): a missing, relative or unreadable folder is
 * refused at create with a message about the folder, instead of the first
 * send failing with a misleading agent spawn error. `~` means home.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleCreateSession } from '../relay/session-commands.js';
import type { RelayClient } from '../relay-client.js';

vi.mock('../logger.js', () => ({
  createLogger: vi.fn(() => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() })),
}));

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'kraki-create-folder-')); });
afterEach(() => {
  try { chmodSync(join(dir, 'locked'), 0o755); } catch { /* not created */ }
  rmSync(dir, { recursive: true, force: true });
});

function build() {
  const createSession = vi.fn(async () => ({ sessionId: 'sess-1' }));
  const send = vi.fn();
  const client = {
    adapter: { createSession },
    pendingRequestIds: new Map<string, string>(),
    sessionManager: { markIdle: vi.fn() },
    send,
  } as unknown as RelayClient;
  const create = (cwd?: string) => handleCreateSession(client, {
    type: 'create_session', deviceId: 'app-1', payload: { agentId: 'pi', requestId: 'req-1', ...(cwd !== undefined && { cwd }) },
  } as never);
  const error = () => (send.mock.calls.find((c) => c[0].type === 'error')?.[0] as { payload: { message: string; requestId?: string } } | undefined)?.payload;
  return { createSession, create, error };
}

describe('create_session folder (K-134)', () => {
  it('uses an existing absolute folder as is', async () => {
    const t = build();
    await t.create(dir);
    expect(t.createSession).toHaveBeenCalledWith(expect.objectContaining({ cwd: dir }));
    expect(t.error()).toBeUndefined();
  });

  it('works in home without a folder, and expands ~', async () => {
    const t = build();
    await t.create();
    await t.create('~');
    expect(t.createSession.mock.calls.map((c) => (c as unknown as [{ cwd: string }])[0].cwd)).toEqual([homedir(), homedir()]);
  });

  it.each([
    ['a missing folder', () => join(dir, 'nope'), /doesn't exist/],
    ['a relative folder', () => 'some/project', /full path/],
    ['a file', () => { const f = join(dir, 'file.txt'); writeFileSync(f, 'x'); return f; }, /not a folder/],
  ])('refuses %s before the agent starts', async (_label, path, message) => {
    const t = build();
    await t.create(path());
    expect(t.createSession).not.toHaveBeenCalled();
    expect(t.error()?.message).toMatch(message);
    expect(t.error()?.requestId).toBe('req-1');
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('refuses an unreadable folder', async () => {
    const locked = join(dir, 'locked');
    mkdirSync(locked);
    chmodSync(locked, 0o000);
    const t = build();
    await t.create(locked);
    expect(t.createSession).not.toHaveBeenCalled();
    expect(t.error()?.message).toMatch(/can't be opened/);
  });
});
