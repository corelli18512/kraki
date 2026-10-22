/**
 * Log audit 2026-10-22 (web-mac-client P2-1, diag-mac-win P1-6): the Tentacle
 * re-broadcasts the full session_list after every reply. Each repeat re-read
 * ~450 cached rows from IndexedDB (and rewrote them), and issued hundreds of
 * no-op store updates, freezing the Windows UI for ~2 s per message.
 *
 * A repeated, unchanged session_list must not touch IndexedDB or notify store
 * subscribers; a list whose only change is one session's new tail must cost
 * that one session only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KrakiWSClient } from './ws-client';
import { useStore } from '../hooks/useStore';
import { messageProvider } from './message-provider';
import type { ChatMessage } from '../types/store';

/** The IndexedDB cache: every session holds its last 50 rows. Reads and
 *  write-backs are counted. */
const db = vi.hoisted(() => ({
  rangeReads: 0,
  puts: 0,
  lastSeq: new Map<string, number>(),
  row: (sessionId: string, seq: number) => ({
    type: 'agent_message', sessionId, deviceId: 'dev-t1', seq,
    timestamp: '2026-10-21T10:00:00.000Z', payload: { content: `reply ${seq}` },
  }),
}));

vi.mock('./message-db', () => ({
  putMessage: async () => { db.puts++; },
  putMessages: async () => { db.puts++; },
  getMessages: async () => [],
  getMessagesInRange: async (sessionId: string, from: number, to: number) => {
    db.rangeReads++;
    const rows: unknown[] = [];
    const cachedThrough = Math.min(to, db.lastSeq.get(sessionId) ?? 50);
    for (let seq = from; seq <= cachedThrough; seq++) rows.push(db.row(sessionId, seq));
    return rows;
  },
  getAllMessages: async () => new Map(),
  getLastSeq: async () => 0,
  deleteSessionMessages: async () => {},
  updateSessionMessages: async () => {},
  clearAllMessages: async () => {},
}));

const agentRow = (sessionId: string, seq: number) => db.row(sessionId, seq) as ChatMessage;
const sid = (index: number) => `sess-${index}`;

const SESSIONS = 50;
const recent = new Date(Date.now() - 60_000).toISOString();

function digest(index: number, lastSeq = 50, state: 'idle' | 'active' = 'idle') {
  return {
    id: sid(index), agent: 'pi', state, mode: 'execute',
    lastSeq, readSeq: lastSeq, messageCount: lastSeq, createdAt: recent, title: `Session ${index}`,
    pinned: index === 0,
    preview: { text: `reply ${lastSeq}`, type: 'agent', timestamp: recent },
    usage: { inputTokens: 10, outputTokens: 20 },
  };
}

function sessionList(sessions: ReturnType<typeof digest>[]) {
  return { type: 'session_list', deviceId: 'dev-t1', seq: 1, timestamp: recent, payload: { sessions, archivedCount: 0, autoArchiveDays: 14 } };
}

/** Count writes of the persisted store snapshot (`kraki-store`) from now on. */
function countPersistWrites(): () => number {
  let writes = 0;
  const original = Storage.prototype.setItem;
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key: string, value: string) {
    if (key === 'kraki-store') writes++;
    original.call(this, key, value);
  });
  return () => writes;
}

/** Wait for warm-up and its asynchronous IndexedDB write-back to finish. */
async function settle(): Promise<void> {
  await vi.waitFor(() => { expect(useStore.getState().loadingSessions.size).toBe(0); });
  let last = -1;
  while (last !== db.puts + db.rangeReads) {
    last = db.puts + db.rangeReads;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
}

describe('repeated session_list (Tentacle re-broadcast after each reply)', () => {
  let client: KrakiWSClient;
  const apply = (msg: unknown) => (client as unknown as { handleSessionList(m: unknown): void }).handleSessionList(msg);

  beforeEach(() => {
    useStore.getState().reset();
    messageProvider.clear();
    db.lastSeq.clear();
    db.rangeReads = 0;
    client = new KrakiWSClient('ws://localhost:9999');
  });
  afterEach(() => {
    vi.restoreAllMocks();
    messageProvider.clear();
  });

  it('an unchanged list reads no IndexedDB rows and notifies no store subscriber', async () => {
    const list = sessionList(Array.from({ length: SESSIONS }, (_, i) => digest(i)));
    apply(list);
    await settle();
    expect(db.rangeReads).toBe(SESSIONS); // first list warms every recent session once
    expect(useStore.getState().messages.get(sid(7))).toHaveLength(50);

    db.rangeReads = 0;
    let notifications = 0;
    const unsubscribe = useStore.subscribe(() => { notifications++; });
    const persistWrites = countPersistWrites();
    const started = performance.now();
    apply(sessionList(Array.from({ length: SESSIONS }, (_, i) => digest(i))));
    const syncMs = performance.now() - started;
    await settle();
    unsubscribe();
    console.log(`SESSION_LIST_REPEAT reads=${db.rangeReads} notifications=${notifications} persistWrites=${persistWrites()} syncMs=${syncMs.toFixed(1)}`);
    expect(db.rangeReads).toBe(0);
    expect(notifications).toBe(0);
    // Each persisted-store write serializes every session to localStorage.
    expect(persistWrites()).toBe(0);
  });

  it('a list where one session advanced costs only that session', async () => {
    apply(sessionList(Array.from({ length: SESSIONS }, (_, i) => digest(i))));
    await settle();

    // The live reply already reached memory through the router.
    useStore.getState().appendMessage(sid(3), agentRow(sid(3), 51));
    await settle();
    db.rangeReads = 0;
    let notifications = 0;
    const unsubscribe = useStore.subscribe(() => { notifications++; });
    const persistWrites = countPersistWrites();
    apply(sessionList(Array.from({ length: SESSIONS }, (_, i) => digest(i, i === 3 ? 51 : 50))));
    await settle();
    unsubscribe();
    console.log(`SESSION_LIST_ONE_CHANGED reads=${db.rangeReads} notifications=${notifications} persistWrites=${persistWrites()}`);
    expect(db.rangeReads).toBe(0);
    expect(persistWrites()).toBeLessThanOrEqual(3);
    // upsertSession + preview for the one changed session.
    expect(notifications).toBeLessThanOrEqual(3);
    expect(useStore.getState().sessions.get(sid(3))?.lastSeq).toBe(51);
    expect(useStore.getState().sessionPreviews.get(sid(3))?.text).toBe('reply 51');
  });

  it('still warms a session whose new tail is not in memory', async () => {
    apply(sessionList(Array.from({ length: SESSIONS }, (_, i) => digest(i))));
    await settle();
    db.rangeReads = 0;
    db.lastSeq.set(sid(5), 52);
    db.rangeReads = 0;
    apply(sessionList(Array.from({ length: SESSIONS }, (_, i) => digest(i, i === 5 ? 52 : 50))));
    await settle();
    expect(db.rangeReads).toBe(1);
    expect(useStore.getState().messages.get(sid(5))?.at(-1)).toMatchObject({ seq: 52 });
  });
});
