/**
 * IDB schema migration tests.
 *
 * Run inside jsdom against a `fake-indexeddb` shim. The upgrade
 * function is mirrored here so we can exercise it directly with
 * fresh connections per test (the production module caches its
 * dbPromise at module scope).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';
import { openDB, deleteDB, type IDBPDatabase } from 'idb';

const DB_NAME = 'kraki-messages';
const STORE_NAME = 'messages';
const DB_VERSION = 4;

interface StoredMessage {
  sessionId: string;
  seq: number;
  data: { type: string; [key: string]: unknown };
}

// Mirror of the upgrade function in src/lib/message-db.ts. Kept in
// sync by hand — if you change the production upgrade, mirror it
// here so these tests still validate the real shape.
const upgradeFn = (db: IDBPDatabase, oldVersion: number) => {
  if (oldVersion < 1) {
    const store = db.createObjectStore(STORE_NAME, { keyPath: ['sessionId', 'seq'] });
    store.createIndex('sessionId', 'sessionId', { unique: false });
  }
  if (oldVersion >= 2 && oldVersion < 3) {
    if (db.objectStoreNames.contains('pending-permissions')) {
      db.deleteObjectStore('pending-permissions');
    }
    if (db.objectStoreNames.contains('pending-questions')) {
      db.deleteObjectStore('pending-questions');
    }
  }
  // v4: intentional no-op (see message-db.ts comment).
};

async function seedV3WithPending(): Promise<void> {
  const db = await openDB(DB_NAME, 3, {
    upgrade(db) {
      const store = db.createObjectStore(STORE_NAME, { keyPath: ['sessionId', 'seq'] });
      store.createIndex('sessionId', 'sessionId', { unique: false });
    },
  });
  const tx = db.transaction(STORE_NAME, 'readwrite');
  await tx.store.put({ sessionId: 'sess-1', seq: 1, data: { type: 'user_message', seq: 1, payload: { content: 'first' } } });
  await tx.store.put({ sessionId: 'sess-1', seq: 2, data: { type: 'agent_message', seq: 2, payload: { content: 'reply' } } });
  await tx.store.put({ sessionId: 'sess-1', seq: 0, data: { type: 'pending_input', clientId: 'cid-stale', text: 'never resolved' } });
  await tx.store.put({ sessionId: 'sess-2', seq: 1, data: { type: 'user_message', seq: 1, payload: { content: 'other session' } } });
  await tx.done;
  db.close();
}

async function openAtV4(): Promise<IDBPDatabase> {
  return openDB(DB_NAME, DB_VERSION, { upgrade: upgradeFn });
}

async function readAllInSession(db: IDBPDatabase, sessionId: string): Promise<Array<{ type: string; seq?: number }>> {
  const index = db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).index('sessionId');
  const records = await index.getAll(sessionId) as StoredMessage[];
  records.sort((a, b) => a.seq - b.seq);
  return records.map(r => r.data);
}

describe('message-db v4 migration (no-op)', () => {
  beforeEach(async () => {
    await deleteDB(DB_NAME).catch(() => {});
  });

  it('v3 → v4 open succeeds', async () => {
    await seedV3WithPending();
    const db = await openAtV4();
    expect(db.version).toBe(4);
    db.close();
  });

  it('v3 → v4 preserves all existing rows (including legacy seq=0 pending_input)', async () => {
    await seedV3WithPending();
    const db = await openAtV4();
    const sess1 = await readAllInSession(db, 'sess-1');
    // All three rows preserved — the seq=0 row is dead data but
    // consumers filter it out (getMessagesInRange uses key range
    // starting at seq=1; checkUnreadFromDb filters seq > readSeq).
    expect(sess1).toHaveLength(3);
    db.close();
  });

  it('v3 → v4 preserves real messages in other sessions', async () => {
    await seedV3WithPending();
    const db = await openAtV4();
    const sess2 = await readAllInSession(db, 'sess-2');
    expect(sess2).toHaveLength(1);
    expect(sess2[0].type).toBe('user_message');
    db.close();
  });

  it('fresh install (no existing DB) succeeds', async () => {
    const db = await openAtV4();
    expect(db.version).toBe(4);
    db.close();
  });

  it('reopening at v4 (no upgrade) leaves data intact', async () => {
    await seedV3WithPending();
    const db1 = await openAtV4();
    const tx = db1.transaction(STORE_NAME, 'readwrite');
    await tx.store.put({ sessionId: 'sess-1', seq: 3, data: { type: 'user_message', seq: 3, payload: { content: 'after migrate' } } });
    await tx.done;
    db1.close();

    const db2 = await openAtV4();
    const sess1 = await readAllInSession(db2, 'sess-1');
    // 3 real rows + 1 legacy seq=0 row preserved.
    expect(sess1).toHaveLength(4);
    db2.close();
  });
});
