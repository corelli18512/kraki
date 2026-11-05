/**
 * cli/lifecycle.ts against a real (isolated) Kraki home.
 */
import { describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describeKrakiData } from '../cli/lifecycle.js';

describe('describeKrakiData (delete-data confirmation)', () => {
  it('K-271: counts only real sessions, not stray files or folders in sessions/', () => {
    const sessions = join(process.env.KRAKI_HOME!, 'sessions');
    for (const id of ['sess_aaa111', 'sess_bbb222']) {
      mkdirSync(join(sessions, id), { recursive: true });
      writeFileSync(join(sessions, id, 'meta.json'), '{}');
    }
    writeFileSync(join(sessions, '.DS_Store'), 'x');
    mkdirSync(join(sessions, 'sess copy'), { recursive: true });
    mkdirSync(join(sessions, 'sess_nometa'), { recursive: true });
    writeFileSync(join(sessions, 'input-ledger.tmp'), 'x');

    expect(describeKrakiData().sessions).toBe(2);
  });
});
