import 'fake-indexeddb/auto';
import { Blob as NodeBlob } from 'node:buffer';
import type { ContentRef } from '@kraki/protocol';
import { openDB } from 'idb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { i18next } from '../../i18n';
import { __resetForTests, getState, hydrateFromIDB, ingestChunk, markFetching } from '../../lib/attachments';

const { warn } = vi.hoisted(() => ({ warn: vi.fn() }));
vi.mock('../../lib/logger', () => ({ createLogger: () => ({ warn, info: vi.fn() }) }));

const ref: ContentRef = { type: 'content_ref', id: 'a'.repeat(32), mimeType: 'image/png', size: 2 };

beforeEach(async () => {
  __resetForTests();
  warn.mockClear();
  await i18next.changeLanguage('zh-Hans');
});
afterEach(async () => {
  __resetForTests();
  await i18next.changeLanguage('en');
});

describe('attachment diagnostics', () => {
  it('logs a stable code while keeping the localized rejection visible', async () => {
    markFetching(ref);
    await ingestChunk(ref.id, -1, 1, ref.mimeType, '');
    expect(getState(ref.id)).toEqual({ kind: 'error', reason: '无效的附件分块索引' });
    expect(warn).toHaveBeenCalledWith('attachment rejected', { id: ref.id, reason: 'invalidIndex' });
  });

  it('logs a stable code when discarding an invalid cached attachment', async () => {
    const db = await openDB('kraki-attachments', 1, {
      upgrade(database) {
        const store = database.createObjectStore('attachments', { keyPath: 'id' });
        store.createIndex('lastAccessed', 'lastAccessed');
      },
    });
    await db.put('attachments', {
      id: ref.id, mimeType: ref.mimeType, size: 1, lastAccessed: 0,
      blob: new NodeBlob([new Uint8Array([1])], { type: ref.mimeType }),
    });
    expect(await hydrateFromIDB(ref)).toBe(false);
    expect(warn).toHaveBeenCalledWith('discarded invalid attachment cache entry', { id: ref.id, reason: 'sizeMismatch' });
    expect(await db.get('attachments', ref.id)).toBeUndefined();
    db.close();
  });
});
