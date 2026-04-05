/**
 * IndexedDB message storage for Kraki web app.
 *
 * Messages are stored per session with compound key [sessionId, seq].
 * This gives automatic dedup (upsert by key) and efficient range queries.
 */

import { openDB, type IDBPDatabase } from 'idb';
import type { ChatMessage } from '../types/store';

const DB_NAME = 'kraki-messages';
const DB_VERSION = 3;
const STORE_NAME = 'messages';

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
      },
    });
  }
  return dbPromise;
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
    const seq = 'seq' in msg ? (msg as { seq?: number }).seq ?? 0 : 0;
    await store.put({ sessionId, seq, data: msg } satisfies StoredMessage);
  }
  await tx.done;
}

/**
 * Store a single message.
 */
export async function putMessage(sessionId: string, message: ChatMessage): Promise<void> {
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
  return records.map(r => r.data);
}

/**
 * Get all messages across all sessions, grouped by sessionId.
 */
export async function getAllMessages(): Promise<Map<string, ChatMessage[]>> {
  const db = await getDB();
  const records = await db.getAll(STORE_NAME) as StoredMessage[];
  const grouped = new Map<string, ChatMessage[]>();
  for (const r of records) {
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

  // Write updated messages
  for (const msg of messages) {
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
