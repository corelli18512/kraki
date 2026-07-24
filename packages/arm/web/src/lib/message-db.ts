/**
 * IndexedDB message storage for Kraki web app.
 *
 * Messages are stored per session with compound key [sessionId, seq].
 * This gives automatic dedup (upsert by key) and efficient range queries.
 */

import { openDB, type IDBPDatabase } from 'idb';
import type { ChatMessage } from '../types/store';

const DB_NAME = 'kraki-messages';
const DB_VERSION = 5;
const STORE_NAME = 'messages';

/** Message types that are TRANSIENT — they stream live for the in-progress turn
 *  (or are optimistic UI) and are pulled lazily from the tentacle's trace.jsonl.
 *  They must NEVER be persisted to IndexedDB: they carry fractional seqs
 *  (assigned by setTurnSteps) and a future load would resurrect them as
 *  duplicate/spurious bubbles. This is the authoritative filter shared by all
 *  write paths; read paths also filter as defense-in-depth. */
const TRANSIENT_TYPES = new Set([
  'pending_input',
  'tool_start',
  'tool_complete',
  'agent_narration',
  'active',
  'compacting',
  // question/permission/answer are turn-internal mechanics surfaced via the
  // live card + TRACE, never durable spine bubbles.
  'question',
  'permission',
  'answer',
  'question_resolved',
  'permission_resolved',
]);

/** True for a message that must never be written to / read from IndexedDB. */
function isTransientMessage(message: ChatMessage): boolean {
  return TRANSIENT_TYPES.has(message.type);
}

interface StoredMessage {
  sessionId: string;
  seq: number;
  data: ChatMessage;
}

let dbPromise: Promise<IDBPDatabase> | null = null;

function getDB(): Promise<IDBPDatabase> {
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, DB_VERSION, {
      upgrade(db, oldVersion) {
        if (oldVersion < 1) {
          const store = db.createObjectStore(STORE_NAME, { keyPath: ['sessionId', 'seq'] });
          store.createIndex('sessionId', 'sessionId', { unique: false });
        }
        // v2 added pending-permissions and pending-questions stores.
        // v3 removes them — pending state is now in-memory only,
        // restored from message replay on reconnect.
        if (oldVersion >= 2 && oldVersion < 3) {
          if (db.objectStoreNames.contains('pending-permissions')) {
            db.deleteObjectStore('pending-permissions');
          }
          if (db.objectStoreNames.contains('pending-questions')) {
            db.deleteObjectStore('pending-questions');
          }
        }
        // v5: schema bump to flag the transient-leak fix. The actual sweep of
        // leaked fractional-seq trace rows is NOT done inside this versionchange
        // transaction (async cursor iteration during upgrade is unreliable and
        // aborts under fake-indexeddb and some real engines). Instead the
        // cleanup runs once after open, in a normal readwrite transaction (see
        // `sweepTransientRows`). This bump still serves a purpose: it guarantees
        // the post-open sweep runs exactly once per client.
        if (oldVersion < 5) {
          // no schema change — the store already exists from v1.
        }
      },
    }).then(async (db) => {
      // One-time sweep of leaked transient rows (run at most once per client,
      // guarded by a localStorage flag). Earlier builds persisted fractional-
      // seq trace rows via updateSessionMessages; the read filters below make
      // them invisible, but this reclaims the wasted space. Runs in a normal
      // readwrite transaction after open — safe across engines.
      try {
        if (localStorage.getItem('kraki-idb-transient-swept') !== '1') {
          await sweepTransientRows(db);
          localStorage.setItem('kraki-idb-transient-swept', '1');
        }
      } catch {
        // localStorage may be unavailable (private mode) — the read filters
        // are the real protection; this sweep is best-effort disk reclamation.
      }
      return db;
    });
  }
  return dbPromise;
}

/** Delete every row whose type is transient or whose seq is non-integer (the
 *  signature of a leaked trace step). Idempotent — safe to call repeatedly. */
async function sweepTransientRows(db: IDBPDatabase): Promise<void> {
  if (!db.objectStoreNames.contains(STORE_NAME)) return;
  const tx = db.transaction(STORE_NAME, 'readwrite');
  const store = tx.objectStore(STORE_NAME);
  let cursor = await store.openCursor();
  while (cursor) {
    const row = cursor.value as StoredMessage;
    const dataType = row?.data?.type as string | undefined;
    const seq = row?.seq;
    const isTransient =
      (dataType && TRANSIENT_TYPES.has(dataType)) ||
      (typeof seq === 'number' && !Number.isInteger(seq));
    if (isTransient) cursor.delete();
    cursor = await cursor.continue();
  }
  await tx.done;
}

/**
 * Store messages for a session. Upserts by [sessionId, seq].
 * Messages with seq=0 (e.g. pending_input conversions) are stored but
 * may be overwritten when the real seq arrives.
 */
export async function putMessages(sessionId: string, messages: ChatMessage[]): Promise<void> {
  const db = await getDB();
  const tx = db.transaction(STORE_NAME, 'readwrite');
  const store = tx.objectStore(STORE_NAME);
  for (const msg of messages) {
    // Never persist transient trace/pending rows — they carry fractional seqs
    // and would resurrect as duplicate bubbles on the next load.
    if (isTransientMessage(msg)) continue;
    const seq = 'seq' in msg ? (msg as { seq?: number }).seq ?? 0 : 0;
    await store.put({ sessionId, seq, data: msg } satisfies StoredMessage);
  }
  await tx.done;
}

/**
 * Store a single message. Filters out transient types (the caller in useStore
 * already gates on isTransient, but this is the authoritative guard).
 */
export async function putMessage(sessionId: string, message: ChatMessage): Promise<void> {
  if (isTransientMessage(message)) return;
  const db = await getDB();
  const seq = 'seq' in message ? (message as { seq?: number }).seq ?? 0 : 0;
  await db.put(STORE_NAME, { sessionId, seq, data: message } satisfies StoredMessage);
}

/**
 * Get all messages for a session, ordered by seq.
 */
export async function getMessages(sessionId: string): Promise<ChatMessage[]> {
  const db = await getDB();
  const index = db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).index('sessionId');
  const records = await index.getAll(sessionId) as StoredMessage[];
  records.sort((a, b) => a.seq - b.seq);
  // Defense-in-depth: drop any transient row that slipped through (older
  // builds, or a future type). Trace is pulled on demand via request_turn_trace.
  return records.map(r => r.data).filter((m) => !isTransientMessage(m));
}

/**
 * Get all messages across all sessions, grouped by sessionId.
 */
export async function getAllMessages(): Promise<Map<string, ChatMessage[]>> {
  const db = await getDB();
  const records = await db.getAll(STORE_NAME) as StoredMessage[];
  const grouped = new Map<string, ChatMessage[]>();
  for (const r of records) {
    // Defense-in-depth: skip transient rows (trace/pending) — see getMessages.
    if (isTransientMessage(r.data)) continue;
    if (!grouped.has(r.sessionId)) grouped.set(r.sessionId, []);
    grouped.get(r.sessionId)!.push(r.data);
  }
  // Sort each session's messages by seq
  for (const [, msgs] of grouped) {
    msgs.sort((a, b) => {
      const seqA = 'seq' in a ? (a as { seq?: number }).seq ?? 0 : 0;
      const seqB = 'seq' in b ? (b as { seq?: number }).seq ?? 0 : 0;
      return seqA - seqB;
    });
  }
  return grouped;
}

/**
 * Get the highest seq for a session.
 */
export async function getLastSeq(sessionId: string, maxSeq?: number): Promise<number> {
  const db = await getDB();
  const range = IDBKeyRange.bound([sessionId, 0], [sessionId, maxSeq ?? Number.MAX_SAFE_INTEGER]);
  const cursor = await db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).openCursor(range, 'prev');
  return (cursor?.value as StoredMessage | undefined)?.seq ?? 0;
}

/**
 * Get messages for a session within a seq range [fromSeq, toSeq], ordered by seq.
 */
export async function getMessagesInRange(sessionId: string, fromSeq: number, toSeq: number): Promise<ChatMessage[]> {
  const db = await getDB();
  const range = IDBKeyRange.bound([sessionId, fromSeq], [sessionId, toSeq]);
  const records = await db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).getAll(range) as StoredMessage[];
  records.sort((a, b) => a.seq - b.seq);
  return records.map(r => r.data).filter((m) => !isTransientMessage(m));
}

/**
 * Delete all messages for a session.
 */
export async function deleteSessionMessages(sessionId: string): Promise<void> {
  const db = await getDB();
  const tx = db.transaction(STORE_NAME, 'readwrite');
  const index = tx.objectStore(STORE_NAME).index('sessionId');
  let cursor = await index.openCursor(sessionId);
  while (cursor) {
    cursor.delete();
    cursor = await cursor.continue();
  }
  await tx.done;
}

/**
 * Update messages in place for a session (used for tool_complete merge, permission resolution).
 */
export async function updateSessionMessages(sessionId: string, messages: ChatMessage[]): Promise<void> {
  const db = await getDB();
  const tx = db.transaction(STORE_NAME, 'readwrite');
  const store = tx.objectStore(STORE_NAME);

  // Delete existing messages for this session
  const index = store.index('sessionId');
  let cursor = await index.openCursor(sessionId);
  while (cursor) {
    cursor.delete();
    cursor = await cursor.continue();
  }

  // Write updated messages (transient types are filtered out so a whole-array
  // rewrite cannot persist trace/pending rows that only live in memory).
  for (const msg of messages) {
    if (isTransientMessage(msg)) continue;
    const seq = 'seq' in msg ? (msg as { seq?: number }).seq ?? 0 : 0;
    await store.put({ sessionId, seq, data: msg } satisfies StoredMessage);
  }
  await tx.done;
}

/**
 * Clear all messages from IndexedDB.
 */
export async function clearAllMessages(): Promise<void> {
  const db = await getDB();
  await db.clear(STORE_NAME);
}
