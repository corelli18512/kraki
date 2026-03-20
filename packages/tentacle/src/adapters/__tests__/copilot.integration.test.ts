/**
 * Integration tests for CopilotAdapter — runs against real Copilot CLI.
 *
 * Requires:
 *  - `copilot` CLI installed and authenticated
 *  - `gh` CLI authenticated (for token resolution)
 *
 * Run with: pnpm test:integration
 */

import { describe, it, expect, afterAll } from 'vitest';
import { CopilotAdapter } from '../copilot.js';

describe('CopilotAdapter (live Copilot)', () => {
  const adapter = new CopilotAdapter();
  let sessionId: string;

  afterAll(async () => {
    try { await adapter.stop(); } catch { /* ignore */ }
  });

  it('starts the adapter successfully', async () => {
    await adapter.start();
  });

  it('creates a session', async () => {
    const events: string[] = [];
    adapter.onSessionCreated = (e) => events.push(`created:${e.sessionId}`);

    const result = await adapter.createSession({ model: 'claude-sonnet-4.6', cwd: '/tmp' });
    sessionId = result.sessionId;

    expect(sessionId).toBeTruthy();
    expect(events[0]).toContain('created:');
  });

  it('sends a message and receives a response', async () => {
    const messages: string[] = [];
    const states: string[] = [];

    adapter.onMessage = (sid, e) => messages.push(e.content);
    adapter.onIdle = (sid) => states.push('idle');

    await adapter.sendMessage(sessionId, 'What is 2+2? One word.');

    // Wait for idle
    await new Promise<void>((resolve) => {
      const orig = adapter.onIdle;
      adapter.onIdle = (sid) => {
        orig?.(sid);
        resolve();
      };
      // Timeout safety
      setTimeout(resolve, 30000);
    });

    expect(messages.length).toBeGreaterThan(0);
    expect(states).toContain('idle');
  });

  it('handles permission request for file write', async () => {
    const permEvents: any[] = [];
    const messages: string[] = [];

    adapter.onPermissionRequest = (sid, e) => {
      permEvents.push(e);
      // Auto-approve all permissions
      adapter.respondToPermission(sid, e.id, 'approve').catch(() => {
        // Session may have been cleaned up — safe to ignore
      });
    };
    adapter.onMessage = (sid, e) => messages.push(e.content);

    await adapter.sendMessage(
      sessionId,
      'Create a file /tmp/kraki-integration-test.txt with the text "kraki works"',
    );

    // Wait for idle
    await new Promise<void>((resolve) => {
      adapter.onIdle = () => resolve();
      setTimeout(resolve, 60000);
    });

    // Should have received at least one permission request
    expect(permEvents.length).toBeGreaterThan(0);
    expect(permEvents[0].toolName).toBeTruthy();
    expect(permEvents[0].id).toMatch(/^perm-/);

    // Should have a response
    expect(messages.length).toBeGreaterThan(0);
  });

  it('lists sessions', async () => {
    const list = await adapter.listSessions();
    expect(list.length).toBeGreaterThan(0);
    const found = list.find((s) => s.id === sessionId);
    expect(found).toBeTruthy();
    expect(found!.state).toBe('active');
  });

  it('kills the session', async () => {
    let endReason: string | null = null;
    adapter.onSessionEnded = (sid, e) => { endReason = e.reason; };
    // Clear permission handler to avoid errors from late SDK callbacks
    adapter.onPermissionRequest = () => {};

    await adapter.killSession(sessionId);

    expect(endReason).toBe('killed');
  });

  it('stops the adapter cleanly', async () => {
    await adapter.stop();
    const list = await adapter.listSessions();
    expect(list).toEqual([]);
  });
});
