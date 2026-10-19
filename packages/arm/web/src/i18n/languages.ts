/**
 * Supported UI languages for the Web client (and the Windows shell, which
 * renders it). To add a language:
 *   1. add an entry here,
 *   2. add `locales/<code>/` with the same namespaces as `locales/en/`,
 *   3. register it in `resources.ts`.
 * `pnpm l10n:check` fails if a locale is missing keys or placeholders.
 */
export const LANGUAGES = [
  { code: 'en', nativeName: 'English' },
  { code: 'zh-Hans', nativeName: '简体中文' },
] as const;

export type LanguageCode = (typeof LANGUAGES)[number]['code'];
/** What the user picked: follow the OS/browser, or a fixed language. */
export type LanguagePreference = 'system' | LanguageCode;

export const DEFAULT_LANGUAGE: LanguageCode = 'en';

export function isLanguageCode(value: unknown): value is LanguageCode {
  return LANGUAGES.some((l) => l.code === value);
}

/**
 * Map one BCP 47 tag (navigator.languages entry) to a supported language, or
 * null. Chinese: Simplified scripts/regions → zh-Hans; Traditional (Hant, TW,
 * HK, MO) is NOT folded into zh-Hans — we keep walking the user's list, like
 * Apple's per-app resolution does.
 */
export function matchLanguageTag(tag: string): LanguageCode | null {
  const lower = tag.toLowerCase();
  const [lang, ...rest] = lower.split(/[-_]/);
  if (lang === 'zh') {
    if (rest.includes('hant') || rest.some((p) => p === 'tw' || p === 'hk' || p === 'mo')) return null;
    return 'zh-Hans';
  }
  const exact = LANGUAGES.find((l) => l.code.toLowerCase() === lower);
  if (exact) return exact.code;
  const base = LANGUAGES.find((l) => l.code.toLowerCase().split('-')[0] === lang);
  return base?.code ?? null;
}

export function resolveSystemLanguage(tags: readonly string[]): LanguageCode {
  for (const tag of tags) {
    const match = matchLanguageTag(tag);
    if (match) return match;
  }
  return DEFAULT_LANGUAGE;
}
