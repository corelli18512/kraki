import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { forgetDeletedAccount } from '../account-deleted.js';

describe('forgetDeletedAccount', () => {
  let home: string;
  const previous = process.env.KRAKI_HOME;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'kraki-deleted-'));
    process.env.KRAKI_HOME = home;
  });

  afterEach(() => {
    if (previous === undefined) delete process.env.KRAKI_HOME; else process.env.KRAKI_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  });

  it('removes sign-in and identity but keeps sessions', () => {
    for (const name of ['config.json', 'channel.key', 'github-token', 'device-id']) writeFileSync(join(home, name), 'x');
    mkdirSync(join(home, 'keys'));
    writeFileSync(join(home, 'keys', 'private.pem'), 'x');
    mkdirSync(join(home, 'sessions', 's1'), { recursive: true });
    writeFileSync(join(home, 'sessions', 's1', 'messages.jsonl'), '{}\n');

    forgetDeletedAccount();

    for (const name of ['config.json', 'channel.key', 'github-token', 'device-id', 'keys']) {
      expect(existsSync(join(home, name))).toBe(false);
    }
    expect(existsSync(join(home, 'sessions', 's1', 'messages.jsonl'))).toBe(true);
  });

  it('is fine when nothing is there', () => {
    expect(() => forgetDeletedAccount()).not.toThrow();
  });
});
