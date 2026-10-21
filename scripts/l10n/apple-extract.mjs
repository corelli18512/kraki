#!/usr/bin/env node
// Sync the iOS/Mac String Catalogs with the code.
//
// Xcode (the IDE) updates Localizable.xcstrings on build; xcodebuild does
// not. `xcodebuild -exportLocalizations` does sync the catalogs in place
// (new keys added, removed keys marked stale, translations kept, Xcode's own
// formatting), so run it for both app schemes and report what is left.
// Usage: pnpm l10n:extract:apple
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { appleCatalogStats } from './catalog.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ios = path.join(root, 'packages/arm/ios');
const work = mkdtempSync(path.join(tmpdir(), 'kraki-l10n-'));
try {
  for (const scheme of ['Kraki', 'KrakiMac']) {
    console.log(`exporting ${scheme}…`);
    execFileSync('xcodebuild', ['-exportLocalizations', '-project', path.join(ios, 'Kraki.xcodeproj'), '-scheme', scheme,
      '-localizationPath', path.join(work, scheme), '-exportLanguage', 'zh-Hans', '-derivedDataPath', path.join(work, 'dd'),
      'CODE_SIGNING_ALLOWED=NO'], { stdio: ['ignore', 'ignore', 'inherit'] });
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
for (const s of appleCatalogStats(root)) {
  console.log(`${s.file}: ${s.total} keys, ${s.translated} translated, ${s.untranslated.length} untranslated, ${s.stale} stale`);
}
