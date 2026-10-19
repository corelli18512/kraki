#!/usr/bin/env node
// Localization checks for every GUI client (Web, Windows shell, iOS/Mac).
//
//   pnpm l10n:check            CI: hard errors + ratchet against baseline.json
//   pnpm l10n:check --update   lower the baseline after migrating strings
//   pnpm l10n:check --strict   release gate: nothing untranslated/hard-coded
//
// Hard errors (always): a locale missing English keys, extra keys, changed
// placeholders, empty values. Ratchet (counts may only go down): untranslated
// Apple catalog keys and heuristically detected hard-coded UI English in
// Web .tsx / Swift sources. Hidden diagnostics/debug surfaces are excluded.
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { appleCatalogStats } from './catalog.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const baselineFile = path.join(path.dirname(fileURLToPath(import.meta.url)), 'baseline.json');
const args = new Set(process.argv.slice(2));
const errors = [];
const counts = {};
const details = {};

// ── Web locales ──
const webLocales = path.join(root, 'packages/arm/web/src/i18n/locales');
const flatten = (o, p = '') => Object.entries(o).flatMap(([k, v]) => (typeof v === 'string' ? [[p + k, v]] : flatten(v, `${p}${k}.`)));
const baseKey = (k) => k.replace(/_(zero|one|two|few|many|other)$/, '');
const vars = (s, re) => [...s.matchAll(re)].map((m) => m[1]).sort().join();
function readLocale(code) {
  const out = {};
  for (const f of readdirSync(path.join(webLocales, code)).filter((f) => f.endsWith('.json'))) {
    for (const [k, v] of flatten(JSON.parse(readFileSync(path.join(webLocales, code, f), 'utf8')))) out[`${f.slice(0, -5)}:${k}`] = v;
  }
  return out;
}
const webEn = readLocale('en');
for (const code of readdirSync(webLocales).filter((d) => d !== 'en' && statSync(path.join(webLocales, d)).isDirectory())) {
  const loc = readLocale(code);
  const enBases = new Set(Object.keys(webEn).map(baseKey));
  const locBases = new Set(Object.keys(loc).map(baseKey));
  for (const k of enBases) if (!locBases.has(k)) errors.push(`web ${code}: missing ${k}`);
  for (const k of locBases) if (!enBases.has(k)) errors.push(`web ${code}: extra ${k}`);
  for (const [k, v] of Object.entries(loc)) {
    if (!v.trim()) errors.push(`web ${code}: empty ${k}`);
    const en = webEn[k] ?? webEn[`${baseKey(k)}_other`];
    if (en !== undefined && vars(en, /\{\{\s*([\w.]+)[^}]*\}\}/g) !== vars(v, /\{\{\s*([\w.]+)[^}]*\}\}/g)) errors.push(`web ${code}: placeholders differ in ${k}`);
  }
}

// ── Windows shell ──
const { DICTIONARIES } = createRequire(import.meta.url)(path.join(root, 'packages/desktop/src/i18n.cjs'));
for (const [code, dict] of Object.entries(DICTIONARIES)) {
  for (const k of Object.keys(DICTIONARIES.en)) {
    if (!(k in dict)) errors.push(`desktop ${code}: missing ${k}`);
    else if (!dict[k].trim()) errors.push(`desktop ${code}: empty ${k}`);
    else if (vars(dict[k], /\{(\w+)\}/g) !== vars(DICTIONARIES.en[k], /\{(\w+)\}/g)) errors.push(`desktop ${code}: placeholders differ in ${k}`);
  }
  for (const k of Object.keys(dict)) if (!(k in DICTIONARIES.en)) errors.push(`desktop ${code}: extra ${k}`);
}

// ── Apple catalogs ──
for (const s of appleCatalogStats(root)) {
  counts[`apple:${s.file}:untranslated`] = s.untranslated.length;
  details[`apple:${s.file}:untranslated`] = s.untranslated;
}

// ── Hard-coded UI English (heuristic) ──
function walk(dir, ext, skip) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (skip(path.relative(root, p))) return [];
    return e.isDirectory() ? walk(p, ext, skip) : p.endsWith(ext) ? [p] : [];
  });
}
// Hidden/debug surfaces stay English (user decision): diag, mocks, tests,
// Mac regression/benchmark harnesses and the Diagnostics feature.
const skipWeb = (p) => /\.test\.|\/mock\/|\/test\/|\/e2e\/|\/components\/diag\/|\/lib\/diag\//.test(p);
const skipSwift = (p) => /Tests?\.swift$|\/Diagnostics\/|Mac(AppDelegate\+|Automation|Bubble Test|BubbleTest|ChatMock|ChatScenario|ChatTestPages|MockData)|Regression|Benchmark/.test(p);
const english = /[A-Za-z]{2,}[^A-Za-z]*[A-Za-z]/; // at least a word-ish run
function countWeb(file) {
  const src = readFileSync(file, 'utf8').replace(/\{\/\*[\s\S]*?\*\/\}/g, '');
  const hits = [];
  for (const m of src.matchAll(/>([^<>{}`]*?[A-Za-z][^<>{}`]*?)</g)) {
    const text = m[1].trim();
    if (text && english.test(text) && !/^[\w.-]+$/.test(text) && !/=>|&&|\|\||;|\/\/|\bconst\b|\breturn\b/.test(text)) hits.push(text);
  }
  for (const m of src.matchAll(/\b(?:placeholder|title|aria-label|alt|label|footer|detail|body|confirm)=["']([^"']*[A-Za-z]{2}[^"']*)["']/g)) hits.push(m[1]);
  return hits;
}
const SWIFT_UI = /\b(?:Text|Button|Label|Toggle|Section|LabeledContent|Picker|Menu|TextField|SecureField|Link|NavigationLink|navigationTitle|alert|confirmationDialog|help|accessibilityLabel|accessibilityHint|String\(localized:?|LocalizedStringResource|LocalizedStringKey)\s*\(?\s*:?\s*$/;
function countSwift(file) {
  const hits = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (/^\s*(\/\/|\*|\/\*)|\b(log|logger|Logger|print|debugPrint|assert|precondition|fatalError|KrakiLog|os_log|NSLog)\b|#Preview|accessibilityIdentifier|UserDefaults|forKey|Notification\.Name|systemImage|named:/.test(line)) continue;
    for (const m of line.matchAll(/"((?:[^"\\]|\\.)*)"/g)) {
      const s = m[1];
      if (!/[A-Z][a-z]+[ ,.?!…'’][^"]*[a-z]/.test(s) || /^[a-z_.]+$/.test(s) || /^[^\p{L}\s]/u.test(s) || /\[[a-z]+\]|\w\.\w+\(|→/.test(s)) continue; // skip log-ish lines // sentence-like English only
      if (SWIFT_UI.test(line.slice(0, m.index))) continue; // auto-extracted by SwiftUI / already localized
      if (/\bcomment:\s*$/.test(line.slice(0, m.index))) continue; // translator note
      hits.push(s);
    }
  }
  return hits;
}
const webFiles = walk(path.join(root, 'packages/arm/web/src'), '.tsx', skipWeb);
const swiftFiles = walk(path.join(root, 'packages/arm/ios/Kraki'), '.swift', skipSwift).concat(walk(path.join(root, 'packages/arm/ios/KrakiNotification'), '.swift', skipSwift));
for (const [name, files, fn] of [['web:hardcoded', webFiles, countWeb], ['swift:hardcoded', swiftFiles, countSwift]]) {
  counts[name] = 0;
  details[name] = [];
  for (const f of files) {
    const hits = fn(f);
    counts[name] += hits.length;
    for (const h of hits) details[name].push(`${path.relative(root, f)}: ${h}`);
  }
}

// ── Report ──
let baseline = {};
try { baseline = JSON.parse(readFileSync(baselineFile, 'utf8')); } catch { /* first run */ }
for (const [k, n] of Object.entries(counts)) {
  const b = baseline[k];
  console.log(`${k.padEnd(48)} ${String(n).padStart(5)}${b === undefined ? '' : `  (baseline ${b})`}`);
  if (args.has('--strict') ? n > 0 : b !== undefined && n > b && !args.has('--update')) {
    errors.push(`${k}: ${n} > ${args.has('--strict') ? 0 : `baseline ${b}`}`);
  }
}
if (args.has('--verbose')) for (const [k, list] of Object.entries(details)) { console.log(`\n## ${k}`); for (const l of list) console.log(`  ${l}`); }
if (args.has('--update')) {
  writeFileSync(baselineFile, JSON.stringify(counts, null, 2) + '\n');
  console.log('baseline updated');
}
if (errors.length) {
  console.error(`\n${errors.length} localization error(s):\n  ${errors.join('\n  ')}`);
  process.exit(1);
}
console.log('l10n check ok');
