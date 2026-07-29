import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const buildScript = readFileSync(resolve(here, '../../scripts/build-local-binary.mjs'), 'utf8');

describe('SEA daemon bootstrap contract', () => {
  it('scrubs the Launch Services bundle variable in the esbuild banner before modules initialize', () => {
    expect(buildScript).toContain('process.argv[2] === "__daemon-worker"');
    expect(buildScript).toContain('delete process.env.__CFBundleIdentifier');

    const bannerIndex = buildScript.indexOf('delete process.env.__CFBundleIdentifier');
    const importMetaIndex = buildScript.indexOf('const __kraki_import_meta_url');
    expect(bannerIndex).toBeGreaterThan(-1);
    expect(importMetaIndex).toBeGreaterThan(bannerIndex);
  });
});
