import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const cliSource = readFileSync(resolve(here, '../cli.ts'), 'utf8');

describe('SEA daemon bootstrap contract', () => {
  it('captures and scrubs Launch Services state before importing daemon-worker adapters', () => {
    const prepareIndex = cliSource.indexOf('await prepareDaemonWorkerBootstrap()');
    const workerImportIndex = cliSource.indexOf("await import('./daemon-worker.js')");

    expect(prepareIndex).toBeGreaterThan(-1);
    expect(workerImportIndex).toBeGreaterThan(prepareIndex);
  });
});
