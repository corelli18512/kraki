/**
 * A permission the adapter resolves without the operator (K-054): approved
 * by a switch to an automatic mode, or cancelled (agent died, Stop, mode
 * switch away). The card, the Steps trace and the apps must all see the
 * real resolution. Real SessionManager on a temp dir, fake adapter.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SessionManager } from '../session-manager.js';
import { RelayClient } from '../relay-client.js';
import type { AgentAdapter } from '../adapters/base.js';

vi.mock('../logger.js', () => ({
  createLogger: vi.fn(() => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() })),
}));

type Cb = (...args: unknown[]) => void;

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'kraki-perm-auto-')); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function build() {
  const sm = new SessionManager(dir);
  const adapter = {
    generateTitle: vi.fn(async () => null),
    getSessionUsage: vi.fn(() => null),
    registerSessionAgent: vi.fn(),
    setTurnIdentity: vi.fn(),
    isTurnSettled: vi.fn(() => false),
  } as Record<string, unknown>;
  const client = new RelayClient(adapter as unknown as AgentAdapter, sm, {
    relayUrl: 'ws://unused', authMethod: 'open', device: { name: 'Test', role: 'tentacle' },
  });
  const sent: Array<{ type?: string; payload?: unknown }> = [];
  const send = client.send.bind(client);
  vi.spyOn(client, 'send').mockImplementation((msg, ...rest) => { sent.push(JSON.parse(JSON.stringify(msg))); send(msg, ...rest); });
  const traces: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const appendTrace = sm.appendTrace.bind(sm);
  vi.spyOn(sm, 'appendTrace').mockImplementation((sid, type, payload) => { traces.push(JSON.parse(payload)); appendTrace(sid, type, payload); });
  const cb = (name: string) => adapter[name] as Cb;
  const { sessionId } = sm.createSession('pi');
  cb('onPermissionRequest')(sessionId, {
    id: 'perm-1', toolArgs: { toolName: 'bash', args: { command: 'rm -rf build' } }, description: 'rm -rf build',
  });
  const permissionTrace = () => traces.filter((e) => e.type === 'permission').map((e) => e.payload);
  return { client, sm, sent, cb, sessionId, permissionTrace };
}

describe('onPermissionAutoResolved (K-054)', () => {
  it('a cancelled permission is recorded as cancelled, not approved, and the apps are told', () => {
    const { client, sent, cb, sessionId, permissionTrace } = build();
    cb('onPermissionAutoResolved')(sessionId, 'perm-1', 'cancelled');

    expect(client.card.state(sessionId).action).toBeNull();
    const resolved = permissionTrace().at(-1)!;
    expect(resolved).toMatchObject({ id: 'perm-1', cancelled: true });
    expect(resolved.decision).toBeUndefined();
    expect(sent.find((m) => m.type === 'permission_resolved')?.payload)
      .toEqual({ permissionId: 'perm-1', resolution: 'cancelled' });
    expect(client.openPermissions.get(sessionId)?.has('perm-1')).toBe(false);
  });

  it('an auto-approved permission is shown approved and the apps are told', () => {
    const { client, sent, cb, sessionId, permissionTrace } = build();
    cb('onPermissionAutoResolved')(sessionId, 'perm-1', 'approved');

    expect(client.card.state(sessionId).action).toMatchObject({ type: 'permission', payload: { id: 'perm-1', decision: 'approve' } });
    expect(permissionTrace().at(-1)).toMatchObject({ id: 'perm-1', decision: 'approve' });
    expect(sent.find((m) => m.type === 'permission_resolved')?.payload)
      .toEqual({ permissionId: 'perm-1', resolution: 'approved' });
  });
});
