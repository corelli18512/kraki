import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const installerPaths = [
  resolve(import.meta.dirname, '../../../../install.sh'),
  resolve(import.meta.dirname, '../../../arm/web/public/install.sh'),
];

for (const installerPath of installerPaths) {
  const installer = readFileSync(installerPath, 'utf8');

  describe(`daemon startup contract: ${installerPath}`, () => {
    it('delegates startup to the background-only CLI daemon manager', () => {
      expect(installer).toContain('"${INSTALL_DIR}/${BINARY_NAME}" start');
      expect(installer).not.toMatch(/\bnohup\b/);
      expect(installer).not.toMatch(/\bopen\s+-n\s+-a\b/);
      expect(installer).not.toContain('__daemon-worker');
    });
  });

  // docs/dogfood.md: testers opt into the dogfood channel or pin a release
  // tag; everyone else gets "latest", which GitHub never assigns to a prerelease.
  describe(`release selection: ${installerPath}`, () => {
    const functions = installer.replace(/\nmain\n*$/, '\n');
    const resolveVersion = (env: Record<string, string> = {}) => spawnSync('sh', ['-c', `${functions}\nfetch_latest_version\necho "VERSION=$VERSION"`], {
      encoding: 'utf8', env: { PATH: process.env.PATH, ...env },
    });

    it('installs a pinned release tag without asking for the latest', () => {
      const result = resolveVersion({ KRAKI_VERSION: 'v0.38.11' });
      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toBe('VERSION=v0.38.11');
    });

    it('installs the rolling dogfood-cli release on the dogfood channel', () => {
      const result = resolveVersion({ KRAKI_CHANNEL: 'dogfood' });
      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toBe('VERSION=dogfood-cli');
    });

    it('rejects an unknown channel and a channel combined with a pinned tag', () => {
      const unknown = resolveVersion({ KRAKI_CHANNEL: 'nightly' });
      expect(unknown.status).toBe(1);
      expect(unknown.stdout).toContain('Unknown KRAKI_CHANNEL');
      const both = resolveVersion({ KRAKI_CHANNEL: 'dogfood', KRAKI_VERSION: 'v0.38.11' });
      expect(both.status).toBe(1);
      expect(both.stdout).toContain('not both');
    });

    it('rejects a tag that could escape the download URL', () => {
      const result = resolveVersion({ KRAKI_VERSION: '../../evil' });
      expect(result.status).toBe(1);
      expect(result.stdout).toContain('Invalid KRAKI_VERSION');
    });

    it('defaults to the latest release and always verifies checksums of the chosen release', () => {
      expect(installer).toContain('releases/latest');
      expect(installer).toContain('releases/download/${VERSION}/SHA256SUMS.txt');
      expect(installer.indexOf('verify_checksum "$TMP"')).toBeGreaterThan(installer.indexOf('install() {'));
    });
  });
}
