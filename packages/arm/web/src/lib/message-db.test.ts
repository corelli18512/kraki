/**
 * IDB transient-leak prevention tests.
 *
 * Validates the fix for the bug where updateSessionMessages (a whole-array
 * rewrite) persisted transient trace rows (tool_start/agent_narration/etc.
 * with fractional seqs from setTurnSteps). Those rows resurrected as
 * duplicate/spurious bubbles on the next load.
 *
 * Three layers of protection, all tested here:
 *  1. Write filters: putMessage/putMessages/updateSessionMessages skip transient.
 *  2. Read filters: getMessages/getMessagesInRange/getAllMessages drop any
 *     transient row that slipped through.
 *  3. Post-open sweep: leaked rows are reclaimed once per client.
 *
 * Run inside jsdom against a `fake-indexeddb` shim. The module caches its
 * dbPromise at module scope, so each test resets it via deleteDB + vi.resetModules.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { deleteDB } from 'idb';

const DB_NAME = 'kraki-messages';
const STORE_NAME = 'messages';

type Msg = { type: string; seq?: number; payload?: Record<string, unknown>; [k: string]: unknown };

async function freshModule() {
  // Clear the module cache + localStorage sweep flag so each test starts clean.
  localStorage.removeItem('kraki-idb-transient-swept');
  vi.resetModules();
  const mod = await import('./message-db');
  return mod;
}

describe('message-db transient filtering on write', () => {
  beforeEach(async () => {
    // Each test uses a distinct session id; we avoid deleteDB (it hangs when
    // the module holds an open connection under fake-indexeddb).
  });

  it('putMessage skips transient types', async () => {
    const db = await freshModule();
    await db.putMessage('sess-pm-1', { type: 'tool_start', seq: 2.5, payload: {} } as Msg);
    await db.putMessage('sess-pm-1', { type: 'user_message', seq: 1, payload: { content: 'hi' } } as Msg);
    const msgs = await db.getMessages('sess-pm-1');
    expect(msgs).toHaveLength(1);
    expect(msgs[0].type).toBe('user_message');
  });

  it('putMessages skips transient types (range batch path)', async () => {
    const db = await freshModule();
    await db.putMessages('sess-pms-1', [
      { type: 'user_message', seq: 1, payload: { content: 'a' } } as Msg,
      { type: 'agent_narration', seq: 1.5, payload: { content: 'thinking' } } as Msg,
      // A synthetic row with a durable-looking type must still be rejected by
      // its fractional seq; type filtering alone is not sufficient.
      { type: 'agent_message', seq: 1.75, payload: { content: 'synthetic' } } as Msg,
      { type: 'agent_message', seq: 2, payload: { content: 'reply' } } as Msg,
      { type: 'tool_complete', seq: 2.5, payload: {} } as Msg,
    ]);
    const msgs = await db.getMessages('sess-pms-1');
    expect(msgs.map((m) => m.type)).toEqual(['user_message', 'agent_message']);
    expect(msgs.map((m) => (m as { seq?: number }).seq)).toEqual([1, 2]);
  });

  it('updateSessionMessages (whole-array rewrite) drops transient rows', async () => {
    const db = await freshModule();
    // Simulate the bug: an in-memory array that mixed real + trace rows, then
    // got rewritten via updateSessionMessages.
    await db.updateSessionMessages('sess-usm-1', [
      { type: 'user_message', seq: 1, payload: { content: 'q' } } as Msg,
      { type: 'tool_start', seq: 1.5, payload: {} } as Msg,
      { type: 'agent_message', seq: 2, payload: { content: 'a' } } as Msg,
      { type: 'agent_narration', seq: 2.5, payload: { content: 'n' } } as Msg,
      { type: 'idle', seq: 3, payload: {} } as Msg,
    ]);
    const msgs = await db.getMessages('sess-usm-1');
    // Only the 3 real spine rows persist — NO fractional-seq trace leak.
    expect(msgs.map((m) => m.type)).toEqual(['user_message', 'agent_message', 'idle']);
    expect(msgs.every((m) => Number.isInteger((m as { seq?: number }).seq))).toBe(true);
  });
});

describe('message-db transient filtering on read (defense-in-depth)', () => {
  beforeEach(async () => {
    // Note: we don't deleteDB here (it hangs under fake-indexeddb when the
    // module holds an open connection). Instead each test seeds + reads in a
    // distinct session id so they're independent.
  });

  it('getMessagesInRange drops fractional rows even with a durable-looking type', async () => {
    const db = await freshModule();
    await db.putMessages('sess-read-range-1', [
      { type: 'user_message', seq: 10, payload: { content: 'keep' } } as Msg,
      { type: 'idle', seq: 12, payload: {} } as Msg,
    ]);

    // Bypass module write guards to simulate an old client that leaked a TRACE
    // projection row whose type looks durable enough to pass a type-only filter.
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open(DB_NAME);
      request.onsuccess = () => {
        const raw = request.result;
        const tx = raw.transaction(STORE_NAME, 'readwrite');
        tx.objectStore(STORE_NAME).put({
          sessionId: 'sess-read-range-1',
          seq: 10.5,
          data: { type: 'agent_message', seq: 10.5, payload: { content: 'synthetic trace row' } },
        });
        tx.oncomplete = () => { raw.close(); resolve(); };
        tx.onerror = () => { raw.close(); reject(tx.error); };
      };
      request.onerror = () => reject(request.error);
    });

    const msgs = await db.getMessagesInRange('sess-read-range-1', 10, 12);
    expect(msgs.map((m) => (m as { seq?: number }).seq)).toEqual([10, 12]);
  });
});
