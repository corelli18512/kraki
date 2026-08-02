/**
 * Unit tests for attachment assembly and cache integrity.
 */

import { Blob as NodeBlob } from 'node:buffer';
import 'fake-indexeddb/auto';
import type { ContentRef } from '@kraki/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  __resetForTests,
  getState,
  hydrateFromIDB,
  ingestChunk,
  markAwaitingPush,
  markFetching,
  subscribe,
} from './attachments';

const DB_NAME = 'kraki-attachments';
const STORE_NAME = 'attachments';
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function toBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

function arrayBufferOf(bytes: Uint8Array): ArrayBuffer {
  return Uint8Array.from(bytes).buffer;
}

async function contentId(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', arrayBufferOf(bytes));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('').slice(0, 32);
}

async function makeRef(bytes = PNG_BYTES, overrides: Partial<ContentRef> = {}): Promise<ContentRef> {
  return {
    type: 'content_ref',
    id: await contentId(bytes),
    mimeType: 'image/png',
    size: bytes.length,
    ...overrides,
  };
}

async function putStoredAttachment(ref: ContentRef, bytes: Uint8Array, mimeType = ref.mimeType): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' });
        store.createIndex('lastAccessed', 'lastAccessed');
      }
    };
    request.onerror = () => reject(new Error(`open attachment DB failed: ${request.error?.message ?? 'unknown'}`));
    request.onsuccess = () => {
      const db = request.result;
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const put = tx.objectStore(STORE_NAME).put({
        id: ref.id,
        mimeType,
        size: bytes.length,
        blob: new NodeBlob([Buffer.from(bytes)], { type: mimeType }) as unknown as Blob,
        lastAccessed: Date.now(),
      });
      put.onerror = () => reject(new Error(`put attachment failed: ${put.error?.message ?? 'unknown'}`));
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onabort = () => reject(new Error(`attachment transaction aborted: ${tx.error?.message ?? 'unknown'}`));
      tx.onerror = () => reject(new Error(`attachment transaction failed: ${tx.error?.message ?? 'unknown'}`));
    };
  });
}

async function getStoredAttachment(id: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      const tx = db.transaction(STORE_NAME, 'readonly');
      const get = tx.objectStore(STORE_NAME).get(id);
      get.onsuccess = () => {
        db.close();
        resolve(get.result);
      };
      get.onerror = () => reject(get.error);
    };
  });
}

describe('attachment state machine', () => {
  let pulls: ContentRef[];

  beforeEach(() => {
    pulls = [];
    __resetForTests();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('markAwaitingPush sets awaiting state', async () => {
    const ref = await makeRef();
    markAwaitingPush(ref, (requested) => pulls.push(requested));
    expect(getState(ref.id)?.kind).toBe('awaiting-chunks');
  });

  it('ingestChunk single chunk transitions to ready after size and hash validation', async () => {
    const ref = await makeRef();
    markAwaitingPush(ref, (requested) => pulls.push(requested));
    await ingestChunk(ref.id, 0, 1, ref.mimeType, toBase64(PNG_BYTES));
    const state = getState(ref.id);
    expect(state?.kind).toBe('ready');
    if (state?.kind === 'ready') {
      expect(state.mimeType).toBe('image/png');
      expect(state.blob.size).toBe(PNG_BYTES.length);
    }
  });

  it('reassembles multiple chunks regardless of arrival order', async () => {
    const ref = await makeRef();
    markAwaitingPush(ref, (requested) => pulls.push(requested));
    await ingestChunk(ref.id, 1, 2, ref.mimeType, toBase64(PNG_BYTES.slice(4)));
    expect(getState(ref.id)?.kind).toBe('awaiting-chunks');
    await ingestChunk(ref.id, 0, 2, ref.mimeType, toBase64(PNG_BYTES.slice(0, 4)));
    expect(getState(ref.id)?.kind).toBe('ready');
  });

  it('rejects a completed transfer with the wrong byte size', async () => {
    const ref = await makeRef(PNG_BYTES, { size: PNG_BYTES.length + 1 });
    markFetching(ref);
    const result = await ingestChunk(ref.id, 0, 1, ref.mimeType, toBase64(PNG_BYTES));
    expect(result).toBe('terminal-error');
    expect(getState(ref.id)).toEqual({
      kind: 'error',
      reason: `Attachment size mismatch: expected ${PNG_BYTES.length + 1}, got ${PNG_BYTES.length}`,
    });
  });

  it('rejects a completed transfer with a checksum mismatch', async () => {
    const ref = await makeRef(PNG_BYTES, { id: '0'.repeat(32) });
    markFetching(ref);
    const result = await ingestChunk(ref.id, 0, 1, ref.mimeType, toBase64(PNG_BYTES));
    expect(result).toBe('terminal-error');
    expect(getState(ref.id)).toEqual({ kind: 'error', reason: 'Attachment checksum mismatch' });
  });

  it('rejects invalid indexes, changed totals and MIME mismatches', async () => {
    const invalidIndexRef = await makeRef(PNG_BYTES, { id: '1'.repeat(32) });
    markFetching(invalidIndexRef);
    expect(await ingestChunk(invalidIndexRef.id, 2, 2, invalidIndexRef.mimeType, '')).toBe('terminal-error');

    const changedTotalRef = await makeRef(PNG_BYTES, { id: '2'.repeat(32) });
    markFetching(changedTotalRef);
    expect(await ingestChunk(changedTotalRef.id, 0, 2, changedTotalRef.mimeType, toBase64(PNG_BYTES.slice(0, 4)))).toBe('accepted');
    expect(await ingestChunk(changedTotalRef.id, 1, 3, changedTotalRef.mimeType, toBase64(PNG_BYTES.slice(4)))).toBe('terminal-error');

    const mimeRef = await makeRef(PNG_BYTES, { id: '3'.repeat(32) });
    markFetching(mimeRef);
    expect(await ingestChunk(mimeRef.id, 0, 1, 'text/plain', toBase64(PNG_BYTES))).toBe('terminal-error');
  });

  it('ingestChunk with an explicit error transitions to error state', async () => {
    const ref = await makeRef();
    markAwaitingPush(ref, (requested) => pulls.push(requested));
    await ingestChunk(ref.id, 0, 0, '', '', 'not_found');
    expect(getState(ref.id)).toEqual({ kind: 'error', reason: 'not_found' });
  });

  it('safety timeout fires fallback pull when no chunks arrive', async () => {
    vi.useFakeTimers();
    const ref = await makeRef();
    markAwaitingPush(ref, (requested) => pulls.push(requested));
    expect(pulls).toEqual([]);
    vi.advanceTimersByTime(10_001);
    expect(pulls).toEqual([ref]);
  });

  it('safety timeout does not fire if a valid chunk arrived first', async () => {
    vi.useFakeTimers();
    const ref = await makeRef();
    markAwaitingPush(ref, (requested) => pulls.push(requested));
    await ingestChunk(ref.id, 0, 2, ref.mimeType, toBase64(PNG_BYTES.slice(0, 4)));
    vi.advanceTimersByTime(15_000);
    expect(pulls).toEqual([]);
    expect(getState(ref.id)?.kind).toBe('awaiting-chunks');
  });

  it('markFetching grants pull ownership to only the first caller', async () => {
    const ref = await makeRef();
    expect(markFetching(ref)).toBe(true);
    expect(markFetching(ref)).toBe(false);
    expect(getState(ref.id)?.kind).toBe('fetching');
  });

  it('does not downgrade a ready attachment on a late error or timeout failure', async () => {
    const ref = await makeRef();
    markFetching(ref);
    await ingestChunk(ref.id, 0, 1, ref.mimeType, toBase64(PNG_BYTES));
    expect(getState(ref.id)?.kind).toBe('ready');

    expect(await ingestChunk(ref.id, 0, 0, '', '', 'not_found')).toBe('ignored');
    const { failAttachment } = await import('./attachments');
    failAttachment(ref, 'late timeout');
    expect(getState(ref.id)?.kind).toBe('ready');
  });

  it('subscribers are notified on state changes', async () => {
    const ref = await makeRef();
    const seen: string[] = [];
    const unsubscribe = subscribe(ref.id, () => seen.push(getState(ref.id)?.kind ?? '-'));
    markAwaitingPush(ref, () => {});
    await ingestChunk(ref.id, 0, 1, ref.mimeType, toBase64(PNG_BYTES));
    expect(seen).toContain('awaiting-chunks');
    expect(seen).toContain('ready');
    unsubscribe();
  });

  it('hydrates a valid IDB record only after integrity validation', async () => {
    const ref = await makeRef(PNG_BYTES, { id: await contentId(new Uint8Array([...PNG_BYTES, 1])) });
    const bytes = new Uint8Array([...PNG_BYTES, 1]);
    const validRef = { ...ref, size: bytes.length };
    await putStoredAttachment(validRef, bytes);

    expect(await hydrateFromIDB(validRef)).toBe(true);
    expect(getState(validRef.id)?.kind).toBe('ready');
  });

  it('deletes a corrupt IDB record and reports a cache miss so the caller re-pulls', async () => {
    const validBytes = new Uint8Array([...PNG_BYTES, 2]);
    const ref = await makeRef(validBytes);
    await putStoredAttachment(ref, PNG_BYTES);

    expect(await hydrateFromIDB(ref)).toBe(false);
    expect(getState(ref.id)).toBeUndefined();
    expect(await getStoredAttachment(ref.id)).toBeUndefined();
  });
});
