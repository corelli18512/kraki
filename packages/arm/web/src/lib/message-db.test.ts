/**
 * IDB schema migration tests.
 *
 * These tests run inside jsdom against a `fake-indexeddb` shim. They
 * use the openDB API directly (not the message-db module) so we can
 * close connections between scenarios and avoid the module-level
 * dbPromise caching.
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

// Mirror of the upgrade function in src/lib/message-db.ts. Tests
// exercise this directly rather than importing the module so each
// test can use a fresh connection without fighting module-level
// dbPromise caching.
const upgradeFn = (db: IDBPDatabase, oldVersion: number, _newVersion: number | null, tx: import('idb').IDBPTransaction<unknown, ArrayLike<string>, 'versionchange'>) => {
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
  if (oldVersion >= 1 && oldVersion < 4 && db.objectStoreNames.contains(STORE_NAME)) {
    const store = tx.objectStore(STORE_NAME);
    void (async () => {
      let cursor = await store.openCursor();
      while (cursor) {
        const stored = cursor.value as StoredMessage;
        if (stored.seq === 0 || stored.data?.type === 'pending_input') {
          cursor.delete();
        }
        cursor = await cursor.continue();
      }
    })();
  }
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
  return openDB(DB_NAME, DB_VERSION, { upgrade: upgradeFn as never });
}

async function readAllInSession(db: IDBPDatabase, sessionId: string): Promise<Array<{ type: string; seq?: number }>> {
  const index = db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).index('sessionId');
  const records = await index.getAll(sessionId) as StoredMessage[];
  records.sort((a, b) => a.seq - b.seq);
  return records.map(r => r.data);
}

describe('message-db v4 migration', () => {
  beforeEach(async () => {
    await deleteDB(DB_NAME).catch(() => {});
  });

  it('v3 → v4 open succeeds (this is the regression: previous code rejected here)', async () => {
    await seedV3WithPending();
    const db = await openAtV4();
    expect(db.version).toBe(4);
    db.close();
  });

  it('v3 → v4 prunes stale pending_input rows (seq=0)', async () => {
    await seedV3WithPending();
    const db = await openAtV4();
    const sess1 = await readAllInSession(db, 'sess-1');
    expect(sess1).toHaveLength(2);
    expect(sess1.every(m => m.type !== 'pending_input')).toBe(true);
    expect(sess1.map(m => m.seq).sort()).toEqual([1, 2]);
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

    // First open performs the v3 → v4 migration.
    const db1 = await openAtV4();
    const tx = db1.transaction(STORE_NAME, 'readwrite');
    await tx.store.put({ sessionId: 'sess-1', seq: 3, data: { type: 'user_message', seq: 3, payload: { content: 'after migrate' } } });
    await tx.done;
    db1.close();

    // Second open: same version, upgrade should NOT fire.
    const db2 = await openAtV4();
    const sess1 = await readAllInSession(db2, 'sess-1');
    expect(sess1).toHaveLength(3);
    expect(sess1.map(m => m.seq).sort()).toEqual([1, 2, 3]);
    db2.close();
  });
});
