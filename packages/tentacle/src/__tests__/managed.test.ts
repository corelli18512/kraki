import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { clearManagedBy, isMacAppManagedWorker, loadManagedBy, saveManagedBy, getManagedByPath } from '../managed.js';

let home: string;
let prev: string | undefined;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'kraki-managed-'));
  prev = process.env.KRAKI_HOME;
  process.env.KRAKI_HOME = home;
});

afterEach(() => {
  if (prev === undefined) delete process.env.KRAKI_HOME; else process.env.KRAKI_HOME = prev;
  rmSync(home, { recursive: true, force: true });
});

describe('managed-by marker', () => {
  it('round-trips and is private to the user', () => {
    saveManagedBy({ by: 'kraki-mac', label: 'chat.kraki.mac.tentacle', appPath: '/Applications/Kraki.app' });
    expect(loadManagedBy()).toMatchObject({ by: 'kraki-mac', label: 'chat.kraki.mac.tentacle', appPath: '/Applications/Kraki.app' });
    expect(statSync(getManagedByPath()).mode & 0o777).toBe(0o600);
    clearManagedBy();
    expect(loadManagedBy()).toBeNull();
  });

  it('ignores malformed or foreign markers', () => {
    writeFileSync(getManagedByPath(), '{not json');
    expect(loadManagedBy()).toBeNull();
    writeFileSync(getManagedByPath(), JSON.stringify({ by: 'someone-else', label: 'x' }));
    expect(loadManagedBy()).toBeNull();
    writeFileSync(getManagedByPath(), JSON.stringify({ by: 'kraki-mac' }));
    expect(loadManagedBy()).toBeNull();
  });

  it('detects the Mac app worker only from its launchd environment', () => {
    expect(isMacAppManagedWorker({ KRAKI_MANAGED_BY: 'kraki-mac' })).toBe(true);
    expect(isMacAppManagedWorker({})).toBe(false);
  });
});
