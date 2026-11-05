/** K-315 (AGT-116): `kraki agents`/setup spinners redrew forever on a pty
 *  that reports zero columns (ora computes Infinity lines to clear). */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Writable } from 'node:stream';
import { ora } from '../spinner.js';

function tty(columns: number): NodeJS.WriteStream & { output: () => string } {
  let out = '';
  const s = new Writable({ write(chunk, _enc, cb) { out += String(chunk); cb(); } }) as unknown as NodeJS.WriteStream & { output: () => string };
  Object.assign(s, {
    isTTY: true, columns, rows: 0,
    cursorTo: () => true, moveCursor: () => true, clearLine: () => true,
    output: () => out,
  });
  return s;
}

describe('ora (zero-width safe)', () => {
  // ora also turns itself off when CI is set or TERM=dumb (is-interactive);
  // these tests are about the wrapper, so they must not depend on the runner.
  beforeEach(() => {
    vi.stubEnv('CI', undefined);
    vi.stubEnv('TERM', 'xterm-256color');
  });
  afterEach(() => { vi.unstubAllEnvs(); });

  it('is disabled on a zero-column terminal and prints its lines once', () => {
    const stream = tty(0);
    const s = ora({ text: 'Checking the coding agents…', stream });
    // Never start an enabled spinner here: on a zero-width stream ora would
    // loop forever inside this test process.
    expect(s.isEnabled).toBe(false);
    s.start();
    s.succeed('done');
    expect(stream.output()).toContain('done');
    expect(stream.output().length).toBeLessThan(500);
  });

  it('stays enabled on a normal terminal', () => {
    const s = ora({ text: 'x', stream: tty(80) });
    expect(s.isEnabled).toBe(true);
  });
});
