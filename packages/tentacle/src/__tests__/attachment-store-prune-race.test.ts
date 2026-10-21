/**
 * Release review: the asynchronous tool-payload prune must not delete an
 * attachment that put() (re)wrote or handed out while the prune was awaiting
 * the filesystem. Each test pauses the prune at one await and runs put() of
 * identical content there.
 */
import { mkdtempSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const hooks = vi.hoisted(() => ({
  afterReadFile: undefined as ((path: string) => void) | undefined,
  afterUnlink: undefined as ((path: string) => void) | undefined,
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...real,
    readFile: async (...args: Parameters<typeof real.readFile>) => {
      const result = await real.readFile(...args);
      hooks.afterReadFile?.(String(args[0]));
      return result;
    },
    unlink: async (path: Parameters<typeof real.unlink>[0]) => {
      await real.unlink(path);
      hooks.afterUnlink?.(String(path));
    },
  };
});

const { AttachmentStore } = await import('../attachment-store.js');

afterEach(() => {
  hooks.afterReadFile = undefined;
  hooks.afterUnlink = undefined;
});

const PAYLOAD = Buffer.from('{"command":"ls"}');
const DAY = 86_400_000;

function oldPayload() {
  const root = mkdtempSync(join(tmpdir(), 'kraki-prune-race-'));
  const store = new AttachmentStore(root);
  const ref = store.put('s1', PAYLOAD, 'application/json', { name: 'bash.args.json' });
  const old = new Date(Date.now() - 20 * DAY);
  utimesSync(join(root, 's1', 'attachments', `${ref.id}.json`), old, old);
  return { store, ref };
}

describe('pruneToolPayloads vs a concurrent put() of identical content', () => {
  it('keeps the attachment put() recreated between deleting the data file and its sidecar', async () => {
    const { store, ref } = oldPayload();
    let again: ReturnType<typeof store.put> | undefined;
    hooks.afterUnlink = (path) => {
      if (again || path.endsWith('.json')) return;
      again = store.put('s1', PAYLOAD, 'application/json', { name: 'bash.args.json' });
    };
    const removed = await store.pruneToolPayloads(14 * DAY);
    // Either the pair is deleted without yielding (no put() could run between
    // the two deletions, and the payload is gone), or the ref put() returned
    // must still be readable.
    if (again) {
      expect(again.id).toBe(ref.id);
      expect(store.read('s1', ref.id)?.bytes.equals(PAYLOAD)).toBe(true);
    } else {
      expect(removed).toBe(1);
      expect(store.has('s1', ref.id)).toBe(false);
    }
  });

  it('keeps the attachment put() handed out after the prune read its old sidecar', async () => {
    const { store, ref } = oldPayload();
    let again: ReturnType<typeof store.put> | undefined;
    hooks.afterReadFile = () => {
      if (again) return;
      again = store.put('s1', PAYLOAD, 'application/json', { name: 'bash.args.json' });
    };
    expect(await store.pruneToolPayloads(14 * DAY)).toBe(0);
    expect(again?.id).toBe(ref.id);
    expect(store.read('s1', ref.id)?.bytes.equals(PAYLOAD)).toBe(true);
  });

  it('still prunes the payload when nothing put it meanwhile', async () => {
    const { store, ref } = oldPayload();
    expect(await store.pruneToolPayloads(14 * DAY)).toBe(1);
    expect(store.has('s1', ref.id)).toBe(false);
  });
});
