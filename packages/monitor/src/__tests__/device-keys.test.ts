import { expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteDeviceKeys } from '../device-keys.js';

it('does not create a missing Head DB or migrate an incompatible schema', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kraki-monitor-keys-'));
  try {
    const path = join(root, 'head.db');
    expect(() => new SqliteDeviceKeys(path)).toThrow();
    expect(await readdir(root)).toEqual([]);
    const db = new DatabaseSync(path);
    try {
      expect(() => new SqliteDeviceKeys(path)).toThrow();
      expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()).toEqual([]);
    } finally { db.close(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});
