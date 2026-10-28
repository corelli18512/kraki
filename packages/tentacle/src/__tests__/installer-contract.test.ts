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

  // docs/prerelease.md: testers pin a release tag; everyone else gets "latest",
  // which GitHub never assigns to a prerelease.
  describe(`release selection: ${installerPath}`, () => {
    const functions = installer.replace(/\nmain\n*$/, '\n');
    const resolveVersion = (version?: string) => spawnSync('sh', ['-c', `${functions}\nfetch_latest_version\necho "VERSION=$VERSION"`], {
      encoding: 'utf8', env: { PATH: process.env.PATH, ...(version === undefined ? {} : { KRAKI_VERSION: version }) },
    });

    it('installs a pinned release tag without asking for the latest', () => {
      const result = resolveVersion('dev-cli-0.38.12-dev.57');
      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toBe('VERSION=dev-cli-0.38.12-dev.57');
    });

    it('rejects a tag that could escape the download URL', () => {
      const result = resolveVersion('../../evil');
      expect(result.status).toBe(1);
      expect(result.stdout).toContain('Invalid KRAKI_VERSION');
    });

    it('defaults to the latest release and always verifies checksums', () => {
      expect(installer).toContain('releases/latest');
      expect(installer.indexOf('verify_checksum "$TMP"')).toBeGreaterThan(installer.indexOf('install() {'));
    });
  });
}
