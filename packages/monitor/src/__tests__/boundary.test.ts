import { expect, it } from 'vitest';
import { readFile, readdir } from 'node:fs/promises';

it('has no runtime/workspace dependencies and no Head storage/collector coupling', async () => {
  const manifest = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'));
  expect(Object.keys(manifest.dependencies ?? {})).toEqual([]);
  expect(Object.keys(manifest.optionalDependencies ?? {})).toEqual([]);
  const src = new URL('../', import.meta.url);
  for (const name of await readdir(src)) {
    if (!name.endsWith('.ts')) continue;
    const text = await readFile(new URL(name, src), 'utf8');
    expect(text).not.toMatch(/from\s+['"](?:@kraki\/|[^'"]*\/head\/|\.\/storage\.)/);
  }
  const headCLI = await readFile(new URL('../../../head/src/cli.ts', import.meta.url), 'utf8');
  expect(headCLI).not.toContain('DiagApi');
  expect(headCLI).not.toContain('KRAKI_DIAG_DIR');
});
