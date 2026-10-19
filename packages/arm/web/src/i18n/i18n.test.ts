import { afterEach, describe, expect, it } from 'vitest';
import { resources } from './resources';
import { LANGUAGES, matchLanguageTag, resolveSystemLanguage } from './languages';
import { i18next, setLanguagePreference, getLanguagePreference, t } from '.';
import { formatRelativeDays, formatRelativeTime } from './format';

type Tree = { [k: string]: string | Tree };
function flatten(tree: Tree, prefix = ''): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(tree)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (typeof v === 'string') out[key] = v;
    else Object.assign(out, flatten(v, key));
  }
  return out;
}
const placeholders = (s: string) => [...s.matchAll(/\{\{\s*([\w.]+)[^}]*\}\}/g)].map((m) => m[1]).sort();
// i18next plural suffixes differ by language (zh has only _other).
const baseKey = (k: string) => k.replace(/_(zero|one|two|few|many|other)$/, '');

describe('locale resources', () => {
  const en = flatten(resources.en as unknown as Tree);
  for (const { code } of LANGUAGES.filter((l) => l.code !== 'en')) {
    const other = flatten(resources[code] as unknown as Tree);
    it(`${code} covers every English key`, () => {
      const enBases = new Set(Object.keys(en).map(baseKey));
      const otherBases = new Set(Object.keys(other).map(baseKey));
      expect([...enBases].filter((k) => !otherBases.has(k))).toEqual([]);
      expect([...otherBases].filter((k) => !enBases.has(k))).toEqual([]);
    });
    it(`${code} keeps the English placeholders`, () => {
      const mismatched = Object.keys(other).filter((k) => {
        const enValue = en[k] ?? en[`${baseKey(k)}_other`];
        return enValue !== undefined && placeholders(enValue).join() !== placeholders(other[k]).join();
      });
      expect(mismatched).toEqual([]);
    });
    it(`${code} has no empty strings`, () => {
      expect(Object.entries(other).filter(([, v]) => !v.trim()).map(([k]) => k)).toEqual([]);
    });
  }
});

describe('language resolution', () => {
  it('maps Chinese tags', () => {
    expect(matchLanguageTag('zh-CN')).toBe('zh-Hans');
    expect(matchLanguageTag('zh-Hans-SG')).toBe('zh-Hans');
    expect(matchLanguageTag('zh')).toBe('zh-Hans');
    expect(matchLanguageTag('zh-TW')).toBeNull();
    expect(matchLanguageTag('zh-Hant-HK')).toBeNull();
  });
  it('walks the preference list and falls back to English', () => {
    expect(resolveSystemLanguage(['zh-TW', 'zh-CN', 'en'])).toBe('zh-Hans');
    expect(resolveSystemLanguage(['fr-FR', 'en-GB'])).toBe('en');
    expect(resolveSystemLanguage(['fr-FR'])).toBe('en');
    expect(resolveSystemLanguage([])).toBe('en');
  });
});

describe('preference switching', () => {
  afterEach(() => {
    setLanguagePreference('system');
    void i18next.changeLanguage('en');
  });
  it('switches live and persists only locally', () => {
    setLanguagePreference('zh-Hans');
    expect(getLanguagePreference()).toBe('zh-Hans');
    expect(t('common:action.cancel')).toBe('取消');
    expect(document.documentElement.lang).toBe('zh-Hans');
    setLanguagePreference('system');
    expect(getLanguagePreference()).toBe('system');
  });
});

describe('format', () => {
  afterEach(() => void i18next.changeLanguage('en'));
  const now = Date.UTC(2026, 0, 10, 12);
  it('keeps the existing English compact copy', () => {
    expect(formatRelativeTime(now - 10_000, now)).toBe('just now');
    expect(formatRelativeTime(now - 5 * 60_000, now)).toBe('5m ago');
    expect(formatRelativeTime(now - 3 * 3_600_000, now)).toBe('3h ago');
    expect(formatRelativeTime(now - 26 * 3_600_000, now)).toBe('1d ago');
    expect(formatRelativeDays(1)).toBe('yesterday');
  });
  it('formats Simplified Chinese', async () => {
    await i18next.changeLanguage('zh-Hans');
    expect(formatRelativeTime(now - 10_000, now)).toBe('刚刚');
    expect(formatRelativeTime(now - 5 * 60_000, now)).toBe('5分钟前');
    expect(formatRelativeDays(1)).toBe('昨天');
  });
});
