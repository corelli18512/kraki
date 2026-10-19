/**
 * Locale-aware formatting. Never hand-build "5m ago" / "3 items" strings —
 * use these (Intl) or i18next plurals (`t('key', { count })`).
 */
import { currentLanguage, t } from '.';

const cache = new Map<string, unknown>();
function cached<T>(key: string, make: () => T): T {
  let v = cache.get(key) as T | undefined;
  if (!v) {
    v = make();
    cache.set(key, v);
  }
  return v;
}

export function relativeTimeFormatter(style: Intl.RelativeTimeFormatStyle = 'narrow', numeric: 'auto' | 'always' = 'always') {
  const lang = currentLanguage();
  return cached(`rtf:${lang}:${style}:${numeric}`, () => new Intl.RelativeTimeFormat(lang, { numeric, style }));
}

/**
 * "just now" / "5m ago" / "3h ago" / "2d ago" (en) — "刚刚" / "5分钟前" … (zh).
 * `nowMs` is injectable for tests.
 */
export function formatRelativeTime(date: Date | string | number, nowMs = Date.now(), style: Intl.RelativeTimeFormatStyle = 'narrow'): string {
  const ms = nowMs - new Date(date).getTime();
  const seconds = Math.floor(ms / 1000);
  const rtf = relativeTimeFormatter(style);
  if (seconds < 60) return t('common:time.justNow');
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return rtf.format(-minutes, 'minute');
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return rtf.format(-hours, 'hour');
  return rtf.format(-Math.floor(hours / 24), 'day');
}

/** Days relative to today: "yesterday" / "3 days ago" with numeric:auto. */
export function formatRelativeDays(days: number, style: Intl.RelativeTimeFormatStyle = 'narrow'): string {
  return relativeTimeFormatter(style, 'auto').format(-days, 'day');
}

export function formatDateTime(date: Date | string | number, options: Intl.DateTimeFormatOptions): string {
  const lang = currentLanguage();
  const key = `dtf:${lang}:${JSON.stringify(options)}`;
  return cached(key, () => new Intl.DateTimeFormat(lang, options)).format(new Date(date));
}

export function formatNumber(value: number, options: Intl.NumberFormatOptions = {}): string {
  const lang = currentLanguage();
  const key = `nf:${lang}:${JSON.stringify(options)}`;
  return cached(key, () => new Intl.NumberFormat(lang, options)).format(value);
}

/** Locale-aware list join: "a, b, and c" / "a、b和c". */
export function formatList(items: string[], type: Intl.ListFormatType = 'conjunction'): string {
  const lang = currentLanguage();
  return cached(`lf:${lang}:${type}`, () => new Intl.ListFormat(lang, { type })).format(items);
}
