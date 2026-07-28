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
}
