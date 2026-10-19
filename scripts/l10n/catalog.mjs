import { readFileSync } from 'node:fs';
import path from 'node:path';

export const APPLE_CATALOGS = ['Localizable.xcstrings', 'InfoPlist.xcstrings'];
export const APPLE_LANGUAGES = ['zh-Hans'];

/** Keys with nothing to translate (pure punctuation/format specifiers). */
export function isTrivialKey(key) {
  return !/\p{L}/u.test(key.replace(/%(\d+\$)?(lld|ld|d|@|f|\.\d+f|u|lu|llu)/g, ''));
}

function hasTranslation(entry, lang) {
  const loc = entry.localizations?.[lang];
  if (!loc) return false;
  if (loc.stringUnit) return loc.stringUnit.state === 'translated' && loc.stringUnit.value.trim() !== '';
  // Plural/device variations: every case must be translated.
  const units = [];
  const walk = (o) => { if (o && typeof o === 'object') { if (o.stringUnit) units.push(o.stringUnit); else Object.values(o).forEach(walk); } };
  walk(loc.variations);
  return units.length > 0 && units.every((u) => u.state === 'translated' && u.value.trim() !== '');
}

export function appleCatalogStats(root, lang = 'zh-Hans') {
  return APPLE_CATALOGS.map((file) => {
    const strings = JSON.parse(readFileSync(path.join(root, 'packages/arm/ios/Kraki/Resources/Localization', file), 'utf8')).strings;
    const live = Object.entries(strings).filter(([k, v]) => v.extractionState !== 'stale' && v.shouldTranslate !== false && !isTrivialKey(k));
    const untranslated = live.filter(([, v]) => !hasTranslation(v, lang)).map(([k]) => k);
    return { file, total: live.length, translated: live.length - untranslated.length, untranslated,
      stale: Object.values(strings).filter((v) => v.extractionState === 'stale').length };
  });
}

/** Serialize like Xcode does (`"key" : value`, 2-space indent) to avoid churn. */
export function formatXcstrings(catalog) {
  return JSON.stringify(catalog, null, 2).replace(/^(\s*"(?:[^"\\]|\\.)*"): /gm, '$1 : ') + '\n';
}
