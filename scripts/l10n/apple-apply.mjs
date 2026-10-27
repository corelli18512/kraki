#!/usr/bin/env node
// Apply Simplified Chinese translations from scripts/l10n/zh-Hans/*.json to
// the iOS/Mac String Catalog Localizable.xcstrings (not InfoPlist.xcstrings).
//
// Each JSON file: {
//   "translations": { "<catalog key>": "<zh-Hans>", ... },
//   "englishPlurals": { "<catalog key>": { "one": "...", "other": "..." } }   // optional
// }
// Catalog keys are what Xcode extracts: Text("\(n) sessions") → "%lld sessions",
// Text("Hi \(name)") → "Hi %@". Run `pnpm l10n:extract:apple` first so new
// keys exist.
//   node scripts/l10n/apple-apply.mjs            apply all files
//   node scripts/l10n/apple-apply.mjs --check f  report keys in f missing from the catalog
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatXcstrings, specifiers } from './catalog.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const catalogFile = path.join(root, 'packages/arm/ios/Kraki/Resources/Localization/Localizable.xcstrings');
const argv = process.argv.slice(2);
const check = argv.includes('--check');
const files = argv.filter((a) => !a.startsWith('--'));
const sources = files.length ? files.map((f) => path.resolve(f)) : readdirSync(path.join(here, 'zh-Hans')).filter((f) => f.endsWith('.json')).map((f) => path.join(here, 'zh-Hans', f));

const catalog = JSON.parse(readFileSync(catalogFile, 'utf8'));
let applied = 0;
const missing = [];
const mismatched = [];
for (const file of sources) {
  const data = JSON.parse(readFileSync(file, 'utf8'));
  for (const [key, zh] of Object.entries(data.translations ?? {})) {
    const entry = catalog.strings[key];
    if (!entry) { missing.push(`${path.basename(file)}: ${key}`); continue; }
    if (specifiers(key) !== specifiers(zh)) { mismatched.push(`${path.basename(file)}: ${key} → ${zh}`); continue; }
    if (check) continue;
    entry.localizations ??= {};
    entry.localizations['zh-Hans'] = { stringUnit: { state: 'translated', value: zh } };
    applied++;
  }
  for (const [key, forms] of Object.entries(data.englishPlurals ?? {})) {
    const entry = catalog.strings[key];
    if (!entry) { missing.push(`${path.basename(file)} (plural): ${key}`); continue; }
    if (check) continue;
    entry.localizations ??= {};
    entry.localizations.en = { variations: { plural: Object.fromEntries(Object.entries(forms).map(([k, v]) => [k, { stringUnit: { state: 'translated', value: v } }])) } };
  }
}
if (!check) writeFileSync(catalogFile, formatXcstrings(catalog));
console.log(`${check ? 'checked' : 'applied'} ${applied || ''} translations from ${sources.length} file(s)`);
if (missing.length) console.log(`\n${missing.length} key(s) not in the catalog (wrong key form, or run pnpm l10n:extract:apple):\n  ${missing.join('\n  ')}`);
if (mismatched.length) console.log(`\n${mismatched.length} format specifier mismatch(es):\n  ${mismatched.join('\n  ')}`);
if (missing.length || mismatched.length) process.exitCode = 1;
