/**
 * K-122: with the disk full, a message from the phone could not be stored and
 * disappeared without a word. The app must get an error in the chat.
 * Real SessionManager on a temp dir, fake adapter, no sockets.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SessionManager } from '../session-manager.js';
import { RelayClient } from '../relay-client.js';
import { handleConsumerMessage } from '../relay/consumer-messages.js';
import type { AgentAdapter } from '../adapters/base.js';

vi.mock('../logger.js', () => ({
  createLogger: vi.fn(() => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() })),
}));

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'kraki-input-enospc-')); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const enospc = () => { throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' }); };

describe('send_input on a full disk (K-122)', () => {
  it('tells the app its message was not saved instead of dropping it silently', () => {
    const sm = new SessionManager(dir);
    const adapter = { isTurnSettled: vi.fn(() => false), sendMessage: vi.fn(async () => {}) };
    const client = new RelayClient(adapter as unknown as AgentAdapter, sm, {
      relayUrl: 'ws://unused', authMethod: 'open', device: { name: 'Test', role: 'tentacle' },
    });
    const { sessionId } = sm.createSession('claude');
    vi.spyOn(sm, 'recordInputLedger').mockImplementation(enospc);
    vi.spyOn(sm, 'appendMessage').mockImplementation(enospc);
    const send = vi.spyOn(client, 'send');

    expect(() => handleConsumerMessage(client, {
      type: 'send_input', sessionId, deviceId: 'app-1', payload: { text: 'hello', clientId: 'cid-1' },
    })).not.toThrow();

    const errors = send.mock.calls.filter(([m]) => m.type === 'error');
    expect(errors.length).toBeGreaterThan(0);
    const last = errors.at(-1)!;
    expect((last[0].payload as { message: string }).message).toContain('disk is full');
    // The error row cannot be stored on a full disk: the last attempt is live-only.
    expect(last[2]).toEqual({ persist: false });
    expect(adapter.sendMessage).not.toHaveBeenCalled();
  });

  it('a resend with the same clientId runs once the disk has space again', async () => {
    const sm = new SessionManager(dir);
    const adapter = { isTurnSettled: vi.fn(() => false), sendMessage: vi.fn(async () => {}) };
    const client = new RelayClient(adapter as unknown as AgentAdapter, sm, {
      relayUrl: 'ws://unused', authMethod: 'open', device: { name: 'Test', role: 'tentacle' },
    });
    const { sessionId } = sm.createSession('claude');
    const append = vi.spyOn(sm, 'appendMessage').mockImplementationOnce(enospc);
    vi.spyOn(client, 'send');
    const input = { type: 'send_input' as const, sessionId, deviceId: 'app-1', payload: { text: 'hello', clientId: 'cid-1' } };

    handleConsumerMessage(client, input);
    expect(adapter.sendMessage).not.toHaveBeenCalled();

    // The ledger kept the reservation; the retry must not be taken for a
    // duplicate of an input that is already running.
    handleConsumerMessage(client, input);
    await vi.waitFor(() => expect(adapter.sendMessage).toHaveBeenCalledTimes(1));
    expect(append.mock.calls.filter(([, type]) => type === 'user_message')).toHaveLength(2);
  });
});
