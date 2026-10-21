import { readFileSync } from 'node:fs';
import path from 'node:path';

export const APPLE_CATALOGS = ['Localizable.xcstrings', 'InfoPlist.xcstrings'];
/** Every non-source language in the app (also drives the checks). Keep in sync with AppLanguage.swift. */
export const APPLE_LANGUAGES = ['zh-Hans'];

/** Format specifiers in order-independent form (positional `%2$@` → `%@`). */
export function specifiers(s) {
  return (s.match(/%(\d+\$)?(lld|ld|llu|lu|d|u|@|lf|f|\.\d+f|\.\d+lf)/g) ?? []).map((x) => x.replace(/^%\d+\$/, '%')).sort().join();
}

function units(loc) {
  if (!loc) return [];
  if (loc.stringUnit) return [loc.stringUnit];
  const out = [];
  const walk = (o) => { if (o && typeof o === 'object') { if (o.stringUnit) out.push(o.stringUnit); else Object.values(o).forEach(walk); } };
  walk(loc.variations);
  return out;
}

/** Translations whose specifiers differ from the source (key or English value). */
export function applePlaceholderErrors(root) {
  const errors = [];
  for (const file of APPLE_CATALOGS) {
    const strings = JSON.parse(readFileSync(path.join(root, 'packages/arm/ios/Kraki/Resources/Localization', file), 'utf8')).strings;
    for (const [key, entry] of Object.entries(strings)) {
      if (file.startsWith('InfoPlist')) continue; // keys are Info.plist names
      const en = units(entry.localizations?.en).map((u) => u.value);
      const sources = en.length ? en : [key];
      for (const lang of APPLE_LANGUAGES) {
        for (const u of units(entry.localizations?.[lang])) {
          // Plural forms may drop the count (zh "other" vs en "one"), so accept any source form's set.
          if (!sources.some((src) => specifiers(src) === specifiers(u.value))) errors.push(`apple ${lang}: specifiers differ in ${JSON.stringify(key)} → ${JSON.stringify(u.value)}`);
        }
      }
    }
  }
  return errors;
}

/** Keys with nothing to translate (pure punctuation/format specifiers). */
export function isTrivialKey(key) {
  return !/\p{L}/u.test(key.replace(/%(\d+\$)?(lld|ld|d|@|f|\.\d+f|u|lu|llu)/g, ''));
}

function hasTranslation(entry, lang) {
  // Plural/device variations: every case must be translated.
  const list = units(entry.localizations?.[lang]);
  return list.length > 0 && list.every((u) => u.state === 'translated' && u.value.trim() !== '');
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
