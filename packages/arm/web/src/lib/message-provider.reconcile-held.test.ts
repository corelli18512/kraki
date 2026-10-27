/**
 * Log audit 2026-10-22 (web-mac-client P2-2): every chat open reconciled the
 * same tail twice — the route's ensureLoaded and then the subscription
 * snapshot (or the closing idle followed by the session_list) — each with a
 * full IndexedDB read and re-delivery, which queued behind warm-up reads for
 * up to 2.7 s. A tail already held in memory must not be read again.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useStore } from '../hooks/useStore';
import { messageProvider } from './message-provider';
import { outbox } from './chat/outbox';
import type { ChatMessage } from '../types/store';

const db = vi.hoisted(() => ({ rangeReads: 0, lastSeq: 50 }));

vi.mock('./message-db', () => ({
  putMessage: async () => {},
  putMessages: async () => {},
  getMessagesInRange: async (sessionId: string, from: number, to: number) => {
    db.rangeReads++;
    const rows: unknown[] = [];
    for (let seq = from; seq <= Math.min(to, db.lastSeq); seq++) {
      rows.push({ type: 'agent_message', sessionId, deviceId: 'dev-t1', seq, timestamp: '', payload: { content: `r${seq}` } });
    }
    return rows;
  },
  deleteSessionMessages: async () => {},
}));

const SID = 'sess-open';
const sent: Record<string, unknown>[] = [];

async function idle(): Promise<void> {
  await vi.waitFor(() => { expect(messageProvider.isLoading(SID)).toBe(false); });
}

describe('tail reconciliation of a held window', () => {
  beforeEach(() => {
    useStore.getState().reset();
    messageProvider.clear();
    sent.length = 0;
    db.rangeReads = 0;
    db.lastSeq = 50;
    messageProvider.setSend((message) => { sent.push(message); });
    messageProvider.setTentacleInfo(SID, 50, 'dev-t1');
  });
  afterEach(() => {
    vi.restoreAllMocks();
    messageProvider.clear();
  });

  it('a chat open reads the cache once even when the subscription reconciles the same tail', async () => {
    messageProvider.ensureLoaded(SID); // route effect
    await idle();
    expect(db.rangeReads).toBe(1);
    expect(useStore.getState().messages.get(SID)).toHaveLength(50);

    messageProvider.reconcileTail(SID, 50); // subscription snapshot / session_list digest
    await idle();
    console.log(`RECONCILE_HELD reads=${db.rangeReads} tentacleRequests=${sent.length}`);
    expect(db.rangeReads).toBe(1);
    expect(sent).toHaveLength(0);
    expect(messageProvider.getRangeStatus(SID)).toEqual({ state: 'loaded' });
  });

  it('a range served from memory or the cache never reports loading; a Tentacle request does', async () => {
    const states: string[] = [];
    const unsubscribe = messageProvider.subscribeRangeStatus(() => states.push(messageProvider.getRangeStatus(SID).state));
    try {
      messageProvider.ensureLoaded(SID); // cache-only
      await idle();
      messageProvider.reconcileTail(SID, 50); // closing idle, memory-held
      await idle();
      expect(states).not.toContain('loading');
      expect(messageProvider.getRangeStatus(SID)).toEqual({ state: 'loaded' });
      db.lastSeq = 50; // seq 51 is not cached: the Tentacle is asked
      messageProvider.setTentacleInfo(SID, 51, 'dev-t1');
      messageProvider.reconcileTail(SID, 51);
      await vi.waitFor(() => expect(sent).toHaveLength(1));
      expect(messageProvider.getRangeStatus(SID)).toEqual({ state: 'loading' });
    } finally {
      unsubscribe();
    }
  });

  it('an earlier page that found seqs absent does not stop a later tail reconcile from asking the Tentacle', async () => {
    db.lastSeq = 48; // 49..50 are not cached
    messageProvider.ensureLoaded(SID);
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    // Authoritative answer without 49..50 (they are recorded as tombstones).
    messageProvider.handleRangeBatch(SID, [], 0, 0, false);
    await idle();
    expect(useStore.getState().messages.get(SID)).toHaveLength(48);
    // The foreground tail reconcile (chat open / session_list at seq 50) must
    // still ask, as it did before held windows were skipped.
    messageProvider.reconcileTail(SID, 50);
    await vi.waitFor(() => expect(sent).toHaveLength(2));
  });

  it('still reads when the authoritative tail moved past memory', async () => {
    messageProvider.ensureLoaded(SID);
    await idle();
    db.lastSeq = 51;
    messageProvider.reconcileTail(SID, 51);
    await idle();
    expect(db.rangeReads).toBe(2);
    expect((useStore.getState().messages.get(SID) as ChatMessage[]).at(-1)).toMatchObject({ seq: 51 });
  });

  it('confirms an outbox entry whose echo is already held', async () => {
    useStore.getState().prependMessages(SID, Array.from({ length: 50 }, (_, i) => ({
      type: i === 49 ? 'user_message' : 'agent_message', sessionId: SID, deviceId: 'dev-t1', seq: i + 1, timestamp: '',
      payload: i === 49 ? { content: 'hi', clientId: 'c-1' } : { content: `r${i + 1}` },
    }) as ChatMessage));
    vi.spyOn(outbox, 'forSession').mockReturnValue([{ clientId: 'c-1' } as never]);
    const confirm = vi.spyOn(outbox, 'confirm').mockReturnValue(true);
    messageProvider.reconcileTail(SID, 50);
    await idle();
    expect(db.rangeReads).toBe(0);
    expect(confirm).toHaveBeenCalledWith(SID, 'c-1', undefined);
  });
});
