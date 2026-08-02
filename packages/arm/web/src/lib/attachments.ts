/**
 * Web-side attachment cache and chunk reassembly.
 *
 * One state machine per attachment id:
 *
 *   awaiting-chunks  ← live message router calls markAwaitingPush() when a
 *                       fresh tool_complete with an ContentRef arrives;
 *                       chunks are inbound via attachment_data messages.
 *   fetching         ← useAttachment triggered a pull (replay path or
 *                       safety-timeout fallback).
 *   ready            ← bytes assembled, blob URL available.
 *   error            ← all chunks errored or the safety fetch failed.
 *
 * Storage:
 *   - IndexedDB store `attachments` keyed by id (sha256 hex). Holds Blob.
 *   - In-memory pending-chunks map for in-flight assembly.
 *   - In-memory state map mirrors the four kinds above plus a subscriber
 *     set so React hooks can re-render when an id transitions.
 *
 * Object URLs are created by useAttachment, not here — this module deals
 * only in Blobs, so we don't leak URLs across hook unmounts.
 */

import type { ContentRef } from '@kraki/protocol';
import { openDB, type IDBPDatabase } from 'idb';

import { createLogger } from './logger';

const logger = createLogger('attachments');

const DB_NAME = 'kraki-attachments';
const DB_VERSION = 1;
const STORE_NAME = 'attachments';

interface StoredAttachment {
  id: string;
  mimeType: string;
  size: number;
  blob: Blob;
  lastAccessed: number;
}

let dbPromise: Promise<IDBPDatabase> | null = null;
function getDB(): Promise<IDBPDatabase> {
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' });
          store.createIndex('lastAccessed', 'lastAccessed');
        }
      },
    });
  }
  return dbPromise;
}

// ── Cap derivation (cheap, runs once per call site) ──────────────────────

const TARGET_CAP_BYTES = 200 * 1024 * 1024;
const MIN_CAP_BYTES = 50 * 1024 * 1024;
const QUOTA_SAFETY = 0.5;

export async function effectiveCapBytes(): Promise<number> {
  if (typeof navigator !== 'undefined' && navigator.storage?.estimate) {
    try {
      const est = await navigator.storage.estimate();
      if (est.quota) {
        return Math.max(MIN_CAP_BYTES, Math.min(TARGET_CAP_BYTES, est.quota * QUOTA_SAFETY));
      }
    } catch {
      /* ignore */
    }
  }
  return MIN_CAP_BYTES;
}

// ── State machine ───────────────────────────────────────────────────────

export type AttachmentState =
  | { kind: 'awaiting-chunks'; received: Map<number, string>; total: number | null; mimeType: string | null; startedAt: number }
  | { kind: 'fetching' }
  | { kind: 'ready'; mimeType: string; blob: Blob }
  | { kind: 'error'; reason: string };

export type AttachmentChunkIngestResult = 'accepted' | 'ignored' | 'terminal-error';

const states = new Map<string, AttachmentState>();
const expectedRefs = new Map<string, ContentRef>();
const subscribers = new Map<string, Set<() => void>>();
const PUSH_TIMEOUT_MS = 10_000;
const pushTimeouts = new Map<string, ReturnType<typeof setTimeout>>();

function notify(id: string): void {
  const subs = subscribers.get(id);
  if (!subs) return;
  for (const fn of subs) fn();
}

export function subscribe(id: string, fn: () => void): () => void {
  let set = subscribers.get(id);
  if (!set) {
    set = new Set();
    subscribers.set(id, set);
  }
  set.add(fn);
  return () => {
    const cur = subscribers.get(id);
    if (!cur) return;
    cur.delete(fn);
    if (cur.size === 0) subscribers.delete(id);
  };
}

export function getState(id: string): AttachmentState | undefined {
  return states.get(id);
}

/** Called by the message router for every ContentRef in a LIVE message. */
export function markAwaitingPush(ref: ContentRef, requestPull: (ref: ContentRef) => void): void {
  expectedRefs.set(ref.id, ref);
  // No-op if we already have it or are mid-fetch
  const current = states.get(ref.id);
  if (current && (current.kind === 'ready' || current.kind === 'awaiting-chunks' || current.kind === 'fetching')) {
    return;
  }
  states.set(ref.id, {
    kind: 'awaiting-chunks',
    received: new Map(),
    total: null,
    mimeType: null,
    startedAt: Date.now(),
  });
  notify(ref.id);
  // Safety timeout — if no chunk arrives in PUSH_TIMEOUT_MS, fall back to
  // an explicit attachment_request. Cleared when first chunk arrives or
  // when assembly completes.
  if (pushTimeouts.has(ref.id)) {
    clearTimeout(pushTimeouts.get(ref.id)!);
  }
  pushTimeouts.set(
    ref.id,
    setTimeout(() => {
      const s = states.get(ref.id);
      if (s?.kind === 'awaiting-chunks' && s.received.size === 0) {
        logger.warn('push timeout — falling back to fetch', { id: ref.id });
        requestPull(ref);
      }
    }, PUSH_TIMEOUT_MS),
  );
}

/** Called by the message router on every `attachment_data` chunk arrival. */
export async function ingestChunk(
  id: string,
  index: number,
  total: number,
  mimeType: string,
  data: string,
  error?: string,
): Promise<AttachmentChunkIngestResult> {
  const existing = states.get(id);
  if (existing?.kind === 'ready' || existing?.kind === 'error') return 'ignored';
  if (error) {
    setAttachmentError(id, error);
    return 'terminal-error';
  }

  const ref = expectedRefs.get(id);
  if (!ref) {
    setAttachmentError(id, 'Attachment metadata unavailable');
    return 'terminal-error';
  }
  if (!Number.isInteger(index) || !Number.isInteger(total) || total <= 0 || index < 0 || index >= total) {
    setAttachmentError(id, 'Invalid attachment chunk index');
    return 'terminal-error';
  }
  if (mimeType !== ref.mimeType) {
    setAttachmentError(id, `Attachment MIME type mismatch: expected ${ref.mimeType}, got ${mimeType || 'empty'}`);
    return 'terminal-error';
  }

  let current = existing;
  if (!current || (current.kind !== 'awaiting-chunks' && current.kind !== 'fetching')) {
    // No active assembly exists. Initialize one defensively for a stray chunk.
    current = {
      kind: 'awaiting-chunks',
      received: new Map(),
      total: null,
      mimeType: null,
      startedAt: Date.now(),
    };
    states.set(id, current);
  } else if (current.kind === 'fetching') {
    // Chunk arrived during/after a pull request; convert to assembly state
    current = {
      kind: 'awaiting-chunks',
      received: new Map(),
      total: null,
      mimeType: null,
      startedAt: Date.now(),
    };
    states.set(id, current);
  }

  if (current.total !== null && current.total !== total) {
    setAttachmentError(id, `Attachment chunk count changed from ${current.total} to ${total}`);
    return 'terminal-error';
  }
  if (current.mimeType !== null && current.mimeType !== mimeType) {
    setAttachmentError(id, 'Attachment MIME type changed during transfer');
    return 'terminal-error';
  }
  if (current.received.has(index)) return 'accepted';
  let decodedLength: number;
  try {
    decodedLength = base64Length(data);
    if (decodedLength < 0) throw new Error('negative decoded length');
  } catch {
    setAttachmentError(id, 'Attachment chunk is not valid base64');
    return 'terminal-error';
  }
  let receivedBytes = decodedLength;
  for (const chunk of current.received.values()) receivedBytes += base64Length(chunk);
  if (receivedBytes > ref.size) {
    setAttachmentError(id, `Attachment exceeds declared size ${ref.size}`);
    return 'terminal-error';
  }
  current.received.set(index, data);
  current.total = total;
  current.mimeType = mimeType;
  if (current.received.size === total) {
    // Complete — require every expected index, then assemble and verify the
    // content-addressed ref before exposing or persisting the blob.
    const chunks: string[] = [];
    for (let i = 0; i < total; i++) {
      const chunk = current.received.get(i);
      if (chunk === undefined) {
        setAttachmentError(id, `Attachment is missing chunk ${i}`);
        return 'terminal-error';
      }
      chunks.push(chunk);
    }
    try {
      const buf = new Uint8Array(chunks.reduce((acc, b64) => acc + base64Length(b64), 0));
      let offset = 0;
      for (const b64 of chunks) {
        const bytes = base64ToBytes(b64);
        buf.set(bytes, offset);
        offset += bytes.length;
      }
      const blob = new Blob([buf], { type: mimeType });
      const validationError = await validateBlob(ref, mimeType, blob);
      if (validationError) {
        void deleteFromIDB(id);
        setAttachmentError(id, validationError);
        return 'terminal-error';
      }
      states.set(id, { kind: 'ready', mimeType, blob });
      clearPushTimeout(id);
      void persistToIDB({ id, mimeType, size: blob.size, blob, lastAccessed: Date.now() });
      notify(id);
    } catch (err) {
      setAttachmentError(id, `Attachment decode failed: ${(err as Error).message}`);
      return 'terminal-error';
    }
  } else {
    notify(id);
  }
  return 'accepted';
}

function clearPushTimeout(id: string): void {
  const t = pushTimeouts.get(id);
  if (t) {
    clearTimeout(t);
    pushTimeouts.delete(id);
  }
}

function setAttachmentError(id: string, reason: string): void {
  states.set(id, { kind: 'error', reason });
  clearPushTimeout(id);
  logger.warn('attachment rejected', { id, reason });
  notify(id);
}

export function failAttachment(ref: ContentRef, reason: string): void {
  expectedRefs.set(ref.id, ref);
  if (states.get(ref.id)?.kind === 'ready') return;
  setAttachmentError(ref.id, reason);
}

async function validateBlob(ref: ContentRef, mimeType: string, blob: Blob): Promise<string | null> {
  if (!/^[0-9a-f]{32}$/i.test(ref.id)) {
    return 'Attachment id is not a valid content hash';
  }
  if (mimeType !== ref.mimeType) {
    return `Attachment MIME type mismatch: expected ${ref.mimeType}, got ${mimeType || 'empty'}`;
  }
  if (blob.size !== ref.size) {
    return `Attachment size mismatch: expected ${ref.size}, got ${blob.size}`;
  }
  const bytes = await blobToArrayBuffer(blob);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
  if (!hex.startsWith(ref.id.toLowerCase())) {
    return 'Attachment checksum mismatch';
  }
  return null;
}

function blobToArrayBuffer(blob: Blob): Promise<ArrayBuffer> {
  const modernBlob = blob as Blob & { arrayBuffer?: () => Promise<ArrayBuffer> };
  if (typeof modernBlob.arrayBuffer === 'function') return modernBlob.arrayBuffer();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read attachment blob'));
    reader.onload = () => {
      if (reader.result instanceof ArrayBuffer) resolve(reader.result);
      else reject(new Error('Attachment blob did not produce bytes'));
    };
    reader.readAsArrayBuffer(blob);
  });
}

/** Called by useAttachment to acquire ownership of a pull. */
export function markFetching(ref: ContentRef): boolean {
  expectedRefs.set(ref.id, ref);
  const current = states.get(ref.id);
  if (current?.kind === 'ready' || current?.kind === 'awaiting-chunks' || current?.kind === 'fetching') {
    return false;
  }
  states.set(ref.id, { kind: 'fetching' });
  notify(ref.id);
  return true;
}

/** Try to hydrate state from IDB. Returns true if a verified record exists. */
export async function hydrateFromIDB(ref: ContentRef): Promise<boolean> {
  expectedRefs.set(ref.id, ref);
  try {
    const db = await getDB();
    const got = (await db.get(STORE_NAME, ref.id)) as StoredAttachment | undefined;
    if (!got) return false;
    const validationError = await validateBlob(ref, got.mimeType, got.blob);
    if (validationError) {
      await db.delete(STORE_NAME, ref.id);
      logger.warn('discarded invalid attachment cache entry', { id: ref.id, reason: validationError });
      return false;
    }
    states.set(ref.id, { kind: 'ready', mimeType: got.mimeType, blob: got.blob });
    // Update lastAccessed in the background; ignore errors
    void db.put(STORE_NAME, { ...got, size: got.blob.size, lastAccessed: Date.now() });
    notify(ref.id);
    return true;
  } catch (err) {
    await deleteFromIDB(ref.id);
    logger.warn('failed to hydrate attachment from IDB', { id: ref.id, error: (err as Error).message });
    return false;
  }
}

async function deleteFromIDB(id: string): Promise<void> {
  try {
    const db = await getDB();
    await db.delete(STORE_NAME, id);
  } catch {
    // Best effort. A failed delete must not make corrupt bytes visible.
  }
}

async function persistToIDB(record: StoredAttachment): Promise<void> {
  try {
    const db = await getDB();
    await db.put(STORE_NAME, record);
    void evictIfOverCap();
  } catch (err) {
    logger.warn('failed to persist attachment to IDB', { id: record.id, error: (err as Error).message });
    if ((err as Error).name === 'QuotaExceededError') {
      // Halve the in-IDB store as a recovery; LRU by lastAccessed
      void evictIfOverCap(true);
    }
  }
}

let evictionInFlight = false;
async function evictIfOverCap(aggressive = false): Promise<void> {
  if (evictionInFlight) return;
  evictionInFlight = true;
  try {
    const cap = await effectiveCapBytes();
    const target = aggressive ? cap / 2 : cap;
    const db = await getDB();
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const idx = tx.store.index('lastAccessed');
    // Tally total size first
    let total = 0;
    const all: StoredAttachment[] = [];
    let cursor = await idx.openCursor();
    while (cursor) {
      const rec = cursor.value as StoredAttachment;
      total += rec.size;
      all.push(rec);
      cursor = await cursor.continue();
    }
    if (total <= target) {
      await tx.done;
      return;
    }
    // all is sorted by lastAccessed ascending — delete oldest until under cap
    let i = 0;
    while (total > target && i < all.length) {
      await tx.store.delete(all[i].id);
      total -= all[i].size;
      i++;
    }
    await tx.done;
    logger.info('attachment cache eviction', { deleted: i, target, finalTotal: total });
  } finally {
    evictionInFlight = false;
  }
}

// ── base64 helpers ─────────────────────────────────────────────────────

function base64Length(b64: string): number {
  if (
    b64.length % 4 !== 0
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(b64)
  ) {
    throw new Error('invalid base64');
  }
  let pad = 0;
  if (b64.endsWith('==')) pad = 2;
  else if (b64.endsWith('=')) pad = 1;
  return Math.floor((b64.length * 3) / 4) - pad;
}

function base64ToBytes(b64: string): Uint8Array {
  if (typeof atob === 'function') {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  // Node fallback (tests)
  return new Uint8Array(Buffer.from(b64, 'base64'));
}

// ── Testing escape hatch ───────────────────────────────────────────────

/** Reset state. Tests only. */
export function __resetForTests(): void {
  states.clear();
  expectedRefs.clear();
  subscribers.clear();
  for (const t of pushTimeouts.values()) clearTimeout(t);
  pushTimeouts.clear();
}
